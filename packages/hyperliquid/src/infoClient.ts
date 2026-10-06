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
export type LedgerMode = "unified" | "standard";

export function mapLedgerUpdate(update: RawLedgerUpdate, address: string, mode: LedgerMode = "standard"): VenueCapitalFlow | null {
  const me = address.toLowerCase();
  const d = update.delta;
  const num = (value: string | undefined): Decimal => new Decimal(value ?? "0");
  const isMe = (other: string | undefined): boolean => other?.toLowerCase() === me;
  let amount: Decimal | null = null;

  if (mode === "unified") {
    // One combined balance: moving money between spot and perps changes nothing, and any send is judged only by
    // whether the other party is someone else.
    if (d.type === "accountClassTransfer") return null;
    if (d.type === "send" || d.type === "spotTransfer") {
      const sent = isMe(d.user);
      const received = isMe(d.destination);
      if (sent === received) return null; // a transfer to oneself, or one this address is not part of
      const value = num(d.usdcValue ?? (d.token === "USDC" ? d.amount : undefined));
      if (value.isZero()) return null;
      amount = sent ? value.plus(num(d.fee)).neg() : value;
      return { id: update.hash, timeMs: update.time, amountUsd: amount };
    }
  }

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
  private readonly modeCache = new Map<string, { mode: LedgerMode; at: number }>();

  constructor(options: HyperliquidInfoClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? HYPERLIQUID_MAINNET_INFO_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getClearinghouseState(address: string): Promise<ClearinghouseState> {
    const raw = await this.info<RawClearinghouseState>({ type: "clearinghouseState", user: address });
    const state = mapClearinghouseState(raw);

    const mode = await this.getAccountMode(address);
    if (mode === "standard") return { ...state, accountMode: mode };

    // A unified account keeps one balance: the perps view reads 0 for it, and Hyperliquid itself says the perps
    // state is "not meaningful". Its own portfolio equity (the figure its website shows, live to the second)
    // is the account value.
    const equity = await this.getPortfolioValue(address);
    return { ...state, accountValue: equity ?? state.accountValue, accountMode: mode };
  }

  /**
   * "unified" when spot and perps are one balance (unified account and portfolio margin), else "standard".
   * Cached for ten minutes: the mode is a rarely changed account setting.
   */
  async getAccountMode(address: string): Promise<LedgerMode> {
    const key = address.toLowerCase();
    const cached = this.modeCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.mode;
    const abstraction = await this.info<unknown>({ type: "userAbstraction", user: address });
    const mode: LedgerMode = abstraction === "unifiedAccount" || abstraction === "portfolioMargin" ? "unified" : "standard";
    this.modeCache.set(key, { mode, at: Date.now() });
    return mode;
  }

  /** The agent wallets currently approved to trade for `address` (lowercase addresses), skipping expired approvals. */
  async getApprovedAgents(address: string): Promise<string[]> {
    const agents = await this.info<Array<{ address: string; validUntil?: number }>>({ type: "extraAgents", user: address });
    if (!Array.isArray(agents)) return [];
    return agents.filter((a) => !a.validUntil || a.validUntil > Date.now()).map((a) => a.address.toLowerCase());
  }

  /** The latest point of Hyperliquid's own account-value history (all balances combined), or null if it has none. */
  private async getPortfolioValue(address: string): Promise<Decimal | null> {
    const portfolio = await this.info<Array<[string, { accountValueHistory?: Array<[number, string]> }]>>({ type: "portfolio", user: address });
    const day = Array.isArray(portfolio) ? portfolio.find((frame) => frame[0] === "day") : undefined;
    const history = day?.[1]?.accountValueHistory;
    const last = history && history.length > 0 ? history[history.length - 1] : undefined;
    return last ? new Decimal(last[1]) : null;
  }

  private async info<T>(body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Hyperliquid info request failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /** Deposits, withdrawals and transfers after `afterMs` (exclusive), oldest first. Pages through the ledger. */
  async getCapitalFlows(address: string, afterMs: number): Promise<readonly VenueCapitalFlow[]> {
    const mode = await this.getAccountMode(address);
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
        const flow = mapLedgerUpdate(update, address, mode);
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
