import { describe, expect, it } from "vitest";
import { parseEther, type Address, type Hash } from "viem";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { RuleType } from "@mypropguard/domain";
import { buildApp } from "../src/app.js";
import type { FloatDeps } from "../src/routes/float.js";
import type { FloatTradeRecord, FloatWalletRow } from "../src/float/floatStore.js";

const SAFE = "0x7777777777777777777777777777777777777777";
const FLOAT = "0x1111111111111111111111111111111111111111";

function rig() {
  const rows = new Map<string, FloatWalletRow>();
  const trades: FloatTradeRecord[] = [];
  const sent: Array<{ to: Address; value: bigint }> = [];
  const pairs: Array<[string, string]> = [];
  const store: any = {
    get: async (id: string) => rows.get(id),
    create: async (i: any) =>
      void rows.set(i.accountId, {
        accountId: i.accountId,
        walletId: i.walletId,
        address: i.address,
        chainId: i.chainId,
        status: "active",
        maxBuyPct: i.maxBuyPct ?? 25,
        dailySpendPct: i.dailySpendPct ?? 50,
        maxBuysPerDay: i.maxBuysPerDay ?? 10,
        cooldownSec: i.cooldownSec ?? 0,
        frozen: false,
        createdAt: new Date(),
      }),
    updateSettings: async (id: string, p: any) => void rows.set(id, { ...rows.get(id)!, ...p }),
    setFrozen: async (id: string, frozen: boolean) => void (rows.get(id)!.frozen = frozen),
    setStatus: async (id: string, status: "active" | "off") => void (rows.get(id)!.status = status),
    knownTokens: async () => [],
    resetPeak: async () => undefined,
    listTrades: async () => [],
    recordTrade: async (t: FloatTradeRecord) => void trades.push(t),
  };
  const float: FloatDeps = {
    store,
    service: { pair: async (a: string, u: string) => void pairs.push([a, u]), disconnect: async () => undefined, disconnectAccount: async () => undefined } as never,
    createWallet: async () => ({ id: "privy-1", address: FLOAT }),
    signer: { sendTransaction: async (_i, tx) => (sent.push({ to: tx.to, value: tx.value }), `0x${"ab".repeat(32)}` as Hash) },
    publicClient: { getBalance: async () => parseEther("0.5"), getGasPrice: async () => 3_000_000_000n, readContract: async () => 0n, waitForTransactionReceipt: async () => ({}) } as never,
    valuer: { quoteSell: async () => 0n },
    chainId: 56,
    nativeSymbol: "BNB",
  };
  const ledger = new InMemoryRiskLedgerStore();
  const app = buildApp({ store: ledger, float, evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: SAFE, chainId: 56 }) } } });
  const mkAccount = (id: string, chain = 56) =>
    app.inject({ method: "POST", url: "/v1/accounts", payload: { accountId: id, ownerUserId: "u", venue: "bsc-pancakeswap", initialEquity: "1", evmOwnerWalletAddress: "0x9999999999999999999999999999999999999999", evmChainId: chain } });
  const post = (id: string, path: string, payload: unknown = {}) => app.inject({ method: "POST", url: `/v1/accounts/${id}/float/${path}`, payload: payload as never });
  return { app, rows, trades, sent, pairs, mkAccount, post };
}

