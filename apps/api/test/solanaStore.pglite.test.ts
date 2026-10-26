/**
 * The Solana wallet's storage, on a real Postgres engine (PGlite) using the REAL migration files.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SolanaStore } from "../src/solana/solanaStore.js";
import { OneClickStore } from "../src/oneClick/oneClickStore.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "supabase", "migrations");

let db: PGlite;
let pool: pg.Pool;
let store: SolanaStore;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create table protected_accounts (account_id text primary key);");
  for (const file of ["0012_one_click_trading.sql", "0013_float_wallet.sql", "0014_solana_wallet.sql"]) {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf-8"));
  }
  pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) } as unknown as pg.Pool;
  store = new SolanaStore(pool);
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.exec("truncate sol_requests, sol_wallets, evm_wc_sessions; delete from protected_accounts;");
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
