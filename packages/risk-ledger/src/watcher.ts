import { Decimal } from "decimal.js";
import {
  RuleType,
  type AccountRiskHead,
  type EnforcementState,
  type ProtectedAccount,
  type RiskLedgerStore,
  type RuleVersion,
  type VenueEnforcer,
  type VenueStateReader,
} from "@mypropguard/domain";
import {
  decideEnforcement,
  type EnforcementActionPlan,
  type EnforcementDecision,
  type WatchEquity,
  type WatchSnapshot,
} from "@mypropguard/risk-engine";
import { reconcileAccountFromVenue } from "./reconcileAccount.js";

export type WatcherMode = "log" | "enforce";

/** Rules the watcher can enforce. The rest (trade frequency, cooldown) need fill history and are not watched yet. */
const WATCHED_RULE_TYPES: ReadonlySet<RuleType> = new Set([
  RuleType.MAX_DAILY_LOSS,
  RuleType.MAX_DRAWDOWN,
  RuleType.MAX_LEVERAGE,
  RuleType.MAX_POSITION_SIZE,
  RuleType.MAX_EXPOSURE,
]);

/** Rules whose breach depends on equity, which deposits/withdrawals can distort, so they are confirmed against fresh flows first. */
const EQUITY_RULE_TYPES: ReadonlySet<string> = new Set([RuleType.MAX_DAILY_LOSS, RuleType.MAX_DRAWDOWN, RuleType.MAX_LEVERAGE]);

/** Remembers what was last recorded per account so an unchanged plan is not logged every few seconds. */
export class WatcherMemory {
  private readonly lastSignature = new Map<string, { signature: string; atMs: number }>();

  shouldRecord(accountId: string, signature: string, nowMs: number, throttleMs: number): boolean {
    const last = this.lastSignature.get(accountId + signature);
    if (last && nowMs - last.atMs < throttleMs) return false;
    this.lastSignature.set(accountId + signature, { signature, atMs: nowMs });
    return true;
  }
}

export interface WatcherDeps {
  store: RiskLedgerStore;
  venueReader: VenueStateReader;
  /**
   * The executor for one account: an agent wallet that Hyperliquid has actually approved for it. Undefined when
   * there is none. May look it up on the venue.
   */
  enforcerFor: (account: ProtectedAccount) => Promise<VenueEnforcer | undefined> | VenueEnforcer | undefined;
  mode: WatcherMode;
  /** Re-reads the ledger (flows) and re-anchors equity at least this often. Default 60 seconds. */
  reconcileEveryMs?: number;
  /** A "last compliant" reading older than this no longer counts as "just before the breaching trade". Default 30 seconds. */
  staleAfterMs?: number;
  /** Most orders sent for one account in one cycle. Default 10. */
  maxActionsPerCycle?: number;
  /** Do not log an unchanged plan more often than this. Default 60 seconds. */
  logThrottleMs?: number;
  memory?: WatcherMemory;
  now?: () => Date;
}

