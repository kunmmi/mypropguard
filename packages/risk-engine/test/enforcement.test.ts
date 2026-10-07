import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType, type EnforcementState } from "@mypropguard/domain";
import { buildRuleVersion } from "@mypropguard/test-fixtures";
import {
  decideEnforcement,
  emptyEnforcementState,
  findBreach,
  type DecideEnforcementInput,
  type WatchedOrder,
  type WatchedPosition,
} from "../src/enforcement.js";

const D = (n: number | string) => new Decimal(n);
const NOW = Date.parse("2026-10-07T10:00:00Z");
const TODAY = "2026-10-07";
const POLL = 5_000;

const pos = (coin: string, size: number, notional: number): WatchedPosition => ({ coin, size: D(size), notional: D(notional) });
const order = (coin: string, oid: number, isBuy: boolean, size: number, reduceOnly = false): WatchedOrder => ({
  coin,
  oid,
  isBuy,
  size: D(size),
  reduceOnly,
});

function input(overrides: Partial<DecideEnforcementInput> & { positions?: WatchedPosition[]; orders?: WatchedOrder[] } = {}): DecideEnforcementInput {
  const positions = overrides.positions ?? [];
  return {
    nowMs: NOW,
    today: TODAY,
    rules: [],
    state: null,
    snapshot: {
      positions,
      openOrders: overrides.orders ?? [],
      totalNotional: positions.reduce((sum, p) => sum.plus(p.notional), D(0)),
    },
    equity: { startOfDay: D(1000), current: D(1000), peak: D(1000) },
    staleAfterMs: 30_000,
    ...overrides,
  };
}

const lossRule = (limit: number) => buildRuleVersion(RuleType.MAX_DAILY_LOSS, limit, { id: `loss_${limit}` });

/** A state that was recorded at the last compliant cycle. */
function compliantState(positions: Record<string, number>, atMs = NOW - POLL): EnforcementState {
  return {
    ...emptyEnforcementState(),
    lastCompliant: { atMs, positions: Object.fromEntries(Object.entries(positions).map(([k, v]) => [k, D(v)])) },
  };
}

function lockedState(ceilings: Record<string, number>, reason = "MAX_DAILY_LOSS", day = TODAY): EnforcementState {
  return {
    lockedDay: day,
    reason,
    lockedAtMs: NOW - 60_000,
    ceilings: Object.fromEntries(Object.entries(ceilings).map(([k, v]) => [k, D(v)])),
    lastCompliant: null,
  };
}

describe("findBreach", () => {
  const equity = { startOfDay: D(1000), current: D(1000), peak: D(1000) };
  const snap = (total: number) => ({ positions: [], openOrders: [], totalNotional: D(total) });

  it("finds nothing when no rule is broken, or when there are no rules", () => {
    expect(findBreach([lossRule(100)], snap(0), equity)).toBeNull();
    expect(findBreach([], snap(1e9), { ...equity, current: D(0) })).toBeNull();
  });

  it("breaks the daily-loss rule exactly when the loss reaches the limit", () => {
    expect(findBreach([lossRule(100)], snap(0), { ...equity, current: D(901) })).toBeNull();
    expect(findBreach([lossRule(100)], snap(0), { ...equity, current: D(900) })?.rule).toBe(RuleType.MAX_DAILY_LOSS);
  });

  it("a gain is never a loss", () => {
    expect(findBreach([lossRule(100)], snap(0), { ...equity, current: D(5000) })).toBeNull();
  });

  it("breaks the drawdown rule by the fraction below the peak", () => {
    const rule = buildRuleVersion(RuleType.MAX_DRAWDOWN, 0.1, { id: "dd" });
    expect(findBreach([rule], snap(0), { startOfDay: D(1000), current: D(950), peak: D(1000) })).toBeNull();
    expect(findBreach([rule], snap(0), { startOfDay: D(1000), current: D(900), peak: D(1000) })?.rule).toBe(RuleType.MAX_DRAWDOWN);
  });

  it("breaks the leverage rule when notional exceeds the multiple of equity", () => {
    const rule = buildRuleVersion(RuleType.MAX_LEVERAGE, 5, { id: "lev" });
    expect(findBreach([rule], snap(5000), equity)).toBeNull();
    expect(findBreach([rule], snap(5001), equity)?.rule).toBe(RuleType.MAX_LEVERAGE);
    expect(findBreach([rule], snap(1), { ...equity, current: D(0) })?.rule).toBe(RuleType.MAX_LEVERAGE);
  });

  it("breaks the position-size and exposure rules on total notional", () => {
    const size = buildRuleVersion(RuleType.MAX_POSITION_SIZE, 2000, { id: "size" });
    const exposure = buildRuleVersion(RuleType.MAX_EXPOSURE, 3000, { id: "exp" });
    expect(findBreach([size], snap(2000), equity)).toBeNull();
    expect(findBreach([size], snap(2001), equity)?.rule).toBe(RuleType.MAX_POSITION_SIZE);
    expect(findBreach([exposure], snap(3001), equity)?.rule).toBe(RuleType.MAX_EXPOSURE);
  });

  it("ignores inactive rules", () => {
    const rule = { ...lossRule(1), isActive: false };
    expect(findBreach([rule], snap(0), { ...equity, current: D(0) })).toBeNull();
  });
});

