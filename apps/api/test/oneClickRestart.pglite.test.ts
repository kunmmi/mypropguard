/**
 * Restart / redeploy behaviour of one-click trading, against a REAL Postgres engine (PGlite, in-process).
 *
 * The other lease tests use an in-memory stand-in for the SQL. This file runs the actual statements in
 * `PgLeaseStore` and `PgWalletConnectStorage` on Postgres itself, with the real `walletconnect_kv` schema from
 * migration 0012, so the parts a restart depends on are exercised for real:
 *
 *   1. the lease row: who may take it, when, and that a release hands it over at once;
 *   2. the saved WalletConnect state: what a freshly started server reads back is exactly what the old one wrote;
 *   3. a whole deploy overlap and a hard kill, end to end, with a controllable clock.
 *
 * What this cannot prove: that WalletConnect's relay delivers requests on a restored link. That needs the relay and a
 * real exchange, so it stays a manual check (see the roadmap entry).
 */
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LEASE_KEY, PgLeaseStore, WalletConnectLease } from "../src/oneClick/walletConnectLease.js";
import { PgWalletConnectStorage } from "../src/oneClick/pgWalletConnectStorage.js";

const SCHEMA = `
  create table if not exists walletconnect_kv (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
  );
`;

let db: PGlite;
let pool: pg.Pool;

