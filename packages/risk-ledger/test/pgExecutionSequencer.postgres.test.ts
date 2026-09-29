import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Decimal } from "decimal.js";
import { loadRootEnvIfPresent } from "./loadEnv.js";
import { createPool } from "../src/postgres/pool.js";
import { PgRiskLedgerStore } from "../src/postgres/pgRiskLedgerStore.js";
import { PgExecutionSequencer } from "../src/postgres/pgExecutionSequencer.js";

loadRootEnvIfPresent();

describe.skipIf(!process.env.DATABASE_URL)("PgExecutionSequencer against real Postgres", () => {
  const accountId = `acct_pg_nonce_${Date.now()}`;
  const pool: pg.Pool = createPool(process.env.DATABASE_URL as string);
  const store = new PgRiskLedgerStore(pool);
  const sequencer = new PgExecutionSequencer(pool);

  beforeAll(async () => {
    await store.createAccount({
      accountId,
      ownerUserId: "pg_test_owner",
      venue: "hyperliquid",
      initialEquity: new Decimal(1_000),
      initialRules: [],
    });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM nonce_leases WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM account_risk_heads WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM protected_accounts WHERE account_id = $1", [accountId]);
    await pool.end();
  });

  it("leases a nonce close to the current timestamp", async () => {
    const before = Date.now();
    const lease = await sequencer.leaseNonce(accountId);
    const after = Date.now();

    expect(lease.nonce).toBeGreaterThanOrEqual(before);
    expect(lease.nonce).toBeLessThanOrEqual(after);
  });

  it("survives a fresh sequencer instance (durable across process restarts)", async () => {
    const first = await sequencer.leaseNonce(accountId);

    // A brand-new instance, same underlying pool/table - simulates the
    // server process restarting. Must never hand out a nonce that regresses
    // below what was already persisted, unlike an in-memory counter which
    // would reset to zero here.
    const freshSequencer = new PgExecutionSequencer(pool);
    const second = await freshSequencer.leaseNonce(accountId);

    expect(second.nonce).toBeGreaterThan(first.nonce);
  });

  it("never issues a nonce lower than the previous one, even called faster than 1ms apart", async () => {
    const leases = await Promise.all(Array.from({ length: 20 }, () => sequencer.leaseNonce(accountId)));
    const nonces = leases.map((l) => l.nonce).sort((a, b) => a - b);

    for (let i = 1; i < nonces.length; i++) {
      expect(nonces[i]).toBeGreaterThan(nonces[i - 1]!);
    }
  });
});