describe("decideEnforcement - while no rule is broken", () => {
  it("does nothing and remembers the positions as the last compliant ones", () => {
    const d = decideEnforcement(input({ rules: [lossRule(100)], positions: [pos("BTC", 0.5, 30000)] }));
    expect(d.actions).toEqual([]);
    expect(d.newLock).toBeNull();
    expect(d.state.lockedDay).toBeNull();
    expect(d.state.lastCompliant?.positions.BTC?.toString()).toBe("0.5");
    expect(d.state.lastCompliant?.atMs).toBe(NOW);
  });

  it("never touches an account without watched rules", () => {
    const d = decideEnforcement(input({ positions: [pos("BTC", 10, 600000)], equity: { startOfDay: D(1000), current: D(0), peak: D(1000) } }));
    expect(d.actions).toEqual([]);
    expect(d.state.lockedDay).toBeNull();
  });
});

describe("decideEnforcement - the moment a rule is broken", () => {
  const broken = { startOfDay: D(1000), current: D(850), peak: D(1000) }; // lost 150, limit 100

  it("locks for the UTC day and leaves existing positions alone (a loss from positions already open)", () => {
    const d = decideEnforcement(
      input({ rules: [lossRule(100)], equity: broken, positions: [pos("BTC", 0.5, 30000)], state: compliantState({ BTC: 0.5 }) }),
    );
    expect(d.newLock?.rule).toBe(RuleType.MAX_DAILY_LOSS);
    expect(d.state.lockedDay).toBe(TODAY);
    expect(d.state.reason).toBe(RuleType.MAX_DAILY_LOSS);
    expect(d.actions).toEqual([]); // nothing is closed
    expect(d.state.ceilings.BTC?.toString()).toBe("0.5");
  });

  it("closes the trade that broke the rule: a position that grew past what was held just before", () => {
    const rule = buildRuleVersion(RuleType.MAX_EXPOSURE, 30000, { id: "exp" });
    const d = decideEnforcement(
      input({ rules: [rule], positions: [pos("BTC", 0.8, 48000)], state: compliantState({ BTC: 0.5 }) }), // 0.5 -> 0.8
    );
    expect(d.newLock?.rule).toBe(RuleType.MAX_EXPOSURE);
    expect(d.actions).toHaveLength(1);
    const trim = d.actions[0]!;
    expect(trim.kind === "TRIM" && trim.coin === "BTC" && !trim.isBuy && trim.size.toFixed(1) === "0.3").toBe(true); // sell 0.3, back to 0.5
  });

  it("closes a brand-new position that broke the rule, in full", () => {
    const rule = buildRuleVersion(RuleType.MAX_EXPOSURE, 30000, { id: "exp" });
    const d = decideEnforcement(
      input({
        rules: [rule],
        positions: [pos("BTC", 0.5, 30000), pos("ETH", -4, 12000)],
        state: compliantState({ BTC: 0.5 }),
      }),
    );
    const trims = d.actions.filter((a) => a.kind === "TRIM");
    expect(trims).toHaveLength(1);
    const trim = trims[0]!;
    // ETH is short 4, so closing it means BUYING 4 back.
    expect(trim.kind === "TRIM" && trim.coin === "ETH" && trim.isBuy && trim.size.toString() === "4").toBe(true);
  });

  it("treats every position as already held when the last compliant reading is stale (the watcher was down)", () => {
    const rule = buildRuleVersion(RuleType.MAX_EXPOSURE, 30000, { id: "exp" });
    const d = decideEnforcement(
      input({
        rules: [rule],
        positions: [pos("BTC", 0.8, 48000)],
        state: compliantState({ BTC: 0.5 }, NOW - 10 * 60_000),
      }),
    );
    expect(d.newLock).not.toBeNull();
    expect(d.actions).toEqual([]);
    expect(d.state.ceilings.BTC?.toString()).toBe("0.8");
  });

  it("treats every position as already held on the very first reading", () => {
    const d = decideEnforcement(input({ rules: [lossRule(100)], equity: broken, positions: [pos("BTC", 1, 60000)] }));
    expect(d.newLock).not.toBeNull();
    expect(d.actions).toEqual([]);
  });
});