// One engine for the whole file (booting it is the slow part); each test starts from an empty table.
beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // The two classes only ever call pool.query(sql, params) and read .rows.
  pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) } as unknown as pg.Pool;
});
beforeEach(async () => {
  await db.exec("truncate walletconnect_kv");
});
afterAll(async () => {
  await db.close();
});

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("the lease row, on real Postgres", () => {
  it("is taken by the first copy and refused to a second while it is valid", async () => {
    const store = new PgLeaseStore(pool);
    expect(await store.tryAcquire("old", 1_000, 30_000)).toBe(true);
    expect(await store.tryAcquire("new", 2_000, 30_000)).toBe(false);
  });

  it("lets the holder renew it (and moves the expiry forward)", async () => {
    const store = new PgLeaseStore(pool);
    await store.tryAcquire("old", 1_000, 30_000);
    expect(await store.tryAcquire("old", 20_000, 30_000)).toBe(true);
    // Renewed at t=20s with a 30s ttl, so it is still the old copy's at t=45s...
    expect(await store.tryAcquire("new", 45_000, 30_000)).toBe(false);
    // ...and free once that has run out.
    expect(await store.tryAcquire("new", 50_001, 30_000)).toBe(true);
  });

  it("is up for grabs the moment it has run out — a killed server does not hold it forever", async () => {
    const store = new PgLeaseStore(pool);
    await store.tryAcquire("old", 1_000, 30_000);
    expect(await store.tryAcquire("new", 31_000, 30_000)).toBe(false); // exactly at expiry: not yet
    expect(await store.tryAcquire("new", 31_001, 30_000)).toBe(true);
  });

  it("is handed over immediately by a release, without waiting out the ttl", async () => {
    const store = new PgLeaseStore(pool);
    await store.tryAcquire("old", 1_000, 30_000);
    await store.release("old");
    expect(await store.tryAcquire("new", 1_001, 30_000)).toBe(true);
  });

  it("cannot be released, or stolen, by a copy that does not hold it", async () => {
    const store = new PgLeaseStore(pool);
    await store.tryAcquire("old", 1_000, 30_000);
    await store.release("intruder"); // must be a no-op
    expect(await store.tryAcquire("intruder", 2_000, 30_000)).toBe(false);
    expect(await store.tryAcquire("old", 2_000, 30_000)).toBe(true); // still the old copy's
  });

  it("never lets two copies both win a simultaneous race", async () => {
    const store = new PgLeaseStore(pool);
    const owners = Array.from({ length: 12 }, (_, i) => `copy-${i}`);
    const results = await Promise.all(owners.map((o) => store.tryAcquire(o, 5_000, 30_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("the saved WalletConnect state, across a restart", () => {
  // The kinds of keys WalletConnect really writes: namespaced with ':', '@', '//' and '.'.
  const entries: Record<string, unknown> = {
    "wc@2:core:0.3//keychain": { "abc123": "deadbeef", "def456": "cafebabe" },
    "wc@2:core:0.3//subscription": [{ id: "s1", topic: "t".repeat(64), relay: { protocol: "irn" } }],
    "wc@2:client:0.3//session": [
      { topic: "a".repeat(64), expiry: 1_900_000_000, peer: { metadata: { name: "PancakeSwap" } }, acknowledged: true },
    ],
    "wc@2:core:0.3//pairing": [{ topic: "b".repeat(64), active: true }],
    "wc@2:core:0.3//messages": { "m1": "payload with \"quotes\", unicode ✓ and \\ backslashes" },
  };

  async function write(storage: PgWalletConnectStorage) {
    for (const [k, v] of Object.entries(entries)) await storage.setItem(k, v);
  }

  it("a newly started server reads back exactly what the old one wrote", async () => {
    await write(new PgWalletConnectStorage(pool)); // the old copy
    const afterRestart = new PgWalletConnectStorage(pool); // a brand new instance, same database
    for (const [k, v] of Object.entries(entries)) expect(await afterRestart.getItem(k)).toEqual(v);
    expect([...(await afterRestart.getKeys())].sort()).toEqual(Object.keys(entries).sort());
    const got = Object.fromEntries(await afterRestart.getEntries());
    expect(got).toEqual(entries);
  });

  it("overwrites in place and removes cleanly (no duplicate rows to confuse a restore)", async () => {
    const s = new PgWalletConnectStorage(pool);
    await s.setItem("wc@2:client:0.3//session", [{ topic: "x" }]);
    await s.setItem("wc@2:client:0.3//session", [{ topic: "y" }]);
    expect(await s.getItem("wc@2:client:0.3//session")).toEqual([{ topic: "y" }]);
    expect((await s.getKeys()).filter((k) => k === "wc@2:client:0.3//session")).toHaveLength(1);
    await s.removeItem("wc@2:client:0.3//session");
    expect(await s.getItem("wc@2:client:0.3//session")).toBeUndefined();
  });

  it("keeps the lease row out of WalletConnect's view, even though they share a table", async () => {
    const s = new PgWalletConnectStorage(pool);
    await write(s);
    await new PgLeaseStore(pool).tryAcquire("old", 1_000, 30_000);
    expect(LEASE_KEY.startsWith("mypropguard:")).toBe(true);
    expect(await s.getKeys()).not.toContain(LEASE_KEY);
    expect((await s.getEntries()).map(([k]) => k)).not.toContain(LEASE_KEY);
  });

  it("taking and releasing the lease never disturbs the saved link state", async () => {
    const s = new PgWalletConnectStorage(pool);
    await write(s);
    const lease = new PgLeaseStore(pool);
    await lease.tryAcquire("old", 1_000, 30_000);
    await lease.release("old");
    await lease.tryAcquire("new", 2_000, 30_000);
    expect(Object.fromEntries(await s.getEntries())).toEqual(entries);
  });
});

describe("a deploy and a hard kill, end to end", () => {
  const options = (c: ReturnType<typeof clock>, log: string[], sleepers: Array<() => void>) => ({
    ttlMs: 30_000,
    pollMs: 1_000_000, // far apart: no background renewals during the test
    now: c.now,
    sleep: () => new Promise<void>((resolve) => sleepers.push(resolve)),
    log: (m: string) => log.push(m),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("the new copy waits while the old one runs, then takes over the moment the old one hands over", async () => {
    const c = clock();
    const log: string[] = [];
    const sleepers: Array<() => void> = [];

    const oldCopy = new WalletConnectLease(new PgLeaseStore(pool), options(c, log, sleepers));
    await oldCopy.acquire();
    expect(oldCopy.isHeld()).toBe(true);

    // The platform starts the new copy alongside the old one.
    const newCopy = new WalletConnectLease(new PgLeaseStore(pool), options(c, log, sleepers));
    let newHasIt = false;
    const waiting = newCopy.acquire().then(() => (newHasIt = true));
    await settle();
    expect(newHasIt).toBe(false);
    expect(log).toContain("another copy of the server owns the WalletConnect connection; waiting for it to let go");

    // It keeps waiting no matter how many times it polls, while the old copy is alive.
    for (let i = 0; i < 3; i++) {
      c.advance(5_000);
      sleepers.splice(0).forEach((wake) => wake());
      await settle();
    }
    expect(newHasIt).toBe(false);

    // SIGTERM reaches the old copy: it lets go. The new copy gets it on its very next poll — no waiting out the ttl.
    await oldCopy.release();
    sleepers.splice(0).forEach((wake) => wake());
    await waiting;
    expect(newHasIt).toBe(true);
    expect(newCopy.isHeld()).toBe(true);
    expect(oldCopy.isHeld()).toBe(false);
    expect(log.at(-1)).toBe("this copy of the server now owns the WalletConnect connection");
    await newCopy.release();
  });

  it("if the old copy is killed without saying goodbye, the new one still gets in once the ttl runs out", async () => {
    const c = clock();
    const log: string[] = [];
    const sleepers: Array<() => void> = [];

    const killed = new WalletConnectLease(new PgLeaseStore(pool), options(c, log, sleepers));
    await killed.acquire(); // ...and is never released: SIGKILL, out-of-memory, host failure

    const next = new WalletConnectLease(new PgLeaseStore(pool), options(c, log, sleepers));
    let has = false;
    const waiting = next.acquire().then(() => (has = true));
    await settle();
    expect(has).toBe(false);

    c.advance(29_000);
    sleepers.splice(0).forEach((wake) => wake());
    await settle();
    expect(has).toBe(false); // still inside the ttl

    c.advance(2_000); // 31s since the last renewal
    sleepers.splice(0).forEach((wake) => wake());
    await waiting;
    expect(has).toBe(true);
    await next.release();
    await killed.release();
  });

  it("the link state written by the old copy is intact for the new copy once it owns the lease", async () => {
    const c = clock();
    const sleepers: Array<() => void> = [];
    const oldStorage = new PgWalletConnectStorage(pool);
    await oldStorage.setItem("wc@2:client:0.3//session", [{ topic: "a".repeat(64), expiry: 1_900_000_000 }]);
    await oldStorage.setItem("wc@2:core:0.3//keychain", { k: "v" });

    const oldCopy = new WalletConnectLease(new PgLeaseStore(pool), options(c, [], sleepers));
    await oldCopy.acquire();
    const newCopy = new WalletConnectLease(new PgLeaseStore(pool), options(c, [], sleepers));
    const waiting = newCopy.acquire();
    await settle();
    await oldCopy.release();
    sleepers.splice(0).forEach((wake) => wake());
    await waiting;

    // Only now does the new copy build its storage and load the saved state — as the server does.
    const newStorage = new PgWalletConnectStorage(pool);
    expect(await newStorage.getItem("wc@2:client:0.3//session")).toEqual([{ topic: "a".repeat(64), expiry: 1_900_000_000 }]);
    expect(await newStorage.getItem("wc@2:core:0.3//keychain")).toEqual({ k: "v" });
    await newCopy.release();
  });

  it("a copy whose lease was taken over stands down on the real SQL", async () => {
    const c = clock();
    const sleepers: Array<() => void> = [];
    let stood = 0;
    const oldCopy = new WalletConnectLease(new PgLeaseStore(pool), { ...options(c, [], sleepers), onLost: () => void stood++ });
    await oldCopy.acquire();

    // The old copy goes quiet for longer than the ttl (a stalled process), so the database lets another copy in.
    c.advance(31_000);
    const newCopy = new WalletConnectLease(new PgLeaseStore(pool), options(c, [], sleepers));
    await newCopy.acquire();
    expect(newCopy.isHeld()).toBe(true);

    // The old copy wakes up, tries to renew, and is told no: it must stand down rather than carry on.
    await oldCopy.renew();
    expect(oldCopy.isHeld()).toBe(false);
    expect(stood).toBe(1);
    expect(newCopy.isHeld()).toBe(true);
    await newCopy.release();
  });
});