describe("wallet routes", () => {
  it("reports no wallet yet, then creates one with no amount to choose and sensible limits", async () => {
    const { app, mkAccount, post } = rig();
    await mkAccount("a1");
    expect((await app.inject({ method: "GET", url: "/v1/accounts/a1/float" })).json()).toMatchObject({ available: true, exists: false });
    const created = await post("a1", "create");
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body).toMatchObject({ address: FLOAT, status: "active" });
    expect(body.limits).toEqual({ maxBuyPct: 25, dailySpendPct: 50, maxBuysPerDay: 10, cooldownSec: 0, frozen: false });
    const status = (await app.inject({ method: "GET", url: "/v1/accounts/a1/float" })).json();
    expect(status).toMatchObject({ exists: true, returnsTo: SAFE, balanceWei: parseEther("0.5").toString() });
  });

  it("refuses a second wallet", async () => {
    const { mkAccount, post } = rig();
    await mkAccount("a1");
    expect((await post("a1", "create")).statusCode).toBe(200);
    expect((await post("a1", "create")).statusCode).toBe(409);
  });

  it("needs a protected account on the supported chain", async () => {
    const { mkAccount, post } = rig();
    await mkAccount("other", 1);
    expect((await post("other", "create")).statusCode).toBe(400);
    expect((await post("missing", "create")).statusCode).toBe(404);
  });

  it("changes the limits, validating each", async () => {
    const { mkAccount, post, rows } = rig();
    await mkAccount("a1");
    await post("a1", "create");
    const ok = await post("a1", "settings", { maxBuyPct: 10, dailySpendPct: 30, maxBuysPerDay: 4, cooldownSec: 30 });
    expect(ok.statusCode).toBe(200);
    expect(rows.get("a1")).toMatchObject({ maxBuyPct: 10, dailySpendPct: 30, maxBuysPerDay: 4, cooldownSec: 30 });
    for (const bad of [{ maxBuyPct: 0 }, { maxBuyPct: 101 }, { dailySpendPct: 1.5 }, { maxBuysPerDay: 0 }, { cooldownSec: -1 }, { dailySpendPct: "x" }]) {
      expect((await post("a1", "settings", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("shows the account's own rules that also apply", async () => {
    const { app, mkAccount, post } = rig();
    await mkAccount("a1");
    await post("a1", "create");
    await app.inject({ method: "POST", url: "/v1/accounts/a1/rules", payload: { ruleType: RuleType.MAX_TRADE_FREQUENCY, param: "3" } });
    await app.inject({ method: "POST", url: "/v1/accounts/a1/rules", payload: { ruleType: RuleType.COOLDOWN, param: "45" } });
    const status = (await app.inject({ method: "GET", url: "/v1/accounts/a1/float" })).json();
    expect(status.accountRules).toEqual({ maxTradesPerDay: 3, cooldownSec: 45, value: {} });
  });

  it("pauses and resumes buying", async () => {
    const { mkAccount, post, rows } = rig();
    await mkAccount("a1");
    await post("a1", "create");
    await post("a1", "freeze", { frozen: true });
    expect(rows.get("a1")!.frozen).toBe(true);
    await post("a1", "freeze", { frozen: false });
    expect(rows.get("a1")!.frozen).toBe(false);
  });

  it("connects a site, only while switched on", async () => {
    const { mkAccount, post, pairs } = rig();
    await mkAccount("a1");
    expect((await post("a1", "pair", { uri: "wc:x" })).statusCode).toBe(409);
    await post("a1", "create");
    expect((await post("a1", "pair", { uri: "wc:abc" })).statusCode).toBe(200);
    expect(pairs).toEqual([["a1", "wc:abc"]]);
    expect((await post("a1", "pair", {})).statusCode).toBe(400);
  });

  it("returns the funds ONLY to the owner's own account", async () => {
    const { mkAccount, post, sent, trades } = rig();
    await mkAccount("a1");
    await post("a1", "create");
    const r = await post("a1", "sweep");
    expect(r.statusCode).toBe(200);
    expect(r.json().returnedTo).toBe(SAFE);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(SAFE);
    expect(trades.at(-1)).toMatchObject({ kind: "sweep", toAddress: expect.stringMatching(/^0x7777/i), result: "SENT" });
  });

  it("switching off stops the wallet answering sites first, then returns the funds", async () => {
    const { mkAccount, post, rows, sent } = rig();
    await mkAccount("a1");
    await post("a1", "create");
    const r = await post("a1", "off");
    expect(r.statusCode).toBe(200);
    expect(rows.get("a1")!.status).toBe("off");
    expect(sent).toHaveLength(1);
    expect((await post("a1", "pair", { uri: "wc:abc" })).statusCode).toBe(409);
    await post("a1", "on");
    expect(rows.get("a1")!.status).toBe("active");
  });
});
