/**
 * The Solana wallet's storage, on a real Postgres engine (PGlite) using the REAL migration files.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SolanaStore, solanaDayStart } from "../src/solana/solanaStore.js";
import { OneClickStore } from "../src/oneClick/oneClickStore.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "supabase", "migrations");

let db: PGlite;
let pool: pg.Pool;
let store: SolanaStore;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create table protected_accounts (account_id text primary key);");
  for (const file of ["0012_one_click_trading.sql", "0013_float_wallet.sql", "0014_solana_wallet.sql", "0015_solana_trading.sql", "0016_solana_withdrawal_delay.sql"]) {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf-8"));
  }
  pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) } as unknown as pg.Pool;
  store = new SolanaStore(pool);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec("truncate sol_requests, sol_risk, sol_wallets, evm_wc_sessions; delete from protected_accounts;");
  await db.exec("insert into protected_accounts (account_id) values ('acct_1'), ('acct_2');");
});

const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const create = (accountId = "acct_1") => store.create({ accountId, walletId: `privy-${accountId}`, address: ADDRESS });

describe("the Solana wallet record", () => {
  it("stores and reads back the wallet, active to begin with", async () => {
    await create();
    expect(await store.get("acct_1")).toMatchObject({ accountId: "acct_1", walletId: "privy-acct_1", address: ADDRESS, status: "active" });
  });

  it("returns undefined for an account with no wallet", async () => {
    expect(await store.get("acct_2")).toBeUndefined();
  });

  it("creating twice does not overwrite the first (one wallet per account)", async () => {
    await create();
    await store.create({ accountId: "acct_1", walletId: "SECOND", address: "x" });
    expect((await store.get("acct_1"))!.walletId).toBe("privy-acct_1");
  });

  it("switches off and on, and refuses an unknown status", async () => {
    await create();
    await store.setStatus("acct_1", "off");
    expect((await store.get("acct_1"))!.status).toBe("off");
    await store.setStatus("acct_1", "active");
    expect((await store.get("acct_1"))!.status).toBe("active");
    await expect(db.exec("update sol_wallets set status = 'maybe'")).rejects.toThrow();
  });
});

describe("the request log", () => {
  beforeEach(async () => {
    await create();
  });

  it("keeps what each request was, with its readable detail, newest first", async () => {
    await store.recordRequest({ accountId: "acct_1", dappName: "pump.fun", kind: "login", method: "solana_signMessage", result: "SIGNED", message: "signed a login", detail: { text: "Sign in" } });
    await store.recordRequest({
      accountId: "acct_1",
      dappName: "pump.fun",
      kind: "transaction",
      method: "solana_signTransaction",
      result: "REFUSED",
      code: "TRADING_NOT_ENABLED",
      message: "2 steps: Compute budget, pump.fun 66063d12",
      detail: { transactions: [{ feePayer: ADDRESS, programIds: ["6EF8"] }] },
    });
    const list = await store.listRequests("acct_1", 10);
    expect(list.map((r) => r.kind)).toEqual(["transaction", "login"]);
    expect(list[0]).toMatchObject({ result: "REFUSED", code: "TRADING_NOT_ENABLED", dappName: "pump.fun" });
    expect(list[0]!.detail).toEqual({ transactions: [{ feePayer: ADDRESS, programIds: ["6EF8"] }] });
    expect(list[1]!.detail).toEqual({ text: "Sign in" });
  });

  it("limits the list, and keeps accounts apart", async () => {
    await db.exec("insert into sol_wallets (account_id, wallet_id, wallet_address) values ('acct_2','w2','y')");
    for (let i = 0; i < 5; i++) await store.recordRequest({ accountId: "acct_1", dappName: null, kind: "other", method: "m", result: "ERROR" });
    await store.recordRequest({ accountId: "acct_2", dappName: null, kind: "other", method: "m", result: "ERROR" });
    expect(await store.listRequests("acct_1", 3)).toHaveLength(3);
    expect(await store.listRequests("acct_2", 10)).toHaveLength(1);
  });

  it("stores a request with no detail, and refuses nonsense kinds or results", async () => {
    await store.recordRequest({ accountId: "acct_1", dappName: null, kind: "other", method: "m", result: "ERROR" });
    expect((await store.listRequests("acct_1", 1))[0]!.detail).toBeNull();
    await expect(db.exec("insert into sol_requests (account_id, kind, method, result) values ('acct_1','weird','m','SIGNED')")).rejects.toThrow();
    await expect(db.exec("insert into sol_requests (account_id, kind, method, result) values ('acct_1','login','m','MAYBE')")).rejects.toThrow();
  });
});

describe("the owner's limits and withdrawal address", () => {
  beforeEach(async () => {
    await create();
  });

  it("starts from sensible defaults", async () => {
    expect(await store.get("acct_1")).toMatchObject({ maxBuyPct: 25, dailySpendPct: 50, maxBuysPerDay: 10, cooldownSec: 0, frozen: false, withdrawalAddress: null });
  });

  it("changes only the settings that are given", async () => {
    await store.updateSettings("acct_1", { maxBuyPct: 10 });
    expect(await store.get("acct_1")).toMatchObject({ maxBuyPct: 10, dailySpendPct: 50, maxBuysPerDay: 10 });
    await store.updateSettings("acct_1", { maxBuysPerDay: 3, cooldownSec: 30 });
    expect(await store.get("acct_1")).toMatchObject({ maxBuyPct: 10, maxBuysPerDay: 3, cooldownSec: 30 });
  });

  it("pauses and resumes buying", async () => {
    await store.setFrozen("acct_1", true);
    expect((await store.get("acct_1"))!.frozen).toBe(true);
    await store.setFrozen("acct_1", false);
    expect((await store.get("acct_1"))!.frozen).toBe(false);
  });

  it("keeps the withdrawal address", async () => {
    await store.setWithdrawalAddress("acct_1", "OwnerAddr1111111111111111111111111111111111");
    expect((await store.get("acct_1"))!.withdrawalAddress).toBe("OwnerAddr1111111111111111111111111111111111");
  });

  describe("a changed withdrawal address waits 24 hours", () => {
    const FIRST = "OwnerAddr1111111111111111111111111111111111";
    const SECOND = "OwnerAddr2222222222222222222222222222222222";
    const THIRD = "OwnerAddr3333333333333333333333333333333333";
    /** Moves a waiting change's time into the past, as if the 24 hours had gone by. */
    const letTimePass = () => db.exec("update sol_wallets set pending_withdrawal_at = now() - interval '1 second' where pending_withdrawal_at is not null");

    it("applies the first address at once: until there is one nothing can be withdrawn", async () => {
      await store.setWithdrawalAddress("acct_1", FIRST);
      expect(await store.get("acct_1")).toMatchObject({ withdrawalAddress: FIRST, pendingWithdrawalAddress: null, pendingWithdrawalAt: null });
    });

    it("keeps withdrawals going to the current address while a new one waits, and says until when", async () => {
      await store.setWithdrawalAddress("acct_1", FIRST);
      const before = Date.now();
      await store.setWithdrawalAddress("acct_1", SECOND);
      const w = (await store.get("acct_1"))!;
      expect(w).toMatchObject({ withdrawalAddress: FIRST, pendingWithdrawalAddress: SECOND });
      const waitMs = new Date(w.pendingWithdrawalAt!).getTime() - before;
      expect(waitMs).toBeGreaterThan(24 * 3600_000 - 60_000);
      expect(waitMs).toBeLessThan(24 * 3600_000 + 60_000);
    });

    it("switches to the new address once the 24 hours have passed, with nothing left waiting", async () => {
      await store.setWithdrawalAddress("acct_1", FIRST);
      await store.setWithdrawalAddress("acct_1", SECOND);
      await letTimePass();
      expect(await store.get("acct_1")).toMatchObject({ withdrawalAddress: SECOND, pendingWithdrawalAddress: null, pendingWithdrawalAt: null });
      // And a later change starts from the new address.
      await store.setWithdrawalAddress("acct_1", THIRD);
      expect(await store.get("acct_1")).toMatchObject({ withdrawalAddress: SECOND, pendingWithdrawalAddress: THIRD });
    });

    it("restarts the wait when another address is asked for, so it can never be shortened", async () => {
      await store.setWithdrawalAddress("acct_1", FIRST);
      await store.setWithdrawalAddress("acct_1", SECOND);
      await db.exec("update sol_wallets set pending_withdrawal_at = now() + interval '1 minute'"); // nearly done
      await store.setWithdrawalAddress("acct_1", THIRD);
      const w = (await store.get("acct_1"))!;
      expect(w).toMatchObject({ withdrawalAddress: FIRST, pendingWithdrawalAddress: THIRD });
      expect(new Date(w.pendingWithdrawalAt!).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    });

    it("cancels a waiting change when the current address is saved again", async () => {
      await store.setWithdrawalAddress("acct_1", FIRST);
      await store.setWithdrawalAddress("acct_1", SECOND);
      await store.setWithdrawalAddress("acct_1", FIRST);
      expect(await store.get("acct_1")).toMatchObject({ withdrawalAddress: FIRST, pendingWithdrawalAddress: null, pendingWithdrawalAt: null });
    });

    it("touches no other account", async () => {
      await create("acct_2");
      await store.setWithdrawalAddress("acct_2", FIRST);
      await store.setWithdrawalAddress("acct_1", FIRST);
      await store.setWithdrawalAddress("acct_1", SECOND);
      expect(await store.get("acct_2")).toMatchObject({ withdrawalAddress: FIRST, pendingWithdrawalAddress: null });
    });
  });

  it("refuses shares outside 1-100% at the database", async () => {
    await expect(db.exec("update sol_wallets set max_buy_pct = 0")).rejects.toThrow();
    await expect(db.exec("update sol_wallets set daily_spend_pct = 101")).rejects.toThrow();
    await expect(db.exec("update sol_wallets set cooldown_sec = -1")).rejects.toThrow();
  });
});

