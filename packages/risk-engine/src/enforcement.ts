import { Decimal } from "decimal.js";
import { RuleType, type EnforcementState, type RuleVersion } from "@mypropguard/domain";

/** One open position, as the venue reports it. `size` is signed: positive long, negative short. */
export interface WatchedPosition {
  coin: string;
  size: Decimal;
  /** Absolute notional value in USD. */
  notional: Decimal;
}

export interface WatchedOrder {
  coin: string;
  oid: number;
  isBuy: boolean;
  size: Decimal;
  reduceOnly: boolean;
}

export interface WatchSnapshot {
  positions: readonly WatchedPosition[];
  /** Only needed while the account is locked. */
  openOrders: readonly WatchedOrder[];
  /** Aggregate absolute notional across all positions. */
  totalNotional: Decimal;
}

/** Flow-adjusted equity numbers (deposits and withdrawals already taken out). */
export interface WatchEquity {
  startOfDay: Decimal;
  current: Decimal;
  peak: Decimal;
}

export type EnforcementActionPlan =
  | { kind: "CANCEL"; coin: string; oid: number; reason: string }
  /** `isBuy` is the side of the closing order: buying back a short, selling down a long. Always reduce-only. */
  | { kind: "TRIM"; coin: string; isBuy: boolean; size: Decimal; reason: string };

export interface EnforcementDecision {
  state: EnforcementState;
  actions: EnforcementActionPlan[];
  /** Set only on the cycle the account becomes locked. */
  newLock: { rule: RuleType; detail: string } | null;
  /** True on the cycle a lock from an earlier UTC day expired. */
  unlocked: boolean;
}

export interface DecideEnforcementInput {
  nowMs: number;
  /** The current UTC day, YYYY-MM-DD. */
  today: string;
  rules: readonly RuleVersion[];
  state: EnforcementState | null;
  snapshot: WatchSnapshot;
  equity: WatchEquity;
  /**
   * How old `state.lastCompliant` may be and still count as "the positions before the breaching trade".
   * Older than this (the watcher was down), every current position is treated as already held.
   */
  staleAfterMs: number;
}

export function emptyEnforcementState(): EnforcementState {
  return { lockedDay: null, reason: null, lockedAtMs: null, ceilings: {}, lastCompliant: null };
}

const WATCHED_RULES_IN_ORDER = [
  RuleType.MAX_DAILY_LOSS,
  RuleType.MAX_DRAWDOWN,
  RuleType.MAX_LEVERAGE,
  RuleType.MAX_POSITION_SIZE,
  RuleType.MAX_EXPOSURE,
] as const;

function activeRule(rules: readonly RuleVersion[], type: RuleType): RuleVersion | undefined {
  return rules.find((r) => r.ruleType === type && r.isActive);
}

/** The first watched rule that is broken right now, or null. Same comparisons the pre-trade risk engine uses. */
export function findBreach(
  rules: readonly RuleVersion[],
  snapshot: WatchSnapshot,
  equity: WatchEquity,
): { rule: RuleType; detail: string } | null {
  for (const type of WATCHED_RULES_IN_ORDER) {
    const rule = activeRule(rules, type);
    if (!rule) continue;
    const limit = rule.param;

    switch (type) {
      case RuleType.MAX_DAILY_LOSS: {
        const loss = Decimal.max(0, equity.startOfDay.minus(equity.current));
        if (loss.gte(limit)) return { rule: type, detail: `lost ${loss.toFixed(2)} today, limit ${limit.toString()}` };
        break;
      }
      case RuleType.MAX_DRAWDOWN: {
        if (equity.peak.gt(0)) {
          const drawdown = Decimal.max(0, equity.peak.minus(equity.current)).div(equity.peak);
          if (drawdown.gte(limit)) return { rule: type, detail: `drawdown ${drawdown.toFixed(4)}, limit ${limit.toString()}` };
        }
        break;
      }
      case RuleType.MAX_LEVERAGE: {
        const cap = limit.times(Decimal.max(0, equity.current));
        if (snapshot.totalNotional.gt(cap)) {
          return { rule: type, detail: `notional ${snapshot.totalNotional.toFixed(2)} over ${limit.toString()}x of equity ${equity.current.toFixed(2)}` };
        }
        break;
      }
      case RuleType.MAX_POSITION_SIZE:
      case RuleType.MAX_EXPOSURE: {
        if (snapshot.totalNotional.gt(limit)) {
          return { rule: type, detail: `notional ${snapshot.totalNotional.toFixed(2)} over limit ${limit.toString()}` };
        }
        break;
      }
    }
  }
  return null;
}

