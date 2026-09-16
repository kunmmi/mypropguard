import { Decimal } from "decimal.js";
import type { ClearinghouseState, VenuePosition, VenueStateReader } from "@mypropguard/domain";

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
  };
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
}
