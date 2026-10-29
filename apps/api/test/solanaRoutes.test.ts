import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { RuleType } from "@mypropguard/domain";
import { WSOL_MINT } from "@mypropguard/solana";
import { buildApp } from "../src/app.js";
import type { SolanaDeps } from "../src/routes/solana.js";
import type { SolanaRequestRecord, SolanaWalletRow } from "../src/solana/solanaStore.js";
import type { LinkedSession } from "../src/oneClick/oneClickStore.js";

const ADDRESS = Keypair.generate().publicKey.toBase58();
const OWNER = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58(); // a different address someone asks to switch withdrawals to
const MINT = Keypair.generate().publicKey.toBase58();
const SOL = 1_000_000_000n;

function rig(opts: { withNetwork?: boolean } = {}) {
  const withNetwork = opts.withNetwork ?? true;
  const rows = new Map<string, SolanaWalletRow>();
  const requests: SolanaRequestRecord[] = [];
  const pairs: unknown[][] = [];
  const disconnected: string[] = [];
  const offFor: unknown[][] = [];
  const sentTransactions: string[] = [];
  let peakReset = 0;
  const sessions: LinkedSession[] = [
    { topic: "sol-1", accountId: "a1", kind: "solana", dappName: "pump.fun", dappUrl: "https://pump.fun", createdAt: new Date(), expiresAt: null },
    { topic: "safe-1", accountId: "a1", kind: "safe", dappName: "PancakeSwap", dappUrl: null, createdAt: new Date(), expiresAt: null },
    { topic: "sol-other", accountId: "a2", kind: "solana", dappName: "pump.fun", dappUrl: null, createdAt: new Date(), expiresAt: null },
  ];
  const store: any = {
    get: async (id: string) => rows.get(id),
    create: async (i: any) =>
      void rows.set(i.accountId, { accountId: i.accountId, walletId: i.walletId, address: i.address, status: "active", maxBuyPct: 25, dailySpendPct: 50, maxBuysPerDay: 10, cooldownSec: 0, frozen: false, withdrawalAddress: null, pendingWithdrawalAddress: null, pendingWithdrawalAt: null, createdAt: new Date() }),
    setStatus: async (id: string, status: "active" | "off") => void (rows.get(id)!.status = status),
    setFrozen: async (id: string, frozen: boolean) => void (rows.get(id)!.frozen = frozen),
    updateSettings: async (id: string, p: any) => void rows.set(id, { ...rows.get(id)!, ...p }),
    // As the real store does (tested on Postgres in solanaStore.pglite.test.ts): the first address applies at once, a
    // different one waits 24 hours, and the current one again cancels the wait.
    setWithdrawalAddress: async (id: string, a: string) => {
      const r = rows.get(id)!;
      const now = !r.withdrawalAddress || r.withdrawalAddress === a;
      r.withdrawalAddress = r.withdrawalAddress ?? a;
      r.pendingWithdrawalAddress = now ? null : a;
      r.pendingWithdrawalAt = now ? null : new Date(Date.now() + 24 * 3600_000);
    },
    knownMints: async () => [MINT],
    resetPeak: async () => void peakReset++,
    recordRequest: async (r: SolanaRequestRecord) => void requests.push(r),
    listRequests: async () => requests.map((r) => ({ createdAt: new Date(), ...r, code: r.code ?? null, message: r.message ?? null, detail: r.detail ?? null, tradeKind: r.tradeKind ?? null, mint: r.mint ?? null, lamports: r.lamports === undefined || r.lamports === null ? null : String(r.lamports), signature: r.signature ?? null, totalMs: null })),
  };
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  const solana: SolanaDeps = {
    store,
    service: {
      pair: async (...a: unknown[]) => void pairs.push(a),
      disconnect: async (t: string) => void disconnected.push(t),
      disconnectAccount: async (...a: unknown[]) => void offFor.push(a),
    } as never,
    createWallet: async () => ({ id: "privy-sol", address: ADDRESS }),
    tradingEnabled: true,
    ...(withNetwork
      ? {
          rpc: {
            getBalance: async () => 2n * SOL,
            getTokenBalance: async (_owner: string, mint: string) => (mint === WSOL_MINT ? 0n : 500n),
            getAccountData: async () => mintData,
            getAccountOwner: async () => "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            getLatestBlockhash: async () => "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k",
            sendRaw: async (tx: string) => (sentTransactions.push(tx), `SIG${sentTransactions.length}`),
            confirm: async () => undefined,
          },
          signer: { signTransaction: async (_id: string, tx: string) => tx },
          valuer: {
            holdings: async () => ({ solLamports: 2n * SOL, positions: [{ mint: MINT, balance: 500n, valueLamports: 7000n }], positionsLamports: 7000n, equityLamports: 2n * SOL + 7000n }),
            quoteSell: async (_m: string, amount: bigint) => amount * 3n,
          },
        }
      : {}),
  };
  const oneClick: any = { store: { listSessions: async (id: string) => sessions.filter((s) => s.accountId === id), getSession: async (t: string) => sessions.find((s) => s.topic === t) } };
  const app = buildApp({ store: new InMemoryRiskLedgerStore(), solana, oneClick });
  const mk = (id: string) => app.inject({ method: "POST", url: "/v1/accounts", payload: { accountId: id, ownerUserId: "u", initialEquity: "1" } });
  const post = (id: string, path: string, payload: unknown = {}) => app.inject({ method: "POST", url: `/v1/accounts/${id}/solana/${path}`, payload: payload as never });
  const get = (id: string) => app.inject({ method: "GET", url: `/v1/accounts/${id}/solana` });
  return { app, rows, requests, pairs, disconnected, offFor, sentTransactions, mk, post, get, peakResets: () => peakReset };
}

