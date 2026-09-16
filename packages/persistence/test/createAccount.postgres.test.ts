import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Decimal } from "decimal.js";
import { AccountAlreadyExistsError, RuleType } from "@mypropguard/domain";
import { loadRootEnvIfPresent } from "./loadEnv.js";
import { createPool } from "../src/postgres/pool.js";
import { PgRiskLedgerStore } from "../src/postgres/pgRiskLedgerStore.js";

loadRootEnvIfPresent();

describe.skipIf(!process.env.DATABASE_URL)("PgRiskLedgerStore.createAccount", () => {
  const accountId = `acct_pg_create_${Date.now()}`;
  const pool: pg.Pool = createPool(process.env.DATABASE_URL as string);
  const store = new PgRiskLedgerStore(pool);

  afterAll(async () => {
    await pool.query("DELETE FROM rule_versions WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM account_risk_heads WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM protected_accounts WHERE account_id = $1", [accountId]);
    await pool.end();
  });

  it("creates protected_accounts, account_risk_heads, and rule_versions rows atomically", async () => {
    await store.createAccount({
      accountId,
      ownerUserId: "pg_test_owner",
      venue: "hyperliquid",
      initialEquity: new Decimal(2_500),
      initialRules: [{ ruleType: RuleType.MAX_DAILY_LOSS, param: new Decimal(250) }],
    });

    const head = await pool.query("SELECT * FROM account_risk_heads WHERE account_id = $1", [accountId]);
    expect(head.rows[0].current_equity).toBe("2500.000000000000000000");

    const rules = await pool.query("SELECT * FROM rule_versions WHERE account_id = $1", [accountId]);
    expect(rules.rows).toHaveLength(1);
    expect(rules.rows[0].rule_type).toBe(RuleType.MAX_DAILY_LOSS);
  });

  it("rejects a duplicate accountId", async () => {
    await expect(
      store.createAccount({
        accountId,
        ownerUserId: "pg_test_owner",
        venue: "hyperliquid",
        initialEquity: new Decimal(1_000),
        initialRules: [],
      }),
    ).rejects.toBeInstanceOf(AccountAlreadyExistsError);
  });
});
