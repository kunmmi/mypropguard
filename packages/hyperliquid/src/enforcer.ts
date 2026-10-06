import { Decimal } from "decimal.js";
import type { VenueEnforcer } from "@mypropguard/domain";
import { buildCancelAction } from "./cancelAction.js";
import {
  HYPERLIQUID_MAINNET_EXCHANGE_URL,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidExchangeClient,
  type HyperliquidExchangeClientOptions,
} from "./exchangeClient.js";
import { HYPERLIQUID_MAINNET_INFO_URL, HYPERLIQUID_TESTNET_INFO_URL } from "./infoClient.js";
import { buildOrderAction } from "./orderAction.js";
import type { PrivyClient } from "./privyClient.js";
import { buildAgentTypedData, createL1ActionHash } from "./signing.js";

export interface HyperliquidEnforcerOptions {
  privyClient: PrivyClient;
  /** The Privy wallet id of THIS account's agent wallet. */
  walletId: string;
  isTestnet: boolean;
  /** How far past the mid price a closing order is priced so it fills at once, in basis points. Default 500 (5%). */
  slippageBps?: number;
  exchangeClientOptions?: HyperliquidExchangeClientOptions;
  infoUrl?: string;
  fetchImpl?: typeof fetch;
}

interface AssetMeta {
  index: number;
  szDecimals: number;
}

const META_TTL_MS = 10 * 60 * 1000;
/** Hyperliquid perps allow at most 6 decimals in a price, less the asset's size decimals, and at most 5 significant figures. */
const PERP_MAX_PRICE_DECIMALS = 6;
const MAX_SIGNIFICANT_FIGURES = 5;

/** Rounds a size DOWN to the asset's size decimals (never closes more than asked). Null if nothing is left. */
export function formatCloseSize(size: Decimal, szDecimals: number): string | null {
  const rounded = size.toDecimalPlaces(szDecimals, Decimal.ROUND_DOWN);
  return rounded.gt(0) ? rounded.toFixed() : null;
}

/**
 * Prices a closing order `slippageBps` past the mid so it crosses the book (Hyperliquid has no market order; an
 * immediate-or-cancel limit order at an aggressive price is the market order). Rounded in the aggressive
 * direction to Hyperliquid's price precision so rounding can never make the order less likely to fill.
 */
export function formatCloseTargetPrice(mid: Decimal, isBuy: boolean, slippageBps: number, szDecimals: number): string {
  const factor = new Decimal(1).plus(new Decimal(slippageBps).div(10_000).times(isBuy ? 1 : -1));
  const raw = mid.times(factor);
  const rounding = isBuy ? Decimal.ROUND_UP : Decimal.ROUND_DOWN;
  const sig = raw.toSignificantDigits(MAX_SIGNIFICANT_FIGURES, rounding);
  const maxDecimals = Math.max(0, PERP_MAX_PRICE_DECIMALS - szDecimals);
  return sig.toDecimalPlaces(maxDecimals, rounding).toFixed();
}

/**
 * The only way MyPropGuard acts on a trader's Hyperliquid account: cancel an order, or place a reduce-only
 * immediate-or-cancel order that can only shrink a position. Signed by the account's own agent wallet, which
 * Hyperliquid itself restricts to trading (it can never withdraw). Reduce-only means that even a mistaken or
 * repeated instruction cannot open or flip a position.
 */
export class HyperliquidEnforcer implements VenueEnforcer {
  private readonly infoUrl: string;
  private readonly exchangeClientOptions: HyperliquidExchangeClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly slippageBps: number;
  private metaCache: { at: number; byCoin: Map<string, AssetMeta> } | null = null;

  constructor(private readonly options: HyperliquidEnforcerOptions) {
    this.infoUrl = options.infoUrl ?? (options.isTestnet ? HYPERLIQUID_TESTNET_INFO_URL : HYPERLIQUID_MAINNET_INFO_URL);
    this.exchangeClientOptions = {
      baseUrl: options.isTestnet ? HYPERLIQUID_TESTNET_EXCHANGE_URL : HYPERLIQUID_MAINNET_EXCHANGE_URL,
      ...options.exchangeClientOptions,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.slippageBps = options.slippageBps ?? 500;
  }

  async cancelOrder(coin: string, oid: number): Promise<void> {
    const meta = await this.assetMeta(coin);
    await this.signAndSubmit(buildCancelAction({ assetIndex: meta.index, oid }));
  }

  async reduceOnlyClose(input: { coin: string; isBuy: boolean; size: Decimal }): Promise<{ detail: string }> {
    const meta = await this.assetMeta(input.coin);
    const size = formatCloseSize(input.size, meta.szDecimals);
    if (size === null) return { detail: `size ${input.size.toString()} rounds to zero for ${input.coin}; nothing to close` };

    const mid = await this.midPrice(input.coin);
    const price = formatCloseTargetPrice(mid, input.isBuy, this.slippageBps, meta.szDecimals);
    const action = buildOrderAction({ assetIndex: meta.index, isBuy: input.isBuy, price, size, reduceOnly: true, tif: "Ioc" });
    const response = await this.signAndSubmit(action);
    return { detail: `${input.isBuy ? "buy" : "sell"} ${size} ${input.coin} reduce-only IOC at ${price}: ${JSON.stringify(response).slice(0, 300)}` };
  }

  private async signAndSubmit(action: Record<string, unknown>): Promise<unknown> {
    const nonce = Date.now();
    const connectionId = createL1ActionHash({ action, nonce });
    const typedData = buildAgentTypedData(connectionId, this.options.isTestnet);
    const signature = await this.options.privyClient.signTypedData(this.options.walletId, typedData);
    return new HyperliquidExchangeClient(this.exchangeClientOptions).submitAction({ action, nonce, signature });
  }

  private async assetMeta(coin: string): Promise<AssetMeta> {
    if (!this.metaCache || Date.now() - this.metaCache.at > META_TTL_MS) {
      const raw = (await this.info({ type: "meta" })) as { universe: Array<{ name: string; szDecimals: number }> };
      const byCoin = new Map<string, AssetMeta>();
      raw.universe.forEach((asset, index) => byCoin.set(asset.name, { index, szDecimals: asset.szDecimals }));
      this.metaCache = { at: Date.now(), byCoin };
    }
    const meta = this.metaCache.byCoin.get(coin);
    if (!meta) throw new Error(`Unknown Hyperliquid asset: ${coin}`);
    return meta;
  }

  private async midPrice(coin: string): Promise<Decimal> {
    const mids = (await this.info({ type: "allMids" })) as Record<string, string>;
    const mid = mids[coin];
    if (!mid) throw new Error(`No mid price for ${coin}`);
    return new Decimal(mid);
  }

  private async info(body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(this.infoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Hyperliquid info request failed: ${response.status} ${await response.text()}`);
    return response.json();
  }
}
