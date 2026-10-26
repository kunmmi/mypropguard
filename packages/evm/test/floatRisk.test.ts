import { describe, expect, it } from "vitest";
import { parseEther, type Address } from "viem";
import { checkValueRules, hasValueRules, type FloatRiskInput } from "../src/floatRisk.js";

const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const base = (over: Partial<FloatRiskInput> = {}): FloatRiskInput => ({
  rules: {},
  usdPerBnb: 600,
  buy: { spendWei: parseEther("0.1"), token: TOKEN, projectedTokens: 1000 },
  holdings: { equityWei: parseEther("1"), positionsWei: parseEther("0.4") },
  pnlTodayWei: 0n,
  peakEquityWei: parseEther("1"),
  ...over,
});

describe("rules that depend on what the wallet is worth", () => {
  it("allows everything when no rule is set", () => {
    expect(checkValueRules(base())).toBeNull();
    expect(hasValueRules({})).toBe(false);
    expect(hasValueRules({ tokenLimits: {} })).toBe(false);
    expect(hasValueRules({ maxDrawdown: 0.2 })).toBe(true);
  });

  describe("daily loss", () => {
    const rules = { maxDailyLossUsd: 100 };
    it("allows a loss under the limit", () => {
      expect(checkValueRules(base({ rules, pnlTodayWei: -parseEther("0.1") }))).toBeNull(); // $60
    });
    it("stops buying once the loss reaches it, in dollars", () => {
      const r = checkValueRules(base({ rules, pnlTodayWei: -parseEther("0.2") })); // $120
      expect(r).toMatchObject({ code: "LOSS_LIMIT" });
      expect(r!.message).toMatch(/\$120.*\$100.*Selling still works/);
    });
    it("a gain never blocks", () => {
      expect(checkValueRules(base({ rules, pnlTodayWei: parseEther("5") }))).toBeNull();
    });
  });

  describe("drawdown", () => {
    const rules = { maxDrawdown: 0.2 };
    it("allows a fall smaller than the limit", () => {
      expect(checkValueRules(base({ rules, holdings: { equityWei: parseEther("0.85"), positionsWei: 0n } }))).toBeNull();
    });
    it("stops buying at the limit", () => {
      const r = checkValueRules(base({ rules, holdings: { equityWei: parseEther("0.8"), positionsWei: 0n } }));
      expect(r).toMatchObject({ code: "DRAWDOWN_LIMIT" });
      expect(r!.message).toMatch(/down 20%.*limit of 20%/);
    });
    it("does nothing before there is a peak", () => {
      expect(checkValueRules(base({ rules, peakEquityWei: 0n, holdings: { equityWei: 0n, positionsWei: 0n } }))).toBeNull();
    });
  });

  describe("size of one token", () => {
    const rules = { tokenLimits: { [TOKEN.toLowerCase()]: 5000 } };
    it("allows a buy that stays inside the limit", () => {
      expect(checkValueRules(base({ rules, buy: { spendWei: 1n, token: TOKEN, projectedTokens: 5000 } }))).toBeNull();
    });
    it("stops one that goes over", () => {
      expect(checkValueRules(base({ rules, buy: { spendWei: 1n, token: TOKEN, projectedTokens: 5001 } }))).toMatchObject({ code: "POSITION_LIMIT" });
    });
    it("ignores other tokens", () => {
      const other = "0x3333333333333333333333333333333333333333" as Address;
      expect(checkValueRules(base({ rules, buy: { spendWei: 1n, token: other, projectedTokens: 10 ** 9 } }))).toBeNull();
    });
  });

  describe("total exposure", () => {
    const rules = { maxExposureUsd: 300 };
    it("allows a buy that keeps positions under the cap", () => {
      expect(checkValueRules(base({ rules, holdings: { equityWei: parseEther("1"), positionsWei: parseEther("0.3") } }))).toBeNull(); // 0.4 BNB = $240
    });
    it("stops one that passes it and says how much room is left", () => {
      const r = checkValueRules(base({ rules, holdings: { equityWei: parseEther("1"), positionsWei: parseEther("0.45") } })); // 0.55 = $330
      expect(r).toMatchObject({ code: "EXPOSURE_LIMIT" });
      expect(r!.message).toMatch(/\$330.*\$300.*\$30 of room/);
    });
  });

  it("reports the first rule broken: loss before drawdown before size before exposure", () => {
    const r = checkValueRules(
      base({
        rules: { maxDailyLossUsd: 1, maxDrawdown: 0.01, maxExposureUsd: 1 },
        pnlTodayWei: -parseEther("1"),
        holdings: { equityWei: parseEther("0.5"), positionsWei: parseEther("0.5") },
      }),
    );
    expect(r!.code).toBe("LOSS_LIMIT");
  });
});
