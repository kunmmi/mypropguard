import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { buildRiskDay } from "@mypropguard/test-fixtures";
import { isNewRiskDay, rolloverRiskDay } from "../src/riskDayRollover.js";

describe("rolloverRiskDay", () => {
  it("anchors the new day to verified equity, not yesterday's rolling balance", () => {
    const rolled = rolloverRiskDay("acct_1", "2026-09-16", new Decimal(9_400));

    expect(rolled.riskDate).toBe("2026-09-16");
    expect(rolled.startOfDayEquity.toString()).toBe("9400");
    expect(rolled.realizedPnl.toString()).toBe("0");
    expect(rolled.tradeCount).toBe(0);
  });

  it("does not carry over the previous day's trade count or P&L", () => {
    const previous = buildRiskDay({ realizedPnl: new Decimal(-600), tradeCount: 12 });
    const rolled = rolloverRiskDay(previous.accountId, "2026-09-16", new Decimal(9_400));

    expect(rolled.tradeCount).toBe(0);
    expect(rolled.realizedPnl.toString()).toBe("0");
  });
});

describe("isNewRiskDay", () => {
  it("is true when there is no previous risk day", () => {
    expect(isNewRiskDay(null, "2026-09-16")).toBe(true);
  });

  it("is true once the UTC date changes", () => {
    const previous = buildRiskDay({ riskDate: "2026-09-15" });
    expect(isNewRiskDay(previous, "2026-09-16")).toBe(true);
  });

  it("is false within the same UTC day", () => {
    const previous = buildRiskDay({ riskDate: "2026-09-15" });
    expect(isNewRiskDay(previous, "2026-09-15")).toBe(false);
  });
});
