import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther, type Address } from "viem";
import { FloatTradeRefused, FloatExecutor, TOKEN_MANAGER_V2_ABI, type FloatDecision } from "@mypropguard/evm";
import { FloatRiskGuard } from "../src/float/floatRiskGuard.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const A = "0x2222222222222222222222222222222222222222" as Address;
const B = "0x3333333333333333333333333333333333333333" as Address;
const DAY = Date.UTC(2026, 9, 26, 12, 0, 0);
const TODAY = "2026-10-26";

type Ok = Extract<FloatDecision, { ok: true }>;
const buyOf = (token: Address, spendBnb = "0.1"): Ok => ({ ok: true, kind: "buy", spendWei: parseEther(spendBnb), token, summary: "buy" });

function rig(over: {
  known?: Address[];
  flows?: Array<{ token: Address; costWei: bigint; proceedsWei: bigint }>;
  state?: { day: string | null; dayStartPnlWei: bigint; peakEquityWei: bigint };
  bnb?: bigint;
  values?: Record<string, { balance: bigint; value: bigint }>;
  usd?: number | Error;
  held?: bigint;
  buys?: bigint;
  valuerError?: boolean;
} = {}) {
  const saved: Array<{ day: string; dayStartPnlWei: bigint; peakEquityWei: bigint }> = [];
  const asked: string[] = [];
  let state = over.state ?? { day: null, dayStartPnlWei: 0n, peakEquityWei: 0n };
  const values = over.values ?? {};
  const guard = new FloatRiskGuard({
    store: {
      knownTokens: async () => over.known ?? [],
      tokenFlows: async () => over.flows ?? [],
      getRiskState: async () => state,
      saveRiskState: async (_id: string, s: { day: string; dayStartPnlWei: bigint; peakEquityWei: bigint }) => {
        saved.push(s);
        state = s;
      },
    },
    valuer: {
      holdings: async (_w: Address, tokens: readonly Address[]) => {
        asked.push("holdings");
        if (over.valuerError) throw new Error("rpc down");
        const positions = tokens.map((t) => ({ token: t, balance: values[t]?.balance ?? 0n, valueWei: values[t]?.value ?? 0n }));
        const positionsWei = positions.reduce((s, p) => s + p.valueWei, 0n);
        const bnbWei = over.bnb ?? parseEther("1");
        return { bnbWei, positions, positionsWei, equityWei: bnbWei + positionsWei };
      },
      balanceOf: async () => over.held ?? 0n,
      decimals: async () => 18,
      quoteBuy: async () => over.buys ?? 0n,
      quoteSell: async (_t: Address, amount: bigint) => amount * 2n,
    } as never,
    usdPerBnb: async () => {
      asked.push("usd");
      if (over.usd instanceof Error) throw over.usd;
      return over.usd ?? 600;
    },
    now: () => DAY,
  });
  return { guard, saved, asked, getState: () => state };
}

const w = { accountId: "a1", address: WALLET };