describe("Solana wallet routes", () => {
  it("reports no wallet yet, then creates one and returns its address", async () => {
    const { mk, post, get } = rig();
    await mk("a1");
    expect((await get("a1")).json()).toEqual({ available: true, exists: false });
    expect((await post("a1", "create")).json()).toEqual({ ok: true, address: ADDRESS, status: "active" });
    expect((await get("a1")).json()).toMatchObject({ exists: true, address: ADDRESS, status: "active", tradingEnabled: true });
  });

  it("shows the balance, holdings and limits", async () => {
    const { mk, post, get } = rig();
    await mk("a1");
    await post("a1", "create");
    const body = (await get("a1")).json();
    expect(body.balanceLamports).toBe((2n * SOL).toString());
    expect(body.holdings).toEqual([{ mint: MINT, balance: "500", valueLamports: "7000" }]);
    expect(body.limits).toEqual({ maxBuyPct: 25, dailySpendPct: 50, maxBuysPerDay: 10, cooldownSec: 0, frozen: false });
    expect(body.withdrawalAddress).toBeNull();
  });

  it("still loads the page when the network cannot be read", async () => {
    const { mk, post, get, rows } = rig({ withNetwork: false });
    await mk("a1");
    await post("a1", "create");
    expect(rows.size).toBe(1);
    const body = (await get("a1")).json();
    expect(body).toMatchObject({ exists: true, balanceLamports: null, holdings: [] });
  });

  it("refuses a second wallet, and an account that does not exist", async () => {
    const { mk, post } = rig();
    await mk("a1");
    await post("a1", "create");
    expect((await post("a1", "create")).statusCode).toBe(409);
    expect((await post("ghost", "create")).statusCode).toBe(404);
  });

  it("lists only this account's Solana links, not its Safe links or anyone else's", async () => {
    const { mk, post, get } = rig();
    await mk("a1");
    await post("a1", "create");
    expect((await get("a1")).json().links.map((l: { topic: string }) => l.topic)).toEqual(["sol-1"]);
  });

  it("shows what sites asked for, with the decoded detail and the trade's figures", async () => {
    const { mk, post, get, requests } = rig();
    await mk("a1");
    await post("a1", "create");
    requests.push({ accountId: "a1", dappName: "pump.fun", kind: "transaction", method: "solana_signTransaction", result: "SIGNED", message: "buy", tradeKind: "buy", mint: MINT, lamports: SOL / 10n, signature: "sig", detail: { transactions: [] } });
    expect((await get("a1")).json().requests[0]).toMatchObject({ kind: "transaction", result: "SIGNED", tradeKind: "buy", mint: MINT, lamports: (SOL / 10n).toString(), signature: "sig", detail: { transactions: [] } });
  });

  it("shows the account rules that also apply to this wallet", async () => {
    const { app, mk, post, get } = rig();
    await mk("a1");
    await post("a1", "create");
    await app.inject({ method: "POST", url: "/v1/accounts/a1/rules", payload: { ruleType: RuleType.MAX_TRADE_FREQUENCY, param: "3" } });
    await app.inject({ method: "POST", url: "/v1/accounts/a1/rules", payload: { ruleType: RuleType.MAX_DAILY_LOSS, param: "50" } });
    expect((await get("a1")).json().accountRules).toEqual({ maxTradesPerDay: 3, value: { maxDailyLossUsd: 50 } });
  });

  it("changes the limits, validating each", async () => {
    const { mk, post, rows } = rig();
    await mk("a1");
    await post("a1", "create");
    expect((await post("a1", "settings", { maxBuyPct: 10, dailySpendPct: 30, maxBuysPerDay: 4, cooldownSec: 30 })).statusCode).toBe(200);
    expect(rows.get("a1")).toMatchObject({ maxBuyPct: 10, dailySpendPct: 30, maxBuysPerDay: 4, cooldownSec: 30 });
    for (const bad of [{ maxBuyPct: 0 }, { maxBuyPct: 101 }, { dailySpendPct: 1.5 }, { maxBuysPerDay: 0 }, { cooldownSec: -1 }, { dailySpendPct: "x" }]) {
      expect((await post("a1", "settings", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post("ghost", "settings", {})).statusCode).toBe(404);
  });

  it("pauses and resumes buying", async () => {
    const { mk, post, rows } = rig();
    await mk("a1");
    await post("a1", "create");
    await post("a1", "freeze", { frozen: true });
    expect(rows.get("a1")!.frozen).toBe(true);
    await post("a1", "freeze", { frozen: false });
    expect(rows.get("a1")!.frozen).toBe(false);
  });

  it("connects a site as a Solana link, only while switched on", async () => {
    const { mk, post, pairs } = rig();
    await mk("a1");
    expect((await post("a1", "pair", { uri: "wc:x" })).statusCode).toBe(409);
    await post("a1", "create");
    expect((await post("a1", "pair", { uri: "wc:abc" })).statusCode).toBe(200);
    expect(pairs).toEqual([["a1", "wc:abc", "solana"]]);
    expect((await post("a1", "pair", {})).statusCode).toBe(400);
  });

  it("disconnects only a Solana link that belongs to this account", async () => {
    const { mk, post, disconnected } = rig();
    await mk("a1");
    expect((await post("a1", "disconnect", { topic: "sol-1" })).statusCode).toBe(200);
    expect((await post("a1", "disconnect", { topic: "safe-1" })).statusCode).toBe(404);
    expect((await post("a1", "disconnect", { topic: "sol-other" })).statusCode).toBe(404);
    expect((await post("a1", "disconnect", {})).statusCode).toBe(400);
    expect(disconnected).toEqual(["sol-1"]);
  });
});

describe("withdrawing", () => {
  it("accepts a valid address that is not the wallet's own", async () => {
    const { mk, post, rows } = rig();
    await mk("a1");
    await post("a1", "create");
    expect((await post("a1", "withdrawal-address", { address: OWNER })).statusCode).toBe(200);
    expect(rows.get("a1")!.withdrawalAddress).toBe(OWNER);
    for (const address of ["nonsense", ADDRESS, 42, "x".repeat(80), undefined]) {
      expect((await post("a1", "withdrawal-address", { address })).statusCode, String(address)).toBe(400);
    }
    expect(rows.get("a1")!.withdrawalAddress).toBe(OWNER);
  });

  it("applies the first address at once", async () => {
    const { mk, post, get } = rig();
    await mk("a1");
    await post("a1", "create");
    const r = (await post("a1", "withdrawal-address", { address: OWNER })).json();
    expect(r).toMatchObject({ ok: true, withdrawalAddress: OWNER, pendingWithdrawalAddress: null, pendingWithdrawalAt: null, message: expect.stringMatching(/Withdrawals go to this address/) });
    expect((await get("a1")).json()).toMatchObject({ withdrawalAddress: OWNER, pendingWithdrawalAddress: null });
  });

  it("makes a changed address wait 24 hours, shows it, and keeps withdrawing to the current one meanwhile", async () => {
    const { mk, post, get } = rig();
    await mk("a1");
    await post("a1", "create");
    await post("a1", "withdrawal-address", { address: OWNER });
    const r = (await post("a1", "withdrawal-address", { address: OTHER })).json();
    expect(r).toMatchObject({ ok: true, withdrawalAddress: OWNER, pendingWithdrawalAddress: OTHER, message: expect.stringMatching(/after 24 hours/) });
    expect(new Date(r.pendingWithdrawalAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect((await get("a1")).json()).toMatchObject({ withdrawalAddress: OWNER, pendingWithdrawalAddress: OTHER, pendingWithdrawalAt: r.pendingWithdrawalAt });
    // Someone who got into the login cannot empty the wallet to their own address: it still goes to the owner's.
    expect((await post("a1", "withdraw")).json().to).toBe(OWNER);
  });

  it("cancels a waiting change when the current address is saved again", async () => {
    const { mk, post, get } = rig();
    await mk("a1");
    await post("a1", "create");
    await post("a1", "withdrawal-address", { address: OWNER });
    await post("a1", "withdrawal-address", { address: OTHER });
    const r = (await post("a1", "withdrawal-address", { address: OWNER })).json();
    expect(r).toMatchObject({ withdrawalAddress: OWNER, pendingWithdrawalAddress: null, message: expect.stringMatching(/cancelled/) });
    expect((await get("a1")).json()).toMatchObject({ withdrawalAddress: OWNER, pendingWithdrawalAddress: null, pendingWithdrawalAt: null });
  });

  it("will not withdraw before an address is set", async () => {
    const { mk, post, sentTransactions } = rig();
    await mk("a1");
    await post("a1", "create");
    const r = await post("a1", "withdraw");
    expect(r.statusCode).toBe(409);
    expect(r.json().message).toMatch(/Set your withdrawal address first/);
    expect(sentTransactions).toHaveLength(0);
  });

  it("sends the coins and the SOL to the owner's address, records each, and resets the high-water mark", async () => {
    const { mk, post, requests, sentTransactions, peakResets } = rig();
    await mk("a1");
    await post("a1", "create");
    await post("a1", "withdrawal-address", { address: OWNER });
    const r = await post("a1", "withdraw");
    expect(r.statusCode).toBe(200);
    expect(r.json().to).toBe(OWNER);
    expect(r.json().items.map((i: { asset: string }) => i.asset)).toEqual([MINT, "SOL"]);
    expect(sentTransactions).toHaveLength(2);
    const sweeps = requests.filter((x) => x.kind === "sweep");
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0]).toMatchObject({ result: "SIGNED", mint: MINT, proceedsLamports: 1500n });
    expect(sweeps[1]).toMatchObject({ result: "SIGNED", lamports: 2n * SOL - 5000n });
    expect(peakResets()).toBe(1);
  });

  it("is unavailable when the server has no network connection configured", async () => {
    const { mk, post } = rig({ withNetwork: false });
    await mk("a1");
    await post("a1", "create");
    await post("a1", "withdrawal-address", { address: OWNER });
    expect((await post("a1", "withdraw")).statusCode).toBe(503);
  });

  it("switching off stops the wallet first, then withdraws if an address is set", async () => {
    const { mk, post, rows, offFor, sentTransactions } = rig();
    await mk("a1");
    await post("a1", "create");
    expect((await post("a1", "off")).statusCode).toBe(200);
    expect(rows.get("a1")!.status).toBe("off");
    expect(offFor).toEqual([["a1", "solana"]]);
    expect(sentTransactions).toHaveLength(0); // no address: only switched off
    await post("a1", "on");
    await post("a1", "withdrawal-address", { address: OWNER });
    await post("a1", "off");
    expect(sentTransactions).toHaveLength(2);
    expect((await post("a1", "pair", { uri: "wc:abc" })).statusCode).toBe(409);
    await post("a1", "on");
    expect(rows.get("a1")!.status).toBe("active");
  });
});
