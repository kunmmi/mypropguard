import { Decimal } from "decimal.js";
import type { ClearinghouseState, VenueCapitalFlow, VenueOpenOrder, VenuePosition, VenueStateReader } from "@mypropguard/domain";

export const HYPERLIQUID_MAINNET_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HYPERLIQUID_TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info";

export interface HyperliquidInfoClientOptions {
  /** Defaults to mainnet. Public read-only endpoint — no API key involved either way. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Raw shape of Hyperliquid's `clearinghouseState` info response, per
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
 * Only the fields this client actually reads are declared.
 */
interface RawClearinghouseState {
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string };
  withdrawable: string;
  time?: number;
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      positionValue: string;
      leverage: { value: number };
    };
  }>;
}

export function mapClearinghouseState(raw: RawClearinghouseState): ClearinghouseState {
  const positions: VenuePosition[] = raw.assetPositions.map((entry) => ({
    coin: entry.position.coin,
    size: new Decimal(entry.position.szi),
    positionValue: new Decimal(entry.position.positionValue),
    leverage: new Decimal(entry.position.leverage.value),
  }));

  return {
    accountValue: new Decimal(raw.marginSummary.accountValue),
    totalMarginUsed: new Decimal(raw.marginSummary.totalMarginUsed),
    totalNotionalPosition: new Decimal(raw.marginSummary.totalNtlPos),
    withdrawable: new Decimal(raw.withdrawable),
    positions,
    time: raw.time,
  };
}

/** One entry of Hyperliquid's `frontendOpenOrders`. Side is "B" for a buy (bid) and "A" for a sell (ask). */
export interface RawOpenOrder {
  coin: string;
  side: string;
  sz: string;
  oid: number;
  reduceOnly?: boolean;
}

export function mapOpenOrder(raw: RawOpenOrder): VenueOpenOrder {
  return { coin: raw.coin, oid: raw.oid, isBuy: raw.side === "B", size: new Decimal(raw.sz), reduceOnly: raw.reduceOnly === true };
}

/** One entry of Hyperliquid's `userNonFundingLedgerUpdates`, as returned (only fields we read are declared). */
export interface RawLedgerUpdate {
  time: number;
  hash: string;
  delta: {
    type: string;
    usdc?: string;
    fee?: string;
    toPerp?: boolean;
    user?: string;
    destination?: string;
    sourceDex?: string;
    destinationDex?: string;
    token?: string;
    amount?: string;
    usdcValue?: string;
    netWithdrawnUsd?: string;
  };
}

/**
 * Turns one ledger entry into the USD that moved into (+) or out of (-) the account's PERPS balance
 * - the balance `accountValue` measures - or null when the entry is not a movement of capital (trading
 * profit and loss, funding, liquidations, spot-only activity, staking rewards).
 *
 * Handles the entry types seen on the live ledger: deposit, withdraw (the fee leaves with it),
 * accountClassTransfer (spot <-> perps, by `toPerp`), internalTransfer and subAccountTransfer (direction
 * by whether this address is the sender), send (USDC between spot and perps and other accounts, by
 * source/destination dex), and vault deposits/withdrawals. Any type not listed is ignored, so an unknown
 * future entry can never invent a flow.
 */
export function mapLedgerUpdate(update: RawLedgerUpdate, address: string): VenueCapitalFlow | null {
  const me = address.toLowerCase();
  const d = update.delta;
  const num = (value: string | undefined): Decimal => new Decimal(value ?? "0");
  const isMe = (other: string | undefined): boolean => other?.toLowerCase() === me;
  let amount: Decimal | null = null;

  switch (d.type) {
    case "deposit":
      amount = num(d.usdc);
      break;
    case "withdraw":
      amount = num(d.usdc).plus(num(d.fee)).neg();
      break;
    case "accountClassTransfer":
      amount = d.toPerp ? num(d.usdc) : num(d.usdc).neg();
      break;
    case "internalTransfer":
    case "subAccountTransfer": {
      const sent = isMe(d.user);
      const received = isMe(d.destination);
      if (sent && received) return null;
      if (sent) amount = num(d.usdc).plus(d.type === "internalTransfer" ? num(d.fee) : 0).neg();
      else if (received) amount = num(d.usdc);
      break;
    }
    case "send": {
      if (d.token !== "USDC") return null;
      const value = num(d.usdcValue ?? d.amount);
      const fromPerps = d.sourceDex === "" && isMe(d.user);
      const toPerps = d.destinationDex === "" && isMe(d.destination);
      if (fromPerps && toPerps) return null;
      if (fromPerps) amount = value.plus(num(d.fee)).neg();
      else if (toPerps) amount = value;
      break;
    }
    case "vaultDeposit":
      amount = num(d.usdc).neg();
      break;
    case "vaultWithdraw":
      amount = num(d.netWithdrawnUsd);
      break;
    default:
      return null;
  }

  if (amount === null || amount.isZero()) return null;
  return { id: update.hash, timeMs: update.time, amountUsd: amount };
}

/**
 * Read-only Hyperliquid Info API client (Phase 2). No signing, no order
 * placement — `clearinghouseState` is a public read for any address, so
 * this needs no credentials and can never move funds.
 */
export class HyperliquidInfoClient implements VenueStateReader {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HyperliquidInfoClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? HYPERLIQUID_MAINNET_INFO_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getClearinghouseState(address: string): Promise<ClearinghouseState> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    });

    if (!response.ok) {
      throw new Error(`Hyperliquid info request failed: ${response.status} ${await response.text()}`);
    }

    const raw = (await response.json()) as RawClearinghouseState;
    return mapClearinghouseState(raw);
  }

  /** Deposits, withdrawals and transfers after `afterMs` (exclusive), oldest first. Pages through the ledger. */
  async getCapitalFlows(address: string, afterMs: number): Promise<readonly VenueCapitalFlow[]> {
    const flows: VenueCapitalFlow[] = [];
    let startTime = afterMs + 1;
    for (let page = 0; page < 50; page++) {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "userNonFundingLedgerUpdates", user: address, startTime }),
      });
      if (!response.ok) {
        throw new Error(`Hyperliquid ledger request failed: ${response.status} ${await response.text()}`);
      }
      const updates = (await response.json()) as RawLedgerUpdate[];
      for (const update of updates) {
        const flow = mapLedgerUpdate(update, address);
        if (flow) flows.push(flow);
      }
      if (updates.length < 2000) break; // the API returns at most 2000 entries per call
      startTime = updates[updates.length - 1]!.time + 1;
    }
    return flows;
  }

  /** Resting orders on the account, including trigger orders (stops and take-profits). */
  async getOpenOrders(address: string): Promise<readonly VenueOpenOrder[]> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "frontendOpenOrders", user: address }),
    });
    if (!response.ok) {
      throw new Error(`Hyperliquid open-orders request failed: ${response.status} ${await response.text()}`);
    }
    return ((await response.json()) as RawOpenOrder[]).map(mapOpenOrder);
  }
}