describe("decideEnforcement - while locked: every new trade is closed, existing positions are not", () => {
  const rules = [lossRule(100)];
  const equity = { startOfDay: D(1000), current: D(850), peak: D(1000) };
  const locked = (ceilings: Record<string, number>) => ({ rules, equity, state: lockedState(ceilings) });

  it("does nothing while the trader just holds what they had", () => {
    const d = decideEnforcement(input({ ...locked({ BTC: 0.5 }), positions: [pos("BTC", 0.5, 30000)] }));
    expect(d.actions).toEqual([]);
    expect(d.newLock).toBeNull();
    expect(d.state.lockedDay).toBe(TODAY);
  });

  it("closes a new position on a coin never held", () => {
    const d = decideEnforcement(input({ ...locked({ BTC: 0.5 }), positions: [pos("BTC", 0.5, 30000), pos("SOL", 100, 14000)] }));
    expect(d.actions).toHaveLength(1);
    const a = d.actions[0]!;
    expect(a.kind === "TRIM" && a.coin === "SOL" && !a.isBuy && a.size.toString() === "100").toBe(true);
  });

  it("closes only the part added to an existing position", () => {
    const d = decideEnforcement(input({ ...locked({ BTC: 0.5 }), positions: [pos("BTC", 0.7, 42000)] }));
    const a = d.actions[0]!;
    expect(a.kind === "TRIM" && a.coin === "BTC" && !a.isBuy && a.size.toFixed(1) === "0.2").toBe(true);
  });

  it("closes added size on a short too (buying back)", () => {
    const d = decideEnforcement(input({ ...locked({ ETH: -2 }), positions: [pos("ETH", -3, 9000)] }));
    const a = d.actions[0]!;
    expect(a.kind === "TRIM" && a.isBuy && a.size.toString() === "1").toBe(true);
  });

  it("lets the trader reduce a position, and then will not let them grow it back", () => {
    const reduced = decideEnforcement(input({ ...locked({ BTC: 0.5 }), positions: [pos("BTC", 0.2, 12000)] }));
    expect(reduced.actions).toEqual([]);
    expect(reduced.state.ceilings.BTC?.toString()).toBe("0.2");

    const regrown = decideEnforcement(input({ rules, equity, state: reduced.state, positions: [pos("BTC", 0.4, 24000)] }));
    const a = regrown.actions[0]!;
    expect(a.kind === "TRIM" && a.size.toFixed(1) === "0.2").toBe(true); // 0.4 - 0.2
  });

  it("does not let a closed position be reopened", () => {
    const closed = decideEnforcement(input({ ...locked({ BTC: 0.5 }), positions: [] }));
    expect(closed.actions).toEqual([]);
    expect(closed.state.ceilings.BTC?.toString()).toBe("0");

    const reopened = decideEnforcement(input({ rules, equity, state: closed.state, positions: [pos("BTC", 0.3, 18000)] }));
    const a = reopened.actions[0]!;
    expect(a.kind === "TRIM" && a.size.toString() === "0.3").toBe(true);
  });

  it("closes the whole new side of a flip, and forgets the old side", () => {
    const d = decideEnforcement(input({ ...locked({ BTC: 0.5 }), positions: [pos("BTC", -0.3, 18000)] })); // long 0.5 -> short 0.3
    const a = d.actions[0]!;
    expect(a.kind === "TRIM" && a.isBuy && a.size.toString() === "0.3").toBe(true);
    expect(d.state.ceilings.BTC?.toString()).toBe("0");
  });

  it("cancels resting orders that would add exposure, and keeps ones that only reduce", () => {
    const d = decideEnforcement(
      input({
        ...locked({ BTC: 0.5 }),
        positions: [pos("BTC", 0.5, 30000)],
        orders: [
          order("BTC", 1, true, 0.1), // adds to the long: cancel
          order("BTC", 2, false, 0.2), // sells part of the long: a normal exit, keep
          order("BTC", 3, false, 0.9), // sells more than held: would flip: cancel
          order("BTC", 4, true, 5, true), // reduce-only: keep
          order("ETH", 5, false, 1), // no ETH position: would open a short: cancel
        ],
      }),
    );
    const cancelled = d.actions.filter((a) => a.kind === "CANCEL").map((a) => (a.kind === "CANCEL" ? a.oid : -1));
    expect(cancelled.sort()).toEqual([1, 3, 5]);
  });

  it("is safe to repeat: the same input gives the same decision", () => {
    const i = input({ ...locked({ BTC: 0.5 }), positions: [pos("BTC", 0.7, 42000)] });
    expect(decideEnforcement(i)).toEqual(decideEnforcement(i));
  });

  it("does not update the last compliant positions while locked", () => {
    const state = { ...lockedState({ BTC: 0.5 }), lastCompliant: { atMs: NOW - 99_999, positions: { BTC: D(0.1) } } };
    const d = decideEnforcement(input({ rules, equity, state, positions: [pos("BTC", 0.5, 30000)] }));
    expect(d.state.lastCompliant?.atMs).toBe(NOW - 99_999);
  });
});

