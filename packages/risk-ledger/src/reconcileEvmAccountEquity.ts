import { Decimal } from "decimal.js";
import {
  RuleType,
  StateConfidence,
  type AccountRiskHead,
  type EvmFlowState,
  type EvmGuardRuleSyncer,
  type EvmSafeEquityReader,
  type EvmSafeSnapshot,
  type EvmSafeStateReader,
  type EvmTokenDiscovery,
  type RiskLedgerStore,
} from "@mypropguard/domain";
import { checkAndEnforceDailyLossFreeze } from "./checkAndEnforceDailyLossFreeze.js";

export class EvmAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} is not an EVM Safe account, or has no EVM equity reader configured for its chain.`);
    this.name = "EvmAccountNotFoundError";
  }
}

export interface ReconcileEvmExtras {
  /** Reads balances, the transaction count and the Guard's withdrawal totals, keyed by chain id. */
  stateReaders?: Record<number, EvmSafeStateReader>;
  /** Finds the tokens a Safe holds, keyed by chain id. */
  tokenDiscoveries?: Record<number, EvmTokenDiscovery>;
  /** Overrides "now" - only for tests that need to cross a UTC day boundary. */
  now?: Date;
}

interface DetectedFlow {
  asset: string;
  amountRaw: bigint;
  direction: "in" | "out";
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function union(...lists: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(lists.flat().map((t) => t.toLowerCase()))];
}

/**
 * Compares this snapshot with the last reconcile's to find the owner's deposits and withdrawals.
 *
 * - Withdrawals: the Guard keeps a running total of everything the Safe sent out by plain send or
 *   ERC-20 transfer, so any increase since last time is an exact withdrawal.
 * - Deposits: money can only arrive in a Safe without the Safe doing anything, so if the Safe's
 *   transaction count has not moved since last time, any balance increase is a deposit. If it has
 *   moved, an increase could be trade proceeds, so it is left alone (a deposit landing in the
 *   same few minutes as a trade is counted as trading - the rare, accepted error).
 * An asset seen for the first time has no earlier reading, so it produces no flow.
 */
function detectFlows(prev: EvmFlowState | null, snapshot: EvmSafeSnapshot | undefined): DetectedFlow[] {
  if (!prev || !snapshot) return [];
  const flows: DetectedFlow[] = [];

  for (const [asset, total] of Object.entries(snapshot.withdrawn)) {
    const before = prev.lastWithdrawn[asset];
    if (before === undefined) continue;
    const delta = total - BigInt(before);
    if (delta > 0n) flows.push({ asset, amountRaw: delta, direction: "out" });
  }

  if (snapshot.nonce === prev.lastNonce) {
    for (const [asset, balance] of Object.entries(snapshot.balances)) {
      const before = prev.lastBalances[asset];
      if (before === undefined) continue;
      const increase = balance - BigInt(before);
      if (increase > 0n) flows.push({ asset, amountRaw: increase, direction: "in" });
    }
  }
  return flows;
}

const stringify = (record: Record<string, bigint>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.toString()]));

/**
 * The EVM-chain equivalent of reconcileAccountFromVenue: reads an EVM Safe's live on-chain USD
 * equity and folds it into `account_risk_heads`, then re-checks the max-daily-loss freeze.
 *
 * Turning raw balances into a daily profit/loss number takes three things, all done here:
 *
 * 1. Value everything the Safe holds. Tokens are found by token discovery whenever the Safe has run a
 *    transaction since the last reconcile, so a token bought on any exchange is counted whether or
 *    not it has a rule. Without this a buy would look like a loss: the BNB is gone and the token it
 *    became is invisible.
 * 2. Take capital flows out (see detectFlows). Each is valued when first observed and accumulated in
 *    `cumulativeFlowUsd`; `currentEquity` is stored net of it, so equity moves only when trading, or
 *    prices, move it.
 * 3. Roll the day. `equityStartOfDay` is anchored to the first reconcile of each UTC day (and to the
 *    very first reconcile ever, replacing whatever "starting equity" was typed at creation).
 *
 * Balances, prices and the Guard's totals are all read at one settled block, so a withdrawal between
 * two reads can never look like a loss. If any chain or discovery read fails the whole reconcile
 * fails and nothing is written: it never freezes an account on a half-read.
 *
 * Without a state reader (not configured) it still rolls the day over but cannot see flows or
 * discover tokens, so deposits and withdrawals are not netted out - a degraded mode, not the design.
 */
export async function reconcileEvmAccountEquity(
  store: RiskLedgerStore,
  equityReaders: Record<number, EvmSafeEquityReader> | undefined,
  evmGuardSyncers: Record<number, EvmGuardRuleSyncer> | undefined,
  accountId: string,
  extras: ReconcileEvmExtras = {},
): Promise<AccountRiskHead> {
  const account = await store.findAccountById(accountId);
  if (!account?.evmSafeAddress || account.evmChainId == null) {
    throw new EvmAccountNotFoundError(accountId);
  }

  const reader = equityReaders?.[account.evmChainId];
  if (!reader) {
    throw new EvmAccountNotFoundError(accountId);
  }
  const stateReader = extras.stateReaders?.[account.evmChainId];
  const discovery = extras.tokenDiscoveries?.[account.evmChainId];

  const safeAddress = account.evmSafeAddress;
  const now = extras.now ?? new Date();
  const today = utcDay(now);

  const updatedHead = await store.runExclusive(accountId, async (ctx) => {
    const [head, rules] = await Promise.all([ctx.getAccountRiskHead(accountId), ctx.getActiveRules(accountId)]);
    const previous: EvmFlowState | null = head.evmFlowState ?? null;

    const ruleTokens = rules
      .filter((r) => r.ruleType === RuleType.MAX_POSITION_SIZE && r.tokenAddress)
      .map((r) => r.tokenAddress as string);
    let knownTokens = previous?.knownTokens ?? [];

    let snapshot: EvmSafeSnapshot | undefined;
    let readBlock: number | undefined;
    if (stateReader) {
      readBlock = await stateReader.getSettledBlock();
      snapshot = await stateReader.getSnapshot({ safeAddress, extraAssets: union(ruleTokens, knownTokens), blockNumber: readBlock });

      if (discovery && (!previous || snapshot.nonce !== previous.lastNonce)) {
        const merged = union(knownTokens, await discovery.discoverTokens(safeAddress));
        if (merged.length !== knownTokens.length) {
          knownTokens = merged;
          snapshot = await stateReader.getSnapshot({ safeAddress, extraAssets: union(ruleTokens, knownTokens), blockNumber: readBlock });
        }
      }
    }

    const equityUsd = await reader.getEquityUsd({ safeAddress, trackedTokens: union(ruleTokens, knownTokens), blockNumber: readBlock });

    let cumulativeFlowUsd = previous?.cumulativeFlowUsd ?? new Decimal(0);
    for (const flow of detectFlows(previous, snapshot)) {
      const usd = await reader.getTokenValueUsd(flow.asset, flow.amountRaw, readBlock);
      cumulativeFlowUsd = flow.direction === "in" ? cumulativeFlowUsd.plus(usd) : cumulativeFlowUsd.minus(usd);
    }

    const adjustedEquity = equityUsd.minus(cumulativeFlowUsd);
    const isFirstReconcile = previous === null;
    const isNewDay = isFirstReconcile || previous.day !== today;

    const nextState: EvmFlowState = {
      day: today,
      cursorBlock: readBlock ?? previous?.cursorBlock ?? 0,
      cumulativeFlowUsd,
      knownTokens,
      lastNonce: snapshot?.nonce ?? previous?.lastNonce ?? 0,
      lastBalances: snapshot ? stringify(snapshot.balances) : (previous?.lastBalances ?? {}),
      lastWithdrawn: snapshot ? stringify(snapshot.withdrawn) : (previous?.lastWithdrawn ?? {}),
    };

    const updated: AccountRiskHead = {
      ...head,
      currentEquity: adjustedEquity,
      // The creation-time "starting equity" is whatever the user typed, so the first reconcile
      // replaces the peak as well as the day baseline with the real number.
      peakEquity: isFirstReconcile ? adjustedEquity : Decimal.max(head.peakEquity, adjustedEquity),
      equityStartOfDay: isNewDay ? adjustedEquity : head.equityStartOfDay,
      realizedPnlToday: isNewDay ? new Decimal(0) : head.realizedPnlToday,
      evmFlowState: nextState,
    };
    await ctx.updateAccountRiskHead(updated);
    await ctx.recordStateCheckpoint({ accountId, confidence: StateConfidence.VERIFIED, verifiedAt: now });
    return updated;
  });

  await checkAndEnforceDailyLossFreeze(store, accountId, evmGuardSyncers);

  return updatedHead;
}
