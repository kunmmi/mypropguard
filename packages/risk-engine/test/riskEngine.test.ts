import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { DecisionOutcome, OrderSide, ReasonCode, RuleType } from "@mypropguard/domain";
import { buildAccountRiskHead, buildProposedOrder, buildRuleVersion } from "@mypropguard/test-fixtures";
import { evaluate } from "../src/riskEngine.js";

describe("RiskEngine.evaluate", () => {
  it("always allows a reduce-only order even with every rule breached", () => {
    const head = buildAccountRiskHead({ currentEquity: new Decimal(0) });
    const rules = [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 100)];
    const order = buildProposedOrder({ reduceOnly: true });

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(1) });

    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
    expect(result.reasonCode).toBe(ReasonCode.REDUCE_ONLY_ALWAYS_ALLOWED);
  });

  it("always allows an order that reduces existing risk, without needing the reduceOnly flag", () => {
    const head = buildAccountRiskHead({ currentEquity: new Decimal(0) }); // would blow a daily-loss rule if risk-increasing
    const rules = [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 100)];
    const order = buildProposedOrder({ side: OrderSide.SELL, size: new Decimal(0.5) });

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(2) });

    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
  });

  it("blocks a risk-increasing order once the daily loss budget is exhausted", () => {
    const head = buildAccountRiskHead({
      equityStartOfDay: new Decimal(10_000),
      currentEquity: new Decimal(9_400), // lost 600
    });
    const rules = [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500)];
    const order = buildProposedOrder();

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.BLOCK);
    expect(result.reasonCode).toBe(ReasonCode.DAILY_LOSS_BUDGET_EXCEEDED);
    expect(result.ruleType).toBe(RuleType.MAX_DAILY_LOSS);
  });

  it("blocks once max drawdown from the account's peak equity is breached", () => {
    const head = buildAccountRiskHead({ peakEquity: new Decimal(20_000), currentEquity: new Decimal(17_000) }); // 15% drawdown
    const rules = [buildRuleVersion(RuleType.MAX_DRAWDOWN, "0.10")]; // 10% cap
    const order = buildProposedOrder();

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.BLOCK);
    expect(result.reasonCode).toBe(ReasonCode.DRAWDOWN_LIMIT_EXCEEDED);
  });

  it("blocks once the trade-count-per-day limit is reached", () => {
    const head = buildAccountRiskHead({ tradeCountToday: 10 });
    const rules = [buildRuleVersion(RuleType.MAX_TRADE_FREQUENCY, 10)];
    const order = buildProposedOrder();

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.BLOCK);
    expect(result.reasonCode).toBe(ReasonCode.TRADE_FREQUENCY_LIMIT_EXCEEDED);
  });

  it("blocks while a cooldown window from the last trade is still active", () => {
    const head = buildAccountRiskHead({ lastTradeAt: new Date(Date.now() - 30_000) }); // 30s ago
    const rules = [buildRuleVersion(RuleType.COOLDOWN, 300)]; // 300s cooldown
    const order = buildProposedOrder();

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.BLOCK);
    expect(result.reasonCode).toBe(ReasonCode.COOLDOWN_ACTIVE);
  });

  it("allows once the cooldown window has elapsed", () => {
    const head = buildAccountRiskHead({ lastTradeAt: new Date(Date.now() - 400_000) }); // 400s ago
    const rules = [buildRuleVersion(RuleType.COOLDOWN, 300)];
    const order = buildProposedOrder();

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
  });

  it("resizes an order that would otherwise breach MAX_POSITION_SIZE", () => {
    const head = buildAccountRiskHead({ openNotional: new Decimal(80_000) });
    const rules = [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)];
    const order = buildProposedOrder({ size: new Decimal(1), price: new Decimal(50_000) }); // 50,000 notional requested

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.RESIZE);
    expect(result.approvedSize?.toString()).toBe("0.4");
    expect(result.ruleType).toBe(RuleType.MAX_POSITION_SIZE);
  });

  it("blocks outright when a sizeable rule leaves zero room", () => {
    const head = buildAccountRiskHead({ openNotional: new Decimal(100_000) });
    const rules = [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)];
    const order = buildProposedOrder({ size: new Decimal(1), price: new Decimal(50_000) });

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.BLOCK);
    expect(result.ruleType).toBe(RuleType.MAX_POSITION_SIZE);
  });

  it("allows an order that is within every active rule", () => {
    const head = buildAccountRiskHead();
    const rules = [
      buildRuleVersion(RuleType.MAX_DAILY_LOSS, 1_000),
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000_000),
    ];
    const order = buildProposedOrder();

    const result = evaluate({ accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) });

    expect(result.outcome).toBe(DecisionOutcome.ALLOW);
    expect(result.reasonCode).toBe(ReasonCode.WITHIN_LIMITS);
  });

  it("is deterministic: identical inputs always produce an identical decision", () => {
    const head = buildAccountRiskHead({ openNotional: new Decimal(80_000) });
    const rules = [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)];
    const order = buildProposedOrder({ size: new Decimal(1), price: new Decimal(50_000) });
    const input = { accountRiskHead: head, rules, proposedOrder: order, currentPositionSize: new Decimal(0) };

    const first = evaluate(input);
    const second = evaluate(input);

    expect(first.outcome).toBe(second.outcome);
    expect(first.approvedSize?.toString()).toBe(second.approvedSize?.toString());
    expect(first.reasonCode).toBe(second.reasonCode);
  });
});