describe("decideEnforcement - the UTC day", () => {
  it("lifts a lock from an earlier day and starts clean", () => {
    const state = lockedState({ BTC: 0.5 }, "MAX_DAILY_LOSS", "2026-10-06");
    const d = decideEnforcement(input({ rules: [lossRule(100)], state, positions: [pos("BTC", 0.9, 54000), pos("ETH", 3, 9000)] }));
    expect(d.unlocked).toBe(true);
    expect(d.state.lockedDay).toBeNull();
    expect(d.state.ceilings).toEqual({});
    expect(d.actions).toEqual([]); // the new day's trades are free again
  });

  it("can lock again on the new day if the rule is already broken", () => {
    const state = lockedState({ BTC: 0.5 }, "MAX_DAILY_LOSS", "2026-10-06");
    const d = decideEnforcement(
      input({ rules: [lossRule(100)], state, equity: { startOfDay: D(1000), current: D(800), peak: D(1000) }, positions: [pos("BTC", 0.5, 30000)] }),
    );
    expect(d.unlocked).toBe(true);
    expect(d.newLock).not.toBeNull();
    expect(d.state.lockedDay).toBe(TODAY);
  });
});

describe("findBreach with two active rules of one kind (a limit that was changed without removing the old one)", () => {
  const snapshot = { positions: [pos("BTC", 0.00013, 11)], openOrders: [], totalNotional: D(11) };
  const equity = { startOfDay: D(100), current: D(100), peak: D(100) };

  it("uses the most recently created rule, not whichever happens to come first", () => {
    const older = buildRuleVersion(RuleType.MAX_POSITION_SIZE, 10, { createdAt: new Date("2026-10-07T09:00:00Z") });
    const newer = buildRuleVersion(RuleType.MAX_POSITION_SIZE, 20, { createdAt: new Date("2026-10-07T09:30:00Z") });

    expect(findBreach([older, newer], snapshot, equity)).toBeNull();
    expect(findBreach([newer, older], snapshot, equity)).toBeNull();
  });

  it("still catches a breach of the newest limit", () => {
    const older = buildRuleVersion(RuleType.MAX_POSITION_SIZE, 20, { createdAt: new Date("2026-10-07T09:00:00Z") });
    const newer = buildRuleVersion(RuleType.MAX_POSITION_SIZE, 10, { createdAt: new Date("2026-10-07T09:30:00Z") });
    expect(findBreach([older, newer], snapshot, equity)?.rule).toBe(RuleType.MAX_POSITION_SIZE);
  });
});
