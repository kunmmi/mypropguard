import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther, type Address, type Hash, type Hex } from "viem";
import { FOUR_MEME_BSC, TOKEN_MANAGER_V2_ABI } from "../src/fourMeme.js";
import { FloatExecutor, FloatTradeRefused, type FloatWalletRecord, type FloatWalletSigner } from "../src/floatExecutor.js";

const FLOAT = "0x1111111111111111111111111111111111111111" as Address;
const MEME = "0x2222222222222222222222222222222222222222" as Address;
const V2 = FOUR_MEME_BSC.tokenManagerV2;

const wallet: FloatWalletRecord = {
  accountId: "acct_1",
  walletId: "privy-wallet-1",
  address: FLOAT,
  limits: { maxBuyWei: parseEther("0.25"), maxBuysPerDay: 3, dailySpendWei: parseEther("0.5"), cooldownSec: 0, frozen: false },
};

const buyData = (funds: bigint): Hex => encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [MEME, funds, 1n] });
const buy = (bnb: string) => ({ to: V2, value: parseEther(bnb), data: buyData(parseEther(bnb)) });

function rig(over: { balance?: bigint; estimate?: bigint | Error; sendDelayMs?: number } = {}) {
  const sent: Array<{ walletId: string; to: Address; value: bigint; gas?: bigint }> = [];
  let n = 0;
  const signer: FloatWalletSigner = {
    async sendTransaction(walletId, tx) {
      if (over.sendDelayMs) await new Promise((r) => setTimeout(r, over.sendDelayMs));
      sent.push({ walletId, to: tx.to, value: tx.value, gas: tx.gas });
      return `0x${(++n).toString(16).padStart(64, "0")}` as Hash;
    },
    async personalSign() {
      return "0x" as Hex;
    },
  };
  const publicClient = {
    getBalance: async () => over.balance ?? parseEther("1"),
    estimateGas: async () => {
      if (over.estimate instanceof Error) throw over.estimate;
      return over.estimate ?? 150_000n;
    },
  };
  return { sent, executor: new FloatExecutor({ publicClient: publicClient as never, signer }) };
}

/** An in-memory usage log standing in for the database. */
function usageLog() {
  const log: Array<{ at: number; spend: bigint }> = [];
  return {
    log,
    io: {
      loadUsage: async () => ({
        buysToday: log.length,
        spentTodayWei: log.reduce((s, x) => s + x.spend, 0n),
        lastBuyAtSec: log.length ? Math.floor(log[log.length - 1]!.at / 1000) : null,
      }),
      onSent: async (decision: { spendWei: bigint; kind: string }) => {
        if (decision.kind === "buy") log.push({ at: Date.now(), spend: decision.spendWei });
      },
    },
  };
}

