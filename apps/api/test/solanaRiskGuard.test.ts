import { describe, expect, it } from "vitest";
import { SolanaRiskGuard } from "../src/solana/solanaRiskGuard.js";

const SOL = 1_000_000_000n;
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const A = "MintAAAA111111111111111111111111111111111111";
const B = "MintBBBB111111111111111111111111111111111111";
const DAY = Date.UTC(2026, 9, 26, 12, 0, 0);
const TODAY = "2026-10-26";

const buyOf = (mint: string, spendSol = 0.1) => ({ ok: true as const, kind: "buy" as const, mint, spendLamports: BigInt(Math.round(spendSol * 1e9)), tokenAmount: 1n, minSolOut: 0n, summary: "buy" });

function rig(over: {
  known?: string[];
  flows?: Array<{ mint: string; costLamports: bigint; proceedsLamports: bigint }>;
  state?: { day: string | null; dayStartPnlLamports: bigint; peakEquityLamports: bigint };
  sol?: bigint;
  values?: Record<string, { balance: bigint; value: bigint }>;
  usd?: number | Error;
  held?: bigint;
  bought?: bigint;
  valuerError?: boolean;
} = {}) {
  const saved: Array<{ day: string; dayStartPnlLamports: bigint; peakEquityLamports: bigint }> = [];
  const asked: string[] = [];
  let state = over.state ?? { day: null, dayStartPnlLamports: 0n, peakEquityLamports: 0n };
  const values = over.values ?? {};
  const guard = new SolanaRiskGuard({
    store: {
      knownMints: async () => over.known ?? [],
      mintFlows: async () => over.flows ?? [],
      getRiskState: async () => state,
      saveRiskState: async (_id: string, s: { day: string; dayStartPnlLamports: bigint; peakEquityLamports: bigint }) => {
        saved.push(s);
        state = s;
      },
    },
    valuer: {
      holdings: async (_w: string, mints: readonly string[]) => {
        asked.push("holdings");
        if (over.valuerError) throw new Error("rpc down");
        const positions = mints.map((m) => ({ mint: m, balance: values[m]?.balance ?? 0n, valueLamports: values[m]?.value ?? 0n }));
        const positionsLamports = positions.reduce((s, p) => s + p.valueLamports, 0n);
        const solLamports = over.sol ?? SOL;
        return { solLamports, positions, positionsLamports, equityLamports: solLamports + positionsLamports };
      },
      balanceOf: async () => over.held ?? 0n,
      decimals: async () => 6,
      quoteBuy: async () => over.bought ?? 0n,
      quoteSell: async (_m: string, amount: bigint) => amount * 2n,
    } as never,
    usdPerSol: async () => {
      asked.push("usd");
      if (over.usd instanceof Error) throw over.usd;
      return over.usd ?? 150;
    },
    now: () => DAY,
  });
  return { guard, saved, asked, getState: () => state };
}

const w = { accountId: "a1", address: WALLET };

