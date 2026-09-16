import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderSide, PositionTransition } from "@mypropguard/domain";
import { classifyPositionTransition } from "../src/positionTransition.js";

describe("classifyPositionTransition", () => {
  it("classifies opening a flat position as OPEN and risk-increasing", () => {
    const result = classifyPositionTransition(new Decimal(0), OrderSide.BUY, new Decimal(1));
    expect(result.transition).toBe(PositionTransition.OPEN);
    expect(result.isRiskIncreasing).toBe(true);
    expect(result.resultingSize.toString()).toBe("1");
  });

  it("classifies adding to a long as INCREASE and risk-increasing", () => {
    const result = classifyPositionTransition(new Decimal(1), OrderSide.BUY, new Decimal(0.5));
    expect(result.transition).toBe(PositionTransition.INCREASE);
    expect(result.isRiskIncreasing).toBe(true);
  });

  it("classifies partially selling a long as REDUCE and NOT risk-increasing", () => {
    const result = classifyPositionTransition(new Decimal(2), OrderSide.SELL, new Decimal(1));
    expect(result.transition).toBe(PositionTransition.REDUCE);
    expect(result.isRiskIncreasing).toBe(false);
  });

  it("classifies fully selling a long as CLOSE and NOT risk-increasing", () => {
    const result = classifyPositionTransition(new Decimal(2), OrderSide.SELL, new Decimal(2));
    expect(result.transition).toBe(PositionTransition.CLOSE);
    expect(result.isRiskIncreasing).toBe(false);
    expect(result.resultingSize.toString()).toBe("0");
  });

  it("classifies overselling a long into a short as FLIP and risk-increasing", () => {
    const result = classifyPositionTransition(new Decimal(1), OrderSide.SELL, new Decimal(3));
    expect(result.transition).toBe(PositionTransition.FLIP);
    expect(result.isRiskIncreasing).toBe(true);
    expect(result.resultingSize.toString()).toBe("-2");
  });

  it("mirrors the same logic for short positions", () => {
    const reduce = classifyPositionTransition(new Decimal(-2), OrderSide.BUY, new Decimal(1));
    expect(reduce.transition).toBe(PositionTransition.REDUCE);
    expect(reduce.isRiskIncreasing).toBe(false);

    const increase = classifyPositionTransition(new Decimal(-1), OrderSide.SELL, new Decimal(1));
    expect(increase.transition).toBe(PositionTransition.INCREASE);
    expect(increase.isRiskIncreasing).toBe(true);
  });
});
