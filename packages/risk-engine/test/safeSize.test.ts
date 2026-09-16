import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import { solveSafeSize } from "../src/safeSize.js";

describe("solveSafeSize", () => {
  it("returns the largest size that fits under a MAX_POSITION_SIZE cap", () => {
    const safeSize = solveSafeSize({
      ruleType: RuleType.MAX_POSITION_SIZE,
      param: new Decimal(100_000),
      existingNotional: new Decimal(80_000),
      equity: new Decimal(50_000),
      price: new Decimal(50_000),
      proposedSize: new Decimal(1),
    });

    // Remaining notional room = 20,000; at price 50,000 that's 0.4 units.
    expect(safeSize?.toString()).toBe("0.4");
  });

  it("returns null when there is no remaining room at all", () => {
    const safeSize = solveSafeSize({
      ruleType: RuleType.MAX_POSITION_SIZE,
      param: new Decimal(100_000),
      existingNotional: new Decimal(100_000),
      equity: new Decimal(50_000),
      price: new Decimal(50_000),
      proposedSize: new Decimal(1),
    });

    expect(safeSize).toBeNull();
  });

  it("never returns more than the originally proposed size", () => {
    const safeSize = solveSafeSize({
      ruleType: RuleType.MAX_POSITION_SIZE,
      param: new Decimal(1_000_000),
      existingNotional: new Decimal(0),
      equity: new Decimal(50_000),
      price: new Decimal(50_000),
      proposedSize: new Decimal(1),
    });

    expect(safeSize?.toString()).toBe("1");
  });

  it("derives the cap from leverage * equity for MAX_LEVERAGE", () => {
    const safeSize = solveSafeSize({
      ruleType: RuleType.MAX_LEVERAGE,
      param: new Decimal(2), // 2x max leverage
      existingNotional: new Decimal(90_000),
      equity: new Decimal(50_000), // cap = 100,000
      price: new Decimal(50_000),
      proposedSize: new Decimal(1),
    });

    expect(safeSize?.toString()).toBe("0.2");
  });
});
