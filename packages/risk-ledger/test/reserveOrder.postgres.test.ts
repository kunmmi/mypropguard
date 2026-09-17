import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import Decimal from "decimal.js";
import { DecisionOutcome } from "@mypropguard/domain";
import { buildProposedOrder } from "@mypropguard/test-fixtures";
import { loadRootEnvIfPresent } from "./loadEnv.js";
import { createPool } from "../src/postgres/pool.js";
import { PgRiskLedgerStore } from "../src/postgres/pgRiskLedgerStore.js";
import { reserveOrder } from "../src/reserveOrder.js";

loadRootEnvIfPresent();

/**
 * Real-Postgres proof of the row-lock concurrency guarantee described in
 * README.md. Skipped automatically when DATABASE_URL isn't set (e.g. no
 * network/DB access in an offline environment) — the always-on proof of the
 * same algorithm lives in reserveOrder.concurrency.test.ts against the
 * in-memory mutex-backed store.
 */
describe.skipIf(!process.env.DATABASE_URL)("reserveOrder against real Postgres", () => {
  const accountId = `acct_pg_test_${Date.now()}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL as string);
    await pool.query(
      "INSERT INTO protected_accounts (account_id, owner_user_id, protection_enabled) VALUES ($1, 'test_owner', true)",
      [accountId],
    );
    await pool.query(
      `INSERT INTO account_risk_heads (account_id, equity_start_of_day, current_equity, peak_equity, open_notional)
       VALUES ($1, 10000, 10000, 10000, 0)`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO rule_versions (account_id, rule_type, param) VALUES ($1, 'MAX_POSITION_SIZE', 1000)`,
      [accountId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM order_reservations WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM rule_versions WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM account_risk_heads WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM protected_accounts WHERE account_id = $1", [accountId]);
    await pool.end();
  });

  it("lets Postgres's SELECT ... FOR UPDATE serialize two concurrent reservations against the same cap", async () => {
    const store = new PgRiskLedgerStore(pool);

    const makeOrder = (clientIntentId: string) =>
      reserveOrder(store, {
        accountId,
        proposedOrder: buildProposedOrder({ clientIntentId, size: new Decimal(700), price: new Decimal(1) }),
        currentPositionSize: new Decimal(0),
      });

    const [first, second] = await Promise.all([makeOrder("pg_intent_a"), makeOrder("pg_intent_b")]);

    const totalReservedNotional = await pool
      .query("SELECT COALESCE(SUM(reserved_amount), 0) AS total FROM order_reservations WHERE account_id = $1", [
        accountId,
      ])
      .then((r) => new Decimal(r.rows[0].total));

    expect(totalReservedNotional.lte(1_000)).toBe(true);

    const outcomes = [first.decision.outcome, second.decision.outcome];
    expect(outcomes).toContain(DecisionOutcome.RESIZE);
  }, 20_000);
});