describe("the wallet's value rules", () => {
  it("does nothing, and asks the chain nothing, when the account has no such rule", async () => {
    const { guard, asked } = rig();
    expect(await guard.checkBuy(w, {}, buyOf(A))).toBeNull();
    expect(asked).toEqual([]);
  });

  describe("daily loss", () => {
    const rules = { maxDailyLossUsd: 100 };
    it("stops buying once what was lost since the day began reaches the limit", async () => {
      // A cost 0.5 BNB and is now worth 0.3: down 0.2 BNB = $120. The day began at a result of 0.
      const { guard } = rig({
        known: [A],
        flows: [{ token: A, costWei: parseEther("0.5"), proceedsWei: 0n }],
        values: { [A]: { balance: 10n, value: parseEther("0.3") } },
        state: { day: TODAY, dayStartPnlWei: 0n, peakEquityWei: parseEther("5") },
      });
      expect(await guard.checkBuy(w, rules, buyOf(B))).toMatchObject({ code: "LOSS_LIMIT" });
    });

    it("counts only today: a loss from before today does not block a new day", async () => {
      const { guard, saved } = rig({
        known: [A],
        flows: [{ token: A, costWei: parseEther("0.5"), proceedsWei: 0n }],
        values: { [A]: { balance: 10n, value: parseEther("0.3") } },
        state: { day: "2026-10-25", dayStartPnlWei: 0n, peakEquityWei: parseEther("5") },
      });
      expect(await guard.checkBuy(w, rules, buyOf(B))).toBeNull();
      expect(saved.at(-1)).toMatchObject({ day: TODAY, dayStartPnlWei: -parseEther("0.2") });
    });

    it("money taken back out (a token handed to the owner) is not a loss", async () => {
      // A cost 0.5, was handed back when worth 0.5, and is no longer held.
      const { guard } = rig({
        known: [A],
        flows: [{ token: A, costWei: parseEther("0.5"), proceedsWei: parseEther("0.5") }],
        values: {},
        state: { day: TODAY, dayStartPnlWei: 0n, peakEquityWei: parseEther("5") },
      });
      expect(await guard.checkBuy(w, rules, buyOf(B))).toBeNull();
    });

    it("a deposit is not a gain that hides a loss, and a withdrawal is not a loss", async () => {
      const flows = [{ token: A, costWei: parseEther("0.5"), proceedsWei: 0n }];
      const values = { [A]: { balance: 10n, value: parseEther("0.3") } };
      const state = { day: TODAY, dayStartPnlWei: 0n, peakEquityWei: parseEther("50") };
      // However much BNB is in the wallet, the same -0.2 BNB result is seen.
      for (const bnb of [parseEther("0.01"), parseEther("100")]) {
        const { guard } = rig({ known: [A], flows, values, state, bnb });
        expect(await guard.checkBuy(w, rules, buyOf(B)), String(bnb)).toMatchObject({ code: "LOSS_LIMIT" });
      }
    });

    it("sales that returned more than the buys cost make a gain", async () => {
      const { guard } = rig({
        known: [A],
        flows: [{ token: A, costWei: parseEther("0.5"), proceedsWei: parseEther("0.9") }],
        values: {},
        state: { day: TODAY, dayStartPnlWei: 0n, peakEquityWei: parseEther("5") },
      });
      expect(await guard.checkBuy(w, rules, buyOf(B))).toBeNull();
    });
  });

  describe("drawdown", () => {
    const rules = { maxDrawdown: 0.2 };
    it("remembers the highest the wallet has been worth, and stops buying after a 20% fall", async () => {
      const first = rig({ bnb: parseEther("1") });
      expect(await first.guard.checkBuy(w, rules, buyOf(A))).toBeNull();
      expect(first.getState().peakEquityWei).toBe(parseEther("1"));

      const down = rig({ bnb: parseEther("0.7"), state: { day: TODAY, dayStartPnlWei: 0n, peakEquityWei: parseEther("1") } });
      expect(await down.guard.checkBuy(w, rules, buyOf(A))).toMatchObject({ code: "DRAWDOWN_LIMIT" });
      expect(down.getState().peakEquityWei).toBe(parseEther("1"));
    });

    it("a rise raises the high-water mark", async () => {
      const { guard, getState } = rig({ bnb: parseEther("3"), state: { day: TODAY, dayStartPnlWei: 0n, peakEquityWei: parseEther("1") } });
      await guard.checkBuy(w, rules, buyOf(A));
      expect(getState().peakEquityWei).toBe(parseEther("3"));
    });
  });

  describe("size of one token", () => {
    const rules = { tokenLimits: { [A.toLowerCase()]: 1000 } };
    it("counts what is held plus what this buy would bring", async () => {
      const over = rig({ held: parseEther("900"), buys: parseEther("150") });
      expect(await over.guard.checkBuy(w, rules, buyOf(A))).toMatchObject({ code: "POSITION_LIMIT" });
      const under = rig({ held: parseEther("900"), buys: parseEther("90") });
      expect(await under.guard.checkBuy(w, rules, buyOf(A))).toBeNull();
    });
    it("does not apply to other tokens", async () => {
      expect(await rig({ held: parseEther("5000") }).guard.checkBuy(w, rules, buyOf(B))).toBeNull();
    });
  });

  describe("total exposure", () => {
    it("stops a buy that takes open positions past the dollar limit", async () => {
      const { guard } = rig({ known: [A], values: { [A]: { balance: 1n, value: parseEther("0.45") } } });
      expect(await guard.checkBuy(w, { maxExposureUsd: 300 }, buyOf(B))).toMatchObject({ code: "EXPOSURE_LIMIT" }); // 0.55 BNB = $330
    });
  });

  it("only asks for the BNB price when a rule is in dollars", async () => {
    const { guard, asked } = rig();
    await guard.checkBuy(w, { maxDrawdown: 0.5 }, buyOf(A));
    expect(asked).not.toContain("usd");
  });

  it("fails loudly, not open, when the chain cannot be read or the price is missing", async () => {
    await expect(rig({ valuerError: true }).guard.checkBuy(w, { maxDrawdown: 0.5 }, buyOf(A))).rejects.toThrow();
    await expect(rig({ usd: new Error("no price") }).guard.checkBuy(w, { maxDailyLossUsd: 5 }, buyOf(A))).rejects.toThrow();
  });

  it("values a sale for the books, and nothing else", async () => {
    const { guard } = rig();
    const sell: Ok = { ok: true, kind: "sell", spendWei: 0n, token: A, sellAmount: 50n, summary: "sell" };
    expect(await guard.valueSell(sell)).toBe(100n);
    expect(await guard.valueSell({ ...sell, sellAmount: undefined })).toBeNull();
    expect(await guard.valueSell(buyOf(A))).toBeNull();
  });
});