describe("the day's usage, from the log", () => {
  const trade = (over: Partial<Parameters<SolanaStore["recordRequest"]>[0]> = {}) =>
    store.recordRequest({ accountId: "acct_1", dappName: "pump.fun", kind: "transaction", method: "solana_signTransaction", result: "SIGNED", tradeKind: "buy", mint: "MintA", lamports: 100_000_000n, signature: "sig", ...over });

  beforeEach(async () => {
    await create();
  });

  it("counts only signed buys, and sums the SOL they could cost", async () => {
    await trade();
    await trade({ lamports: 200_000_000n });
    await trade({ result: "REFUSED", lamports: 9_000_000_000n });
    await trade({ result: "ERROR", lamports: 9_000_000_000n });
    await trade({ tradeKind: "sell", lamports: null });
    await trade({ kind: "login", tradeKind: null, mint: null, lamports: null });
    const u = await store.usageToday("acct_1", Date.now());
    expect(u.buysToday).toBe(2);
    expect(u.spentTodayLamports).toBe(300_000_000n);
    expect(u.lastBuyAtSec).toBeGreaterThan(1_700_000_000);
  });

  it("starts with nothing, keeps accounts apart, and counts a UTC day", async () => {
    expect(await store.usageToday("acct_1", Date.now())).toEqual({ buysToday: 0, spentTodayLamports: 0n, lastBuyAtSec: null });
    await db.exec("insert into sol_wallets (account_id, wallet_id, wallet_address) values ('acct_2','w2','y')");
    await trade({ accountId: "acct_2", lamports: 5_000_000_000n });
    expect((await store.usageToday("acct_1", Date.now())).spentTodayLamports).toBe(0n);
    await db.exec("update sol_requests set created_at = now() - interval '2 days'");
    expect((await store.usageToday("acct_2", Date.now())).buysToday).toBe(0);
    expect(solanaDayStart(Date.UTC(2026, 9, 26, 15, 30)).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("keeps lamports exact", async () => {
    const odd = 123_456_789_012_345_678n;
    await trade({ lamports: odd });
    expect((await store.usageToday("acct_1", Date.now())).spentTodayLamports).toBe(odd);
  });

  it("lists the coins traded, once each, from signed requests only", async () => {
    await trade({ mint: "MintA" });
    await trade({ mint: "MintA", tradeKind: "sell", lamports: null });
    await trade({ mint: "MintB" });
    await trade({ mint: "MintC", result: "REFUSED" });
    expect((await store.knownMints("acct_1")).sort()).toEqual(["MintA", "MintB"]);
  });

  it("sums per coin what the buys cost and what the sales and withdrawn coins returned", async () => {
    await trade({ mint: "MintA", lamports: 100_000_000n });
    await trade({ mint: "MintA", lamports: 200_000_000n });
    await trade({ mint: "MintA", tradeKind: "sell", lamports: null, proceedsLamports: 250_000_000n });
    await trade({ mint: "MintA", kind: "sweep", tradeKind: null, lamports: null, proceedsLamports: 50_000_000n });
    await trade({ mint: "MintB", lamports: 1_000_000_000n });
    await trade({ mint: "MintB", lamports: 9n, result: "REFUSED" });
    const flows = await store.mintFlows("acct_1");
    expect(flows.find((x) => x.mint === "MintA")).toEqual({ mint: "MintA", costLamports: 300_000_000n, proceedsLamports: 300_000_000n });
    expect(flows.find((x) => x.mint === "MintB")).toEqual({ mint: "MintB", costLamports: 1_000_000_000n, proceedsLamports: 0n });
  });

  it("starts with no day and no peak, saves and reads them back (negative result included), and forgets only the peak when asked", async () => {
    expect(await store.getRiskState("acct_1")).toEqual({ day: null, dayStartPnlLamports: 0n, peakEquityLamports: 0n });
    await store.saveRiskState("acct_1", { day: "2026-10-26", dayStartPnlLamports: -200_000_000n, peakEquityLamports: 3_000_000_000n });
    expect(await store.getRiskState("acct_1")).toEqual({ day: "2026-10-26", dayStartPnlLamports: -200_000_000n, peakEquityLamports: 3_000_000_000n });
    await store.resetPeak("acct_1");
    expect(await store.getRiskState("acct_1")).toEqual({ day: "2026-10-26", dayStartPnlLamports: -200_000_000n, peakEquityLamports: 0n });
  });

  it("stores the trade's details and timings, and shows them in the list", async () => {
    await trade({ timings: { checkMs: 5, simulateMs: 120, signMs: 80, totalMs: 230 } });
    const [row] = await store.listRequests("acct_1", 1);
    expect(row).toMatchObject({ tradeKind: "buy", mint: "MintA", lamports: "100000000", signature: "sig", totalMs: 230 });
  });
});

describe("links of the three kinds share one table", () => {
  it("accepts a Solana link, and still accepts Safe and BNB wallet links, but nothing else", async () => {
    const links = new OneClickStore(pool);
    for (const kind of ["safe", "float", "solana"] as const) {
      await links.addSession({ topic: `t-${kind}`, accountId: "acct_1", kind, dappName: kind, dappUrl: null, expiresAt: null });
    }
    expect((await links.listSessions("acct_1")).map((s) => s.kind).sort()).toEqual(["float", "safe", "solana"]);
    await expect(db.exec("insert into evm_wc_sessions (topic, account_id, kind) values ('bad','acct_1','weird')")).rejects.toThrow();
  });
});