function positionsOf(snapshot: WatchSnapshot): Record<string, Decimal> {
  const out: Record<string, Decimal> = {};
  for (const p of snapshot.positions) {
    if (!p.size.isZero()) out[p.coin] = p.size;
  }
  return out;
}

/**
 * What is new in `current` compared with the ceiling for that coin, and what the ceiling becomes.
 * New exposure is: any position where none was allowed, the part of a position that grew past its ceiling,
 * and the whole of a position that flipped side. A position that shrank lowers its own ceiling, so it cannot
 * be grown back.
 */
function newExposure(current: Decimal, ceiling: Decimal): { excess: Decimal; ceiling: Decimal } {
  if (current.isZero()) return { excess: new Decimal(0), ceiling: new Decimal(0) };
  if (ceiling.isZero() || current.isNegative() !== ceiling.isNegative()) return { excess: current.abs(), ceiling: new Decimal(0) };
  if (current.abs().gt(ceiling.abs())) return { excess: current.abs().minus(ceiling.abs()), ceiling };
  return { excess: new Decimal(0), ceiling: current };
}

/** Would this resting order add to, or flip, the position it is on? */
function wouldIncreaseExposure(order: WatchedOrder, position: Decimal): boolean {
  if (order.reduceOnly) return false;
  if (position.isZero()) return true;
  const sameDirection = order.isBuy === position.isPositive();
  if (sameDirection) return true;
  return order.size.gt(position.abs());
}

/**
 * The watcher's whole decision, with no I/O so it can be tested exhaustively.
 *
 * The lock: when a watched rule is broken the account is locked for the rest of the UTC day. Positions open
 * at that moment are left alone; the trade that broke the rule, and every trade after it, is cancelled or
 * trimmed away. "Before the breaching trade" is the positions at the last cycle that broke no rule. The
 * trader can still reduce or close what they hold; they cannot add, reopen, or flip. At the next UTC day the
 * lock lifts by itself.
 */
export function decideEnforcement(input: DecideEnforcementInput): EnforcementDecision {
  const current = positionsOf(input.snapshot);
  let state: EnforcementState = input.state ?? emptyEnforcementState();
  let unlocked = false;
  let newLock: EnforcementDecision["newLock"] = null;

  if (state.lockedDay && state.lockedDay !== input.today) {
    state = { ...state, lockedDay: null, reason: null, lockedAtMs: null, ceilings: {} };
    unlocked = true;
  }

  if (!state.lockedDay) {
    const breach = findBreach(input.rules, input.snapshot, input.equity);
    if (!breach) {
      return {
        state: { ...state, lastCompliant: { atMs: input.nowMs, positions: current } },
        actions: [],
        newLock: null,
        unlocked,
      };
    }

    const fresh = state.lastCompliant && input.nowMs - state.lastCompliant.atMs <= input.staleAfterMs;
    state = {
      ...state,
      lockedDay: input.today,
      reason: breach.rule,
      lockedAtMs: input.nowMs,
      ceilings: fresh ? { ...state.lastCompliant!.positions } : { ...current },
    };
    newLock = breach;
  }

  const actions: EnforcementActionPlan[] = [];
  const ceilings: Record<string, Decimal> = { ...state.ceilings };
  const reason = `account locked for ${state.lockedDay} (${state.reason})`;

  for (const coin of new Set([...Object.keys(current), ...Object.keys(ceilings)])) {
    const size = current[coin] ?? new Decimal(0);
    const result = newExposure(size, ceilings[coin] ?? new Decimal(0));
    ceilings[coin] = result.ceiling;
    if (result.excess.gt(0)) {
      actions.push({ kind: "TRIM", coin, isBuy: size.isNegative(), size: result.excess, reason: `new exposure while ${reason}` });
    }
  }

  for (const order of input.snapshot.openOrders) {
    if (wouldIncreaseExposure(order, current[order.coin] ?? new Decimal(0))) {
      actions.push({ kind: "CANCEL", coin: order.coin, oid: order.oid, reason: `resting order would add exposure while ${reason}` });
    }
  }

  return { state: { ...state, ceilings }, actions, newLock, unlocked };
}
