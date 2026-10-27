import { describe, expect, it } from "vitest";
import { BONDING_CURVE_DISCRIMINATOR, SolanaValuer, bondingCurveAddress, curveBuyQuote, curveSellQuote, decodeBondingCurve, WSOL_MINT } from "../src/index.js";

const SOL = 1_000_000_000n;
const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const CURVE_MINT = "So11111111111111111111111111111111111111112".replace("2", "3"); // any valid base58 key
const GRAD_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEAD_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Bytes of a bonding curve account, laid out as pump.fun's IDL says. */
function curveBytes(c: { vt: bigint; vq: bigint; rt: bigint; rq: bigint; supply: bigint; complete: boolean }): Uint8Array {
  const b = Buffer.alloc(8 + 5 * 8 + 1 + 100);
  Buffer.from(BONDING_CURVE_DISCRIMINATOR, "hex").copy(b);
  b.writeBigUInt64LE(c.vt, 8);
  b.writeBigUInt64LE(c.vq, 16);
  b.writeBigUInt64LE(c.rt, 24);
  b.writeBigUInt64LE(c.rq, 32);
  b.writeBigUInt64LE(c.supply, 40);
  b[48] = c.complete ? 1 : 0;
  return b;
}
const CURVE = { vt: 1_000_000_000_000_000n, vq: 30n * SOL, rt: 800_000_000_000_000n, rq: 0n, supply: 1_000_000_000_000_000n, complete: false };

describe("pump.fun's bonding curve", () => {
  it("reads the account the way the IDL lays it out", () => {
    expect(decodeBondingCurve(curveBytes(CURVE))).toEqual({ virtualTokenReserves: CURVE.vt, virtualQuoteReserves: CURVE.vq, realTokenReserves: CURVE.rt, realQuoteReserves: 0n, tokenTotalSupply: CURVE.supply, complete: false });
    expect(decodeBondingCurve(curveBytes({ ...CURVE, complete: true }))!.complete).toBe(true);
  });

  it("refuses bytes that are not a bonding curve", () => {
    expect(decodeBondingCurve(new Uint8Array(10))).toBeUndefined();
    expect(decodeBondingCurve(new Uint8Array(200))).toBeUndefined();
  });

  it("quotes a sale by constant-product maths, less the 1.25% fee", () => {
    const curve = decodeBondingCurve(curveBytes(CURVE))!;
    const amount = 10_000_000_000_000n; // 1% of supply
    const gross = (amount * curve.virtualQuoteReserves) / (curve.virtualTokenReserves + amount);
    expect(curveSellQuote(curve, amount)).toBe((gross * 9875n) / 10_000n);
    expect(curveSellQuote(curve, 0n)).toBe(0n);
  });

  it("a bigger sale returns more, but less than proportionally (price impact)", () => {
    const curve = decodeBondingCurve(curveBytes(CURVE))!;
    const small = curveSellQuote(curve, 10_000_000_000_000n);
    const large = curveSellQuote(curve, 100_000_000_000_000n);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(small * 10n);
  });

  it("buying then selling the tokens never returns more than was spent", () => {
    const curve = decodeBondingCurve(curveBytes(CURVE))!;
    for (const spend of [SOL / 100n, SOL / 2n, 5n * SOL]) {
      const tokens = curveBuyQuote(curve, spend);
      expect(tokens).toBeGreaterThan(0n);
      expect(curveSellQuote(curve, tokens)).toBeLessThan(spend);
    }
  });

  it("never quotes more tokens than the curve has left to sell", () => {
    const curve = decodeBondingCurve(curveBytes({ ...CURVE, rt: 1000n }))!;
    expect(curveBuyQuote(curve, 1000n * SOL)).toBe(1000n);
  });
});

function valuer(over: { down?: boolean; price?: unknown } = {}) {
  const calls: string[] = [];
  const accounts = new Map<string, Uint8Array>([
    [bondingCurveAddress(CURVE_MINT), curveBytes(CURVE)],
    [bondingCurveAddress(GRAD_MINT), curveBytes({ ...CURVE, complete: true })],
  ]);
  const balances: Record<string, bigint> = { [CURVE_MINT]: 10_000_000_000_000n, [GRAD_MINT]: 500n, [DEAD_MINT]: 70n };
  const rpc = {
    getBalance: async () => SOL / 2n,
    getAccountData: async (address: string) => {
      if (over.down) throw new Error("rpc down");
      return accounts.get(address) ?? null;
    },
    getTokenBalance: async (_owner: string, mint: string) => balances[mint] ?? 0n,
  };
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (over.down) throw new Error("fetch failed");
    if (url.includes("/price/v3")) return { ok: true, status: 200, json: async () => over.price ?? { [WSOL_MINT]: { usdPrice: 150 } }, text: async () => "" };
    const mint = new URL(url).searchParams.get("inputMint");
    if (mint === DEAD_MINT) return { ok: false, status: 400, json: async () => ({}), text: async () => "no route" };
    return { ok: true, status: 200, json: async () => ({ outAmount: "7000", inAmount: "500" }), text: async () => "" };
  };
  return { calls, v: new SolanaValuer(rpc, fetchImpl as never) };
}

describe("valuing the wallet's holdings", () => {
  it("prices a coin still on the curve from the curve itself, without calling Jupiter", async () => {
    const { v, calls } = valuer();
    const out = await v.quoteSell(CURVE_MINT, 10_000_000_000_000n);
    expect(out).toBeGreaterThan(0n);
    expect(calls).toEqual([]);
  });

  it("prices a graduated coin with a Jupiter quote", async () => {
    const { v, calls } = valuer();
    expect(await v.quoteSell(GRAD_MINT, 500n)).toBe(7000n);
    expect(calls[0]).toContain("/swap/v1/quote");
  });

  it("a coin with no route is worth zero, not an error", async () => {
    expect(await valuer().v.quoteSell(DEAD_MINT, 70n)).toBe(0n);
  });

  it("an unreachable network is an error, never a silent zero", async () => {
    await expect(valuer({ down: true }).v.quoteSell(CURVE_MINT, 1n)).rejects.toThrow(/rpc down/);
  });

  it("totals the SOL and every named position", async () => {
    const h = await valuer().v.holdings(WALLET, [CURVE_MINT, GRAD_MINT, DEAD_MINT]);
    expect(h.solLamports).toBe(SOL / 2n);
    expect(h.positions.map((p) => p.valueLamports)).toEqual([expect.any(BigInt), 7000n, 0n]);
    expect(h.equityLamports).toBe(h.solLamports + h.positionsLamports);
  });

  it("an empty position costs no price lookup", async () => {
    const { v, calls } = valuer();
    expect(await v.quoteSell(GRAD_MINT, 0n)).toBe(0n);
    expect(calls).toEqual([]);
  });

  it("estimates the tokens a buy brings on the curve, and none off it", async () => {
    const { v } = valuer();
    expect(await v.quoteBuy(CURVE_MINT, SOL)).toBeGreaterThan(0n);
    expect(await v.quoteBuy(GRAD_MINT, SOL)).toBe(0n);
  });

  it("reads the SOL price in dollars, and says so when it cannot", async () => {
    expect(await valuer().v.usdPerSol()).toBe(150);
    await expect(valuer({ price: {} }).v.usdPerSol()).rejects.toThrow(/unavailable/);
    await expect(valuer({ price: { [WSOL_MINT]: { usdPrice: 0 } } }).v.usdPerSol()).rejects.toThrow(/unavailable/);
  });
});
