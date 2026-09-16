import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { CapitalFlowType } from "@mypropguard/domain";
import { buildRiskDay } from "@mypropguard/test-fixtures";
import { applyCapitalFlowsToRiskDay } from "../src/capitalFlow.js";

describe("applyCapitalFlowsToRiskDay", () => {
  it("adds trading P&L to realizedPnl without touching the equity baseline", () => {
    const riskDay = buildRiskDay({ realizedPnl: new Decimal(0), startOfDayEquity: new Decimal(10_000) });

    const updated = applyCapitalFlowsToRiskDay(riskDay, [
      { type: CapitalFlowType.TRADING_PNL, amount: new Decimal(-250) },
    ]);

    expect(updated.realizedPnl.toString()).toBe("-250");
    expect(updated.startOfDayEquity.toString()).toBe("10000");
  });

  it("shifts the equity baseline for deposits/withdrawals without touching realizedPnl", () => {
    const riskDay = buildRiskDay({ realizedPnl: new Decimal(-100), startOfDayEquity: new Decimal(10_000) });

    const updated = applyCapitalFlowsToRiskDay(riskDay, [
      { type: CapitalFlowType.DEPOSIT, amount: new Decimal(5_000) },
    ]);

    expect(updated.startOfDayEquity.toString()).toBe("15000");
    expect(updated.realizedPnl.toString()).toBe("-100");
  });

  it("a same-day deposit can never mask a trading loss as a smaller loss", () => {
    // Regression for the exact bug class the doc warns about: a $5,000
    // deposit must not make a $2,000 trading loss look like it never
    // happened against the loss budget.
    const riskDay = buildRiskDay({ realizedPnl: new Decimal(0), startOfDayEquity: new Decimal(10_000) });

    const updated = applyCapitalFlowsToRiskDay(riskDay, [
      { type: CapitalFlowType.TRADING_PNL, amount: new Decimal(-2_000) },
      { type: CapitalFlowType.DEPOSIT, amount: new Decimal(5_000) },
    ]);

    expect(updated.realizedPnl.toString()).toBe("-2000");
    expect(updated.startOfDayEquity.toString()).toBe("15000");
  });
});
