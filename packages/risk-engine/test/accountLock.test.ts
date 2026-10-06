import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { DecisionOutcome, OrderSide, ReasonCode } from "@mypropguard/domain";
import { buildAccountRiskHead, buildProposedOrder } from "@mypropguard/test-fixtures";
import { evaluate } from "../src/riskEngine.js";

const today = () => new Date().toISOString().slice(0, 10);

const lockedHead = (lockedDay: string | null) =>
  buildAccountRiskHead({
    enforcement: { lockedDay, reason: "MAX_DAILY_LOSS", lockedAtMs: Date.now(), ceilings: {}, lastCompliant: null },
  });

describe("an account the watcher has locked for today", () => {
  it("blocks any order that would open or add exposure, with a clear reason", () => {
    const result = evaluate({ accountRiskHead: lockedHead(today()), rules: [], proposedOrder: buildProposedOrder(), currentPositionSize: new Decimal(0) });
    expect(result.outcome).toBe(DecisionOutcome.BLOCK);
    expect(result.reasonCode).toBe(ReasonCode.ACCOUNT_LOCKED_FOR_TODAY);
    expect(result.message).toContain("MAX_DAILY_LOSS");
  });

  it("still allows reducing or closing an existing position", () => {
    const result = evaluate({
      accountRiskHead: lockedHead(today()),
      rules: [],
      proposedOrder: buildProposedOrder({ side: OrderSide.SELL, size: new Decimal(1) }),
      currentPositionSize: new Decimal(2),
    });
    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
  });

  it("still allows a reduce-only order", () => {
    const result = evaluate({
      accountRiskHead: lockedHead(today()),
      rules: [],
      proposedOrder: buildProposedOrder({ reduceOnly: true }),
      currentPositionSize: new Decimal(1),
    });
    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
  });

  it("does not block anything once the lock is from an earlier day", () => {
    const result = evaluate({ accountRiskHead: lockedHead("2020-01-01"), rules: [], proposedOrder: buildProposedOrder(), currentPositionSize: new Decimal(0) });
    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
  });

  it("does not block an account that was never locked", () => {
    const result = evaluate({ accountRiskHead: buildAccountRiskHead(), rules: [], proposedOrder: buildProposedOrder(), currentPositionSize: new Decimal(0) });
    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
  });
});