describe("the Solana wallet's value rules", () => {
  it("does nothing, and asks the network nothing, when the account has no such rule", async () => {
    const { guard, asked } = rig();
    expect(await guard.checkBuy(w, {}, buyOf(A))).toBeNull();
    expect(asked).toEqual([]);
  });

  describe("daily loss (in dollars, at 150 per SOL)", () => {
    const rules = { maxDailyLossUsd: 100 };
    const lossy = { known: [A], flows: [{ mint: A, costLamports: SOL, proceedsLamports: 0n }], values: { [A]: { balance: 10n, value: SOL / 2n } } }; // down 0.5 SOL = $75
    it("allows a loss under the limit", async () => {
      expect(await rig({ ...lossy, state: { day: TODAY, dayStartPnlLamports: 0n, peakEquityLamports: 9n * SOL } }).guard.checkBuy(w, rules, buyOf(B))).toBeNull();
    });
    it("stops buying once the loss since the day began reaches it", async () => {
      const lost = { ...lossy, values: { [A]: { balance: 10n, value: SOL / 4n } } }; // down 0.75 SOL = $112
      expect(await rig({ ...lost, state: { day: TODAY, dayStartPnlLamports: 0n, peakEquityLamports: 9n * SOL } }).guard.checkBuy(w, rules, buyOf(B))).toMatchObject({ code: "LOSS_LIMIT" });
    });
    it("counts only today: an earlier loss does not block a new day", async () => {
      const lost = { ...lossy, values: { [A]: { balance: 10n, value: SOL / 4n } } };
      const { guard, saved } = rig({ ...lost, state: { day: "2026-10-25", dayStartPnlLamports: 0n, peakEquityLamports: 9n * SOL } });
      expect(await guard.checkBuy(w, rules, buyOf(B))).toBeNull();
      expect(saved.at(-1)).toMatchObject({ day: TODAY, dayStartPnlLamports: -(SOL * 3n) / 4n });
    });
    it("a coin withdrawn at its value is not a loss", async () => {
      const { guard } = rig({ known: [A], flows: [{ mint: A, costLamports: SOL, proceedsLamports: SOL }], state: { day: TODAY, dayStartPnlLamports: 0n, peakEquityLamports: 9n * SOL } });
      expect(await guard.checkBuy(w, rules, buyOf(B))).toBeNull();
    });
    it("the SOL in the wallet does not hide a loss or create one: deposits and withdrawals are not trades", async () => {
      const lost = { ...lossy, values: { [A]: { balance: 10n, value: SOL / 4n } } };
      for (const sol of [SOL / 100n, 500n * SOL]) {
        const { guard } = rig({ ...lost, sol, state: { day: TODAY, dayStartPnlLamports: 0n, peakEquityLamports: 900n * SOL } });
        expect(await guard.checkBuy(w, rules, buyOf(B)), String(sol)).toMatchObject({ code: "LOSS_LIMIT" });
      }
    });
    it("sales that returned more than they cost make a gain", async () => {
      const { guard } = rig({ known: [A], flows: [{ mint: A, costLamports: SOL, proceedsLamports: 2n * SOL }], state: { day: TODAY, dayStartPnlLamports: 0n, peakEquityLamports: 9n * SOL } });
      expect(await guard.checkBuy(w, rules, buyOf(B))).toBeNull();
    });
  });

  describe("drawdown", () => {
    const rules = { maxDrawdown: 0.2 };
    it("remembers the highest the wallet has been, and stops buying after a 20% fall", async () => {
      const first = rig({ sol: SOL });
      expect(await first.guard.checkBuy(w, rules, buyOf(A))).toBeNull();
      expect(first.getState().peakEquityLamports).toBe(SOL);
      const down = rig({ sol: (7n * SOL) / 10n, state: { day: TODAY, dayStartPnlLamports: 0n, peakEquityLamports: SOL } });
      expect(await down.guard.checkBuy(w, rules, buyOf(A))).toMatchObject({ code: "DRAWDOWN_LIMIT" });
    });
    it("a rise raises the high-water mark", async () => {
      const { guard, getState } = rig({ sol: 3n * SOL, state: { day: TODAY, dayStartPnlLamports: 0n, peakEquityLamports: SOL } });
      await guard.checkBuy(w, rules, buyOf(A));
      expect(getState().peakEquityLamports).toBe(3n * SOL);
    });
  });

  describe("size of one coin (whole tokens, 6 decimals)", () => {
    const rules = { tokenLimits: { [A.toLowerCase()]: 1000 } };
    it("counts what is held plus what this buy would bring", async () => {
      expect(await rig({ held: 900_000_000n, bought: 150_000_000n }).guard.checkBuy(w, rules, buyOf(A))).toMatchObject({ code: "POSITION_LIMIT" });
      expect(await rig({ held: 900_000_000n, bought: 90_000_000n }).guard.checkBuy(w, rules, buyOf(A))).toBeNull();
    });
    it("does not apply to other coins", async () => {
      expect(await rig({ held: 5_000_000_000n }).guard.checkBuy(w, rules, buyOf(B))).toBeNull();
    });
  });

  it("stops a buy that takes open positions past the dollar limit", async () => {
    const { guard } = rig({ known: [A], values: { [A]: { balance: 1n, value: (9n * SOL) / 10n } } });
    expect(await guard.checkBuy(w, { maxExposureUsd: 140 }, buyOf(B))).toMatchObject({ code: "EXPOSURE_LIMIT" }); // 0.9 SOL held + 0.1 bought = 1.0 SOL = $150
  });

  it("only asks for the SOL price when a rule is in dollars", async () => {
    const { guard, asked } = rig();
    await guard.checkBuy(w, { maxDrawdown: 0.5 }, buyOf(A));
    expect(asked).not.toContain("usd");
  });

  it("fails loudly, not open, when the network cannot be read or the price is missing", async () => {
    await expect(rig({ valuerError: true }).guard.checkBuy(w, { maxDrawdown: 0.5 }, buyOf(A))).rejects.toThrow();
    await expect(rig({ usd: new Error("no price") }).guard.checkBuy(w, { maxDailyLossUsd: 5 }, buyOf(A))).rejects.toThrow();
  });

  it("values a sale for the books, and nothing else", async () => {
    const { guard } = rig();
    const sell = { ok: true as const, kind: "sell" as const, mint: A, spendLamports: 0n, tokenAmount: 50n, minSolOut: 0n, summary: "sell" };
    expect(await guard.valueSell(sell)).toBe(100n);
    expect(await guard.valueSell({ ...sell, tokenAmount: 0n })).toBeNull();
    expect(await guard.valueSell(buyOf(A))).toBeNull();
  });
});
