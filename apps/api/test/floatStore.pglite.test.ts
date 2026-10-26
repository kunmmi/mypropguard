/**
 * The trading wallet's storage, on a real Postgres engine (PGlite) using the REAL migration files — so the SQL the
 * server runs, and the schema it runs against, are what is tested, not a stand-in.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FloatStore, utcDayStart } from "../src/float/floatStore.js";
import { OneClickStore } from "../src/oneClick/oneClickStore.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "supabase", "migrations");
const WEI = (bnb: number) => BigInt(Math.round(bnb * 1e9)) * 10n ** 9n;

let db: PGlite;
let pool: pg.Pool;
let store: FloatStore;

beforeAll(async () => {
  db = new PGlite();
  // The one table these migrations reference. Everything else comes from the real files.
  await db.exec("create table protected_accounts (account_id text primary key);");
  await db.exec(readFileSync(join(MIGRATIONS, "0012_one_click_trading.sql"), "utf-8"));
  await db.exec(readFileSync(join(MIGRATIONS, "0013_float_wallet.sql"), "utf-8"));
  pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) } as unknown as pg.Pool;
  store = new FloatStore(pool);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec("truncate evm_float_trades, evm_float_wallets, evm_wc_sessions; delete from protected_accounts;");
  await db.exec("insert into protected_accounts (account_id) values ('acct_1'), ('acct_2');");
});

const limits = { maxBuyWei: WEI(0.25), maxBuysPerDay: 5, dailySpendWei: WEI(0.5), cooldownSec: 20 };
const create = (accountId = "acct_1", floatWei = WEI(1)) =>
  store.create({ accountId, walletId: `privy-${accountId}`, address: "0x1111111111111111111111111111111111111111", chainId: 56, floatWei, limits });

describe("the trading wallet record", () => {
  it("stores and reads back every field, with wei as exact bigints", async () => {
    await create();
    const w = (await store.get("acct_1"))!;
    expect(w).toMatchObject({ accountId: "acct_1", walletId: "privy-acct_1", chainId: 56, status: "active", floatWei: WEI(1) });
    expect(w.limits).toEqual({ ...limits, frozen: false });
    expect(w.address).toBe("0x1111111111111111111111111111111111111111");
  });

  it("keeps huge amounts exact (no float rounding in wei)", async () => {
    const big = 123_456_789_012_345_678_901n;
    await store.create({ accountId: "acct_1", walletId: "w", address: "0x1", chainId: 56, floatWei: big, limits: { ...limits, maxBuyWei: big } });
    const w = (await store.get("acct_1"))!;
    expect(w.floatWei).toBe(big);
    expect(w.limits.maxBuyWei).toBe(big);
  });

  it("returns undefined for an account with no trading wallet", async () => {
    expect(await store.get("acct_2")).toBeUndefined();
  });

  it("creating twice does not overwrite the first (one wallet per account)", async () => {
    await create();
    await store.create({ accountId: "acct_1", walletId: "SECOND", address: "0x2", chainId: 56, floatWei: 1n, limits });
    expect((await store.get("acct_1"))!.walletId).toBe("privy-acct_1");
  });

  it("changes only the settings that are given", async () => {
    await create();
    await store.updateSettings("acct_1", { maxBuyWei: WEI(0.1) });
    const w = (await store.get("acct_1"))!;
    expect(w.limits.maxBuyWei).toBe(WEI(0.1));
    expect(w.limits.maxBuysPerDay).toBe(5);
    expect(w.limits.dailySpendWei).toBe(WEI(0.5));
    expect(w.floatWei).toBe(WEI(1));
    await store.updateSettings("acct_1", { floatWei: WEI(2), maxBuysPerDay: 9, cooldownSec: 0 });
    const w2 = (await store.get("acct_1"))!;
    expect(w2).toMatchObject({ floatWei: WEI(2) });
    expect(w2.limits).toMatchObject({ maxBuysPerDay: 9, cooldownSec: 0, maxBuyWei: WEI(0.1) });
  });

  it("freezes, unfreezes, and switches off", async () => {
    await create();
    await store.setFrozen("acct_1", true);
    expect((await store.get("acct_1"))!.limits.frozen).toBe(true);
    await store.setFrozen("acct_1", false);
    expect((await store.get("acct_1"))!.limits.frozen).toBe(false);
    await store.setStatus("acct_1", "off");
    expect((await store.get("acct_1"))!.status).toBe("off");
  });

  it("refuses nonsense at the database: negative limits and unknown status", async () => {
    await create();
    await expect(db.exec("update evm_float_wallets set max_buy_wei = -1")).rejects.toThrow();
    await expect(db.exec("update evm_float_wallets set status = 'maybe'")).rejects.toThrow();
  });
});

describe("the day's usage, from the trade log", () => {
  const trade = (over: Partial<Parameters<FloatStore["recordTrade"]>[0]> = {}) =>
    store.recordTrade({ accountId: "acct_1", dappName: "four.meme", kind: "buy", toAddress: "0xaa", tokenAddress: "0xbb", valueWei: WEI(0.1), txHash: "0xhash", result: "SENT", code: null, message: null, ...over });

  beforeEach(async () => {
    await create();
  });

  it("counts only SENT buys, and sums their BNB", async () => {
    await trade();
    await trade({ valueWei: WEI(0.2) });
    await trade({ result: "REFUSED", code: "MAX_BUY", txHash: null }); // refused: not a buy that happened
    await trade({ result: "ERROR", txHash: null });
    await trade({ kind: "sell", valueWei: 0n });
    await trade({ kind: "approve", valueWei: 0n });
    const u = await store.usageToday("acct_1", Date.now());
    expect(u.buysToday).toBe(2);
    expect(u.spentTodayWei).toBe(WEI(0.3));
    expect(u.lastBuyAtSec).toBeGreaterThan(Date.now() / 1000 - 60);
  });

  it("is zero for a fresh account, with no last-buy time", async () => {
    expect(await store.usageToday("acct_1", Date.now())).toEqual({ buysToday: 0, spentTodayWei: 0n, lastBuyAtSec: null });
  });

  it("starts a new day at 00:00 UTC: yesterday's buys no longer count", async () => {
    await trade();
    const tomorrowNoon = utcDayStart(Date.now()).getTime() + 36 * 3600 * 1000;
    expect((await store.usageToday("acct_1", tomorrowNoon)).buysToday).toBe(0);
    expect((await store.usageToday("acct_1", Date.now())).buysToday).toBe(1);
  });

  it("does not mix accounts", async () => {
    await db.exec("insert into evm_float_wallets (account_id, wallet_id, wallet_address, chain_id, float_wei, max_buy_wei, max_buys_per_day, daily_spend_wei) values ('acct_2','w2','0x2',56,1,1,1,1)");
    await trade();
    await trade({ accountId: "acct_2", valueWei: WEI(5) });
    expect((await store.usageToday("acct_1", Date.now())).spentTodayWei).toBe(WEI(0.1));
    expect((await store.usageToday("acct_2", Date.now())).spentTodayWei).toBe(WEI(5));
  });

  it("keeps wei exact when summing many buys", async () => {
    for (let i = 0; i < 7; i++) await trade({ valueWei: 123_456_789_012_345_678n });
    expect((await store.usageToday("acct_1", Date.now())).spentTodayWei).toBe(123_456_789_012_345_678n * 7n);
  });

  it("utcDayStart is midnight UTC, whatever the server's local timezone", () => {
    expect(utcDayStart(Date.UTC(2026, 9, 26, 23, 59, 59)).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(utcDayStart(Date.UTC(2026, 9, 27, 0, 0, 0)).toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });
});

describe("the trade log", () => {
  beforeEach(async () => {
    await create();
  });

  it("lists newest first with the reason a trade was refused and how long the server took", async () => {
    await store.recordTrade({ accountId: "acct_1", dappName: "four.meme", kind: "buy", toAddress: "0xaa", tokenAddress: "0xbb", valueWei: WEI(0.1), txHash: "0x1", result: "SENT", code: null, message: null, timings: { checkMs: 2, estimateMs: 120, sendMs: 300, totalMs: 440 } });
    await store.recordTrade({ accountId: "acct_1", dappName: "four.meme", kind: "buy", toAddress: "0xaa", tokenAddress: null, valueWei: WEI(9), txHash: null, result: "REFUSED", code: "MAX_BUY", message: "too big" });
    const list = await store.listTrades("acct_1", 10);
    expect(list.map((t) => t.result)).toEqual(["REFUSED", "SENT"]);
    expect(list[0]).toMatchObject({ code: "MAX_BUY", message: "too big", valueWei: WEI(9).toString(), totalMs: null });
    expect(list[1]).toMatchObject({ txHash: "0x1", totalMs: 440 });
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) await store.recordTrade({ accountId: "acct_1", dappName: null, kind: "login", toAddress: null, tokenAddress: null, valueWei: null, txHash: null, result: "SENT", code: null, message: null });
    expect(await store.listTrades("acct_1", 3)).toHaveLength(3);
  });

  it("knows which tokens the wallet has touched (for showing positions and sweeping)", async () => {
    const rec = (token: string | null, result: "SENT" | "REFUSED") =>
      store.recordTrade({ accountId: "acct_1", dappName: null, kind: "buy", toAddress: null, tokenAddress: token, valueWei: 1n, txHash: null, result, code: null, message: null });
    await rec("0xaaa", "SENT");
    await rec("0xaaa", "SENT");
    await rec("0xbbb", "SENT");
    await rec("0xccc", "REFUSED"); // never bought: not a position
    await rec(null, "SENT");
    expect((await store.knownTokens("acct_1")).sort()).toEqual(["0xaaa", "0xbbb"]);
  });
});

describe("links to the Safe vs to the trading wallet", () => {
  it("a new link defaults to the Safe (so existing one-click links keep working), and a float link is remembered as such", async () => {
    const links = new OneClickStore(pool);
    await links.addSession({ topic: "t-safe", accountId: "acct_1", dappName: "PancakeSwap", dappUrl: "https://pancakeswap.finance", expiresAt: null });
    await links.addSession({ topic: "t-float", accountId: "acct_1", dappName: "four.meme", dappUrl: "https://four.meme", expiresAt: null, kind: "float" });
    expect((await links.getSession("t-safe"))!.kind).toBe("safe");
    expect((await links.getSession("t-float"))!.kind).toBe("float");
    expect((await links.listSessions("acct_1")).map((s) => s.kind).sort()).toEqual(["float", "safe"]);
  });

  it("the database rejects any other kind", async () => {
    await expect(db.exec("insert into evm_wc_sessions (topic, account_id, kind) values ('x','acct_1','weird')")).rejects.toThrow();
  });
});