export interface WatcherCycleResult {
  accountId: string;
  skipped?: string;
  locked: boolean;
  newLock?: { rule: string; detail: string };
  unlocked?: boolean;
  planned: number;
  executed: number;
  failed: number;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function equityOf(head: AccountRiskHead, accountValue: Decimal): WatchEquity {
  const cumulative = head.venueFlowState?.cumulativeFlowUsd ?? new Decimal(0);
  const current = accountValue.minus(cumulative);
  return { startOfDay: head.equityStartOfDay, current, peak: Decimal.max(head.peakEquity, current) };
}

function describePlan(plan: EnforcementActionPlan): string {
  return plan.kind === "CANCEL"
    ? `cancel ${plan.coin} #${plan.oid}`
    : `${plan.isBuy ? "buy" : "sell"} ${plan.size.toString()} ${plan.coin} reduce-only`;
}

/**
 * One look at one Hyperliquid account.
 *
 * It reads the account, decides what the rules call for (see decideEnforcement), saves the lock state, and then
 * either records what it would do (log mode) or does it (enforce mode) through the account's own agent wallet.
 *
 * It never locks on an unconfirmed number: a lock based on equity is only created after the account's ledger of
 * deposits and withdrawals has been re-read, so a withdrawal cannot be mistaken for a loss. A failed read throws
 * and changes nothing, so the next cycle simply tries again.
 */
export async function runWatcherCycle(deps: WatcherDeps, accountId: string): Promise<WatcherCycleResult> {
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const today = utcDay(now);
  const reconcileEveryMs = deps.reconcileEveryMs ?? 60_000;
  const staleAfterMs = deps.staleAfterMs ?? 30_000;
  const maxActions = deps.maxActionsPerCycle ?? 10;
  const throttleMs = deps.logThrottleMs ?? 60_000;
  const memory = deps.memory ?? new WatcherMemory();
  const result = (partial: Partial<WatcherCycleResult>): WatcherCycleResult => ({
    accountId,
    locked: false,
    planned: 0,
    executed: 0,
    failed: 0,
    ...partial,
  });

  const account = await deps.store.findAccountById(accountId);
  if (!account || !account.venueAddress) return result({ skipped: "no Hyperliquid address saved for this account" });
  const address = account.venueAddress;

  const { head: initialHead, rules } = await deps.store.runExclusive(accountId, async (ctx) => ({
    head: await ctx.getAccountRiskHead(accountId),
    rules: (await ctx.getActiveRules(accountId)) as readonly RuleVersion[],
  }));
  const watchedRules = rules.filter((r) => WATCHED_RULE_TYPES.has(r.ruleType));
  if (watchedRules.length === 0) return result({ skipped: "no watched rules on this account" });

  let head = initialHead;
  let reconciled = false;
  const reconcile = async () => {
    head = (await reconcileAccountFromVenue(deps.store, deps.venueReader, { accountId, venueAddress: address }, { now })).head;
    reconciled = true;
  };

  const flow = head.venueFlowState;
  if (!flow || flow.day !== today || nowMs - flow.cursorMs >= reconcileEveryMs) await reconcile();

  // The lock state as this check read it. It is saved back only if nobody changed it meanwhile (see below).
  let stateRead = head.enforcement ?? null;

  const state = await deps.venueReader.getClearinghouseState(address);
  const positions = state.positions
    .filter((p) => !p.size.isZero())
    .map((p) => ({ coin: p.coin, size: p.size, notional: p.positionValue.abs() }));

  const alreadyLocked = head.enforcement?.lockedDay === today;
  let openOrders = alreadyLocked && deps.venueReader.getOpenOrders ? await deps.venueReader.getOpenOrders(address) : [];

  const snapshot = (): WatchSnapshot => ({ positions, openOrders, totalNotional: state.totalNotionalPosition });
  const decide = (): EnforcementDecision =>
    decideEnforcement({
      nowMs,
      today,
      rules: watchedRules,
      state: head.enforcement ?? null,
      snapshot: snapshot(),
      equity: equityOf(head, state.accountValue),
      staleAfterMs,
    });

  let decision = decide();

  if (decision.newLock && EQUITY_RULE_TYPES.has(decision.newLock.rule) && !reconciled) {
    await reconcile();
    stateRead = head.enforcement ?? null;
    decision = decide();
  }

  if (decision.newLock && deps.venueReader.getOpenOrders) {
    openOrders = await deps.venueReader.getOpenOrders(address);
    decision = decide();
  }

  // A check takes a few seconds, and the lock state can change in that time (a manual reset, or another copy of the
  // server). Saving what this check worked out would silently undo that change, so if the saved state is no longer
  // what was read, drop this check and look again from the current state on the next one. Nothing is acted on either.
  const sameState = (a: EnforcementState | null | undefined, b: EnforcementState | null | undefined) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const savedAsRead = await deps.store.runExclusive(accountId, async (ctx) => {
    const fresh = await ctx.getAccountRiskHead(accountId);
    if (!sameState(fresh.enforcement, stateRead)) return false;
    await ctx.updateAccountRiskHead({ ...fresh, enforcement: decision.state });
    return true;
  });
  if (!savedAsRead) return result({ skipped: "the lock state changed while this check was running; checking again next cycle" });

  const record = (kind: "LOCK" | "UNLOCK" | "CANCEL" | "TRIM" | "WARNING", coin: string | null, detail: Record<string, unknown>, resultKind: "WOULD_DO" | "DONE" | "FAILED" | "INFO", error?: string) =>
    deps.store.recordEnforcementAction({ accountId, mode: deps.mode, kind, coin, detail, result: resultKind, error: error ?? null });

  if (decision.newLock) {
    await record("LOCK", null, { rule: decision.newLock.rule, detail: decision.newLock.detail, day: today, ceilings: Object.fromEntries(Object.entries(decision.state.ceilings).map(([k, v]) => [k, v.toString()])) }, "INFO");
  }
  if (decision.unlocked) await record("UNLOCK", null, { day: today }, "INFO");

  const plans = [...decision.actions].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "CANCEL" ? -1 : 1)).slice(0, maxActions);
  let executed = 0;
  let failed = 0;

  for (const plan of plans) {
    const detail = { plan: describePlan(plan), reason: plan.reason };
    const coin = plan.coin;

    if (deps.mode === "log") {
      if (memory.shouldRecord(accountId, `${plan.kind}:${describePlan(plan)}:WOULD_DO`, nowMs, throttleMs)) {
        await record(plan.kind, coin, detail, "WOULD_DO");
      }
      continue;
    }

    const enforcer = await deps.enforcerFor(account);
    if (!enforcer) {
      failed++;
      if (memory.shouldRecord(accountId, `${plan.kind}:${describePlan(plan)}:NOAGENT`, nowMs, throttleMs)) {
        await record(plan.kind, coin, detail, "FAILED", "no approved agent wallet to act with: approve this account's agent wallet on Hyperliquid (API tab, Approve Agent)");
      }
      continue;
    }

    try {
      const outcome = plan.kind === "CANCEL" ? (await enforcer.cancelOrder(plan.coin, plan.oid), { detail: "cancelled" }) : await enforcer.reduceOnlyClose({ coin: plan.coin, isBuy: plan.isBuy, size: plan.size });
      executed++;
      await record(plan.kind, coin, { ...detail, outcome: outcome.detail }, "DONE");
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      if (memory.shouldRecord(accountId, `${plan.kind}:${describePlan(plan)}:FAILED:${message}`, nowMs, throttleMs)) {
        await record(plan.kind, coin, detail, "FAILED", message);
      }
    }
  }

  return result({
    locked: decision.state.lockedDay === today,
    newLock: decision.newLock ? { rule: decision.newLock.rule, detail: decision.newLock.detail } : undefined,
    unlocked: decision.unlocked || undefined,
    planned: plans.length,
    executed,
    failed,
  });
}

export interface WatcherSweepResult {
  results: readonly WatcherCycleResult[];
  errors: ReadonlyArray<{ accountId: string; error: unknown }>;
}

/** One pass over every Hyperliquid account. One account's failure is reported, never allowed to stop the others. */
export async function watchAllHyperliquidAccounts(deps: WatcherDeps): Promise<WatcherSweepResult> {
  const accounts = await deps.store.listAccountsByVenue("hyperliquid");
  const results: WatcherCycleResult[] = [];
  const errors: Array<{ accountId: string; error: unknown }> = [];
  for (const account of accounts) {
    if (!account.venueAddress) continue;
    try {
      results.push(await runWatcherCycle(deps, account.accountId));
    } catch (error) {
      errors.push({ accountId: account.accountId, error });
    }
  }
  return { results, errors };
}

export type { EnforcementState };