describe("through the executor", () => {
  it("a buy the guard refuses is never signed; a sell right after still is", async () => {
    const { guard } = rig({
      known: [A],
      flows: [{ token: A, costWei: parseEther("0.5"), proceedsWei: 0n }],
      values: { [A]: { balance: 10n, value: parseEther("0.3") } },
      state: { day: TODAY, dayStartPnlWei: 0n, peakEquityWei: parseEther("5") },
    });
    const sent: string[] = [];
    const executor = new FloatExecutor({
      publicClient: { getBalance: async () => parseEther("1"), estimateGas: async () => 150_000n } as never,
      signer: { sendTransaction: async (_i: string, tx: { to: string }) => (sent.push(tx.to), `0x${"ab".repeat(32)}` as `0x${string}`), personalSign: async () => "0x" as `0x${string}` },
    });
    const wallet = { accountId: "a1", walletId: "p", address: WALLET, limits: { maxBuysPerDay: 9, cooldownSec: 0, frozen: false }, percentOfBalance: { maxBuyPct: 50, dailySpendPct: 90 } };
    const io = {
      loadUsage: async () => ({ buysToday: 0, spentTodayWei: 0n, lastBuyAtSec: null }),
      onSent: async () => undefined,
      beforeBuy: (d: Ok) => guard.checkBuy(w, { maxDailyLossUsd: 100 }, d),
      valueSell: (d: Ok) => guard.valueSell(d),
    };
    const V2 = "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as Address;
    const buy = { to: V2, value: parseEther("0.1"), data: encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [B, parseEther("0.1"), 1n] }) };
    const sell = { to: V2, value: 0n, data: encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [A, 5n] }) };

    const err = await executor.execute(wallet, buy, io).catch((e) => e);
    expect(err).toBeInstanceOf(FloatTradeRefused);
    expect(err.code).toBe("LOSS_LIMIT");
    expect(sent).toHaveLength(0);

    await executor.execute(wallet, sell, io);
    expect(sent).toEqual([V2]);
  });
});
