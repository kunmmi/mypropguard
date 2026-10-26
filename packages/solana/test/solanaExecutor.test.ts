import { describe, expect, it } from "vitest";
import { SOL, W, pumpIx, txBase64 } from "./helpers.js";
import { SolanaExecutor, SolanaTradeRefused, type SolanaWalletRecord, type SolanaWalletSigner } from "../src/index.js";

const wallet: SolanaWalletRecord = {
  accountId: "acct_1",
  walletId: "privy-sol-1",
  address: W,
  limits: { maxBuysPerDay: 3, cooldownSec: 0, frozen: false },
  percentOfBalance: { maxBuyPct: 25, dailySpendPct: 50 },
};
const buy = (spendSol = "0.1") => txBase64([pumpIx("buy_v3", { u64: [1n, BigInt(Math.round(Number(spendSol) * 1e9))] })]);
const sell = () => txBase64([pumpIx("sell_v3", { u64: [5_000n, 0n] })]);

function rig(over: { balance?: bigint; simulation?: { err: unknown | null; logs: string[] } | Error; sendDelayMs?: number } = {}) {
  const signed: string[] = [];
  const sent: string[] = [];
  const signer: SolanaWalletSigner = {
    async signTransaction(_id, txBase64) {
      if (over.sendDelayMs) await new Promise((r) => setTimeout(r, over.sendDelayMs));
      signed.push(txBase64);
      return txBase64; // signature slot stays zeros: enough to test the flow
    },
  };
  const rpc = {
    getBalance: async () => over.balance ?? SOL,
    simulate: async () => {
      if (over.simulation instanceof Error) throw over.simulation;
      return over.simulation ?? { err: null, logs: [] };
    },
    sendRaw: async (tx: string) => (sent.push(tx), "SENTSIG1111111111111111111111111111111111111111111111111111111111111111111111"),
  };
  return { signed, sent, executor: new SolanaExecutor({ rpc, signer }) };
}

/** An in-memory usage log standing in for the database. */
function usageLog() {
  const log: Array<{ at: number; spend: bigint }> = [];
  return {
    log,
    io: {
      loadUsage: async () => ({ buysToday: log.length, spentTodayLamports: log.reduce((s, x) => s + x.spend, 0n), lastBuyAtSec: log.length ? Math.floor(log[log.length - 1]!.at / 1000) : null }),
      onDone: async (decision: { kind: string; spendLamports: bigint }) => {
        if (decision.kind === "buy") log.push({ at: Date.now(), spend: decision.spendLamports });
      },
    },
  };
}

