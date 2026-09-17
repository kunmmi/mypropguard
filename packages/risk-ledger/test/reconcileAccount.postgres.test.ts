import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { StateConfidence } from "@mypropguard/domain";
import { HyperliquidInfoClient } from "@mypropguard/hyperliquid";
import { loadRootEnvIfPresent } from "./loadEnv.js";
import { createPool } from "../src/postgres/pool.js";
import { PgRiskLedgerStore } from "../src/postgres/pgRiskLedgerStore.js";
import { reconcileAccountFromVenue } from "../src/reconcileAccount.js";

loadRootEnvIfPresent();

/**
 * End-to-end proof of Phase 2's read-only path: real Postgres + a real read
 * against Hyperliquid's public mainnet API (no auth, cannot place orders or
 * move funds either way). Skipped when DATABASE_URL isn't set.
 *
 * Uses the null address (0x000...000) purely as a stable, always-queryable
 * address — not because it's guaranteed empty. The first run of this test
 * found it actually holds ~$557 (people do send funds to the null address
 * by mistake), which is fine: the assertions below only check that a real
 * number came back and got persisted, not any specific balance.
 */
describe.skipIf(!process.env.DATABASE_URL)("reconcileAccountFromVenue against real Postgres + real Hyperliquid API", () => {
  const accountId = `acct_pg_reconcile_${Date.now()}`;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL as string);
    await pool.query("INSERT INTO protected_accounts (account_id, owner_user_id) VALUES ($1, 'test_owner')", [accountId]);
    await pool.query(
      `INSERT INTO account_risk_heads (account_id, equity_start_of_day, current_equity, peak_equity, open_notional)
       VALUES ($1, 1000, 1000, 1000, 0)`,
      [accountId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM state_checkpoints WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM account_risk_heads WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM protected_accounts WHERE account_id = $1", [accountId]);
    await pool.end();
  });

  it("reads a real address's clearinghouseState and records a VERIFIED checkpoint", async () => {
    const store = new PgRiskLedgerStore(pool);
    const venueReader = new HyperliquidInfoClient();

    const { head } = await reconcileAccountFromVenue(store, venueReader, {
      accountId,
      venueAddress: "0x0000000000000000000000000000000000000000",
    });

    // Proves the real read + write path: a real Decimal came back from
    // Hyperliquid and got persisted to account_risk_heads.
    expect(head.currentEquity.isFinite()).toBe(true);
    expect(head.currentEquity.gte(0)).toBe(true);
    expect(head.openNotional.gte(0)).toBe(true);

    const checkpoint = await pool.query(
      "SELECT * FROM state_checkpoints WHERE account_id = $1 ORDER BY verified_at DESC LIMIT 1",
      [accountId],
    );
    expect(checkpoint.rows[0].confidence).toBe(StateConfidence.VERIFIED);
  }, 20_000);
});