describe("FloatExecutor", () => {
  it("judges, dry-runs, signs and sends an allowed buy, and reports the timings", async () => {
    const { executor, sent } = rig();
    const u = usageLog();
    const r = await executor.execute(wallet, buy("0.1"), u.io);
    expect(r.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.decision).toMatchObject({ kind: "buy", spendWei: parseEther("0.1") });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ walletId: "privy-wallet-1", to: V2, value: parseEther("0.1") });
    expect(r.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(r.timings).sort()).toEqual(["checkMs", "estimateMs", "sendMs", "totalMs"]);
  });

  it("adds headroom to the gas estimate", async () => {
    const { executor, sent } = rig({ estimate: 100_000n });
    await executor.execute(wallet, buy("0.1"), usageLog().io);
    expect(sent[0]!.gas).toBe(120_000n);
  });

  it("sends NOTHING when a rule refuses, and says which", async () => {
    const { executor, sent } = rig();
    const err = await executor.execute(wallet, buy("0.3"), usageLog().io).catch((e) => e);
    expect(err).toBeInstanceOf(FloatTradeRefused);
    expect(err.code).toBe("MAX_BUY");
    expect(sent).toHaveLength(0);
  });

  it("sends nothing, and spends no fee, when four.meme would reject the trade", async () => {
    const { executor, sent } = rig({ estimate: new Error("execution reverted: slippage") });
    const err = await executor.execute(wallet, buy("0.1"), usageLog().io).catch((e) => e);
    expect(err).toBeInstanceOf(FloatTradeRefused);
    expect(err.code).toBe("WOULD_FAIL");
    expect(err.message).toMatch(/no fee was spent/);
    expect(sent).toHaveLength(0);
  });

  it("does not record a trade that was refused or failed", async () => {
    const { executor } = rig({ estimate: new Error("revert") });
    const u = usageLog();
    await executor.execute(wallet, buy("0.1"), u.io).catch(() => undefined);
    await executor.execute(wallet, buy("0.9"), u.io).catch(() => undefined);
    expect(u.log).toHaveLength(0);
  });

  it("uses the live balance: a buy that would eat the fee reserve is refused", async () => {
    const { executor, sent } = rig({ balance: parseEther("0.1") });
    const err = await executor.execute(wallet, buy("0.1"), usageLog().io).catch((e) => e);
    expect(err.code).toBe("INSUFFICIENT_FLOAT");
    expect(sent).toHaveLength(0);
  });

  it("counts earlier buys: the third buy of a day with a limit of three is allowed, the fourth is not", async () => {
    const { executor } = rig();
    const u = usageLog();
    for (let i = 0; i < 3; i++) await executor.execute(wallet, buy("0.05"), u.io);
    const err = await executor.execute(wallet, buy("0.05"), u.io).catch((e) => e);
    expect(err.code).toBe("MAX_BUYS_PER_DAY");
  });

  it("TWO BUYS AT ONCE cannot both squeeze past the daily limit", async () => {
    // Daily limit 0.5; each buy 0.3. Without the per-wallet lock both would read "0 spent" and both would be sent.
    const w = { ...wallet, limits: { ...wallet.limits, maxBuyWei: parseEther("0.3") } };
    const { executor, sent } = rig({ sendDelayMs: 25 });
    const u = usageLog();
    const results = await Promise.allSettled([executor.execute(w, buy("0.3"), u.io), executor.execute(w, buy("0.3"), u.io)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as FloatTradeRefused).code).toBe("DAILY_SPEND");
    expect(sent).toHaveLength(1);
  });

  it("a failed trade does not block the next one", async () => {
    const { executor, sent } = rig();
    const u = usageLog();
    await executor.execute(wallet, buy("0.9"), u.io).catch(() => undefined);
    await executor.execute(wallet, buy("0.1"), u.io);
    expect(sent).toHaveLength(1);
  });

  it("different wallets do not wait for each other", async () => {
    const { executor } = rig({ sendDelayMs: 200 });
    const other = { ...wallet, address: "0x3333333333333333333333333333333333333333" as Address };
    const t0 = Date.now();
    await Promise.all([executor.execute(wallet, buy("0.05"), usageLog().io), executor.execute(other, buy("0.05"), usageLog().io)]);
    expect(Date.now() - t0).toBeLessThan(380);
  });

  it("sells always go through, even with no float left, and nothing is recorded as a buy", async () => {
    const { executor, sent } = rig({ balance: 0n });
    const u = usageLog();
    const sell = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [MEME, 1_000n] });
    const frozen = { ...wallet, limits: { ...wallet.limits, frozen: true } };
    const r = await executor.execute(frozen, { to: V2, value: 0n, data: sell }, u.io);
    expect(r.decision.kind).toBe("sell");
    expect(sent).toHaveLength(1);
    expect(u.log).toHaveLength(0);
  });

  it("if recording the trade fails, the error surfaces (the trade WAS sent, so the caller must know)", async () => {
    const { executor, sent } = rig();
    const err = await executor
      .execute(wallet, buy("0.1"), { loadUsage: async () => ({ buysToday: 0, spentTodayWei: 0n, lastBuyAtSec: null }), onSent: async () => { throw new Error("db down"); } })
      .catch((e) => e);
    expect(err.message).toBe("db down");
    expect(sent).toHaveLength(1);
  });
});