describe("signing a trade", () => {
  it("signs an allowed buy, answers with a signature, and records it", async () => {
    const { executor, signed } = rig();
    const u = usageLog();
    const r = await executor.execute(wallet, buy(), "sign", u.io);
    expect(r.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,90}$/);
    expect(r.decision).toMatchObject({ kind: "buy", spendLamports: SOL / 10n });
    expect(signed).toHaveLength(1);
    expect(u.log).toHaveLength(1);
    expect(r.timings).toMatchObject({ checkMs: expect.any(Number), simulateMs: expect.any(Number), signMs: expect.any(Number), totalMs: expect.any(Number) });
  });

  it("for signAndSend, sends it too and answers with the network's signature", async () => {
    const { executor, sent } = rig();
    const r = await executor.execute(wallet, buy(), "signAndSend", usageLog().io);
    expect(sent).toHaveLength(1);
    expect(r.signature).toMatch(/^SENTSIG/);
  });

  it("for sign only, does NOT send it (the site does)", async () => {
    const { executor, sent } = rig();
    await executor.execute(wallet, buy(), "sign", usageLog().io);
    expect(sent).toHaveLength(0);
  });

  it("judges limits as a share of the wallet's SOL: 25% of 1 SOL per buy", async () => {
    const { executor } = rig({ balance: SOL });
    await expect(executor.execute(wallet, buy("0.26"), "sign", usageLog().io)).rejects.toMatchObject({ code: "MAX_BUY" });
    expect((await executor.execute(wallet, buy("0.25"), "sign", usageLog().io)).signature).toBeDefined();
    const small = rig({ balance: SOL / 5n });
    await expect(small.executor.execute(wallet, buy("0.1"), "sign", usageLog().io)).rejects.toMatchObject({ code: "MAX_BUY" });
  });

  it("counts earlier buys: the limit is three a day", async () => {
    const { executor } = rig();
    const u = usageLog();
    for (let i = 0; i < 3; i++) await executor.execute(wallet, buy("0.05"), "sign", u.io);
    await expect(executor.execute(wallet, buy("0.05"), "sign", u.io)).rejects.toMatchObject({ code: "MAX_BUYS_PER_DAY" });
  });

  it("buys fired together cannot both pass the daily limit", async () => {
    const { executor, signed } = rig({ sendDelayMs: 20 });
    const u = usageLog();
    const w = { ...wallet, percentOfBalance: { maxBuyPct: 40, dailySpendPct: 40 }, limits: { ...wallet.limits, maxBuysPerDay: 9 } };
    const results = await Promise.allSettled([executor.execute(w, buy("0.3"), "sign", u.io), executor.execute(w, buy("0.3"), "sign", u.io)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(signed).toHaveLength(1);
  });

  it("a sell goes through when buying is paused and the wallet has no SOL", async () => {
    const { executor, signed } = rig({ balance: 0n });
    const frozen = { ...wallet, limits: { ...wallet.limits, frozen: true } };
    const u = usageLog();
    const r = await executor.execute(frozen, sell(), "sign", u.io);
    expect(r.decision.kind).toBe("sell");
    expect(signed).toHaveLength(1);
    expect(u.log).toHaveLength(0);
  });
});

describe("what it will not sign", () => {
  it("anything the policy refuses, with the policy's reason, and nothing is signed or sent", async () => {
    const { executor, signed, sent } = rig();
    const err = await executor.execute(wallet, txBase64([pumpIx("buy_v3"), pumpIx("buy_v3")]), "signAndSend", usageLog().io).catch((e) => e);
    expect(err).toBeInstanceOf(SolanaTradeRefused);
    expect(err.code).toBe("MULTIPLE_TRADES");
    expect(signed).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("bytes that are not a transaction", async () => {
    const { executor, signed } = rig();
    const err = await executor.execute(wallet, Buffer.from("definitely not a transaction, honest").toString("base64"), "sign", usageLog().io).catch((e) => e);
    expect(err).toBeInstanceOf(SolanaTradeRefused);
    expect(signed).toHaveLength(0);
  });

  it("a trade pump.fun would reject, stopped before any fee is spent", async () => {
    const { executor, signed } = rig({ simulation: { err: { InstructionError: [1, { Custom: 6003 }] }, logs: ["Program log: Error: slippage exceeded"] } });
    const err = await executor.execute(wallet, buy(), "sign", usageLog().io).catch((e) => e);
    expect(err.code).toBe("WOULD_FAIL");
    expect(err.message).toMatch(/no fee was spent.*slippage/i);
    expect(signed).toHaveLength(0);
  });

  it("a trade it could not check against the network", async () => {
    const { executor, signed } = rig({ simulation: new Error("rpc down") });
    const err = await executor.execute(wallet, buy(), "sign", usageLog().io).catch((e) => e);
    expect(err.code).toBe("WOULD_FAIL");
    expect(err.message).toMatch(/Could not check/);
    expect(signed).toHaveLength(0);
  });
});

describe("rules that depend on the wallet's value", () => {
  it("a buy the value check refuses is never simulated or signed", async () => {
    const { executor, signed } = rig();
    const u = usageLog();
    const err = await executor.execute(wallet, buy(), "sign", { ...u.io, beforeBuy: async () => ({ code: "LOSS_LIMIT", message: "You are down too much today." }) }).catch((e) => e);
    expect(err.code).toBe("LOSS_LIMIT");
    expect(signed).toHaveLength(0);
    expect(u.log).toHaveLength(0);
  });

  it("if the value check cannot run, the buy is stopped, not waved through", async () => {
    const { executor, signed } = rig();
    const err = await executor
      .execute(wallet, buy(), "sign", {
        ...usageLog().io,
        beforeBuy: async () => {
          throw new Error("price down");
        },
      })
      .catch((e) => e);
    expect(err.code).toBe("VALUE_UNAVAILABLE");
    expect(err.message).toMatch(/Selling still works/);
    expect(signed).toHaveLength(0);
  });

  it("is never asked for a sell, so a sell cannot be blocked by it", async () => {
    const { executor, signed } = rig();
    let asked = false;
    await executor.execute(wallet, sell(), "sign", { ...usageLog().io, beforeBuy: async () => ((asked = true), { code: "LOSS_LIMIT" as const, message: "no" }) });
    expect(asked).toBe(false);
    expect(signed).toHaveLength(1);
  });

  it("values a sell for the books, and a failed valuation never stops it", async () => {
    const { executor } = rig();
    let proceeds: bigint | null = -1n;
    await executor.execute(wallet, sell(), "sign", { ...usageLog().io, valueSell: async () => 42n, onDone: async (_d, _r, _t, meta) => void (proceeds = meta.proceedsLamports) });
    expect(proceeds).toBe(42n);
    await executor.execute(wallet, sell(), "sign", {
      ...usageLog().io,
      valueSell: async () => {
        throw new Error("quote failed");
      },
      onDone: async (_d, _r, _t, meta) => void (proceeds = meta.proceedsLamports),
    });
    expect(proceeds).toBeNull();
  });
});
