import type pg from "pg";
import { Decimal } from "decimal.js";
import { OrderReservationStatus, type LedgerContext, type NewReservationInput, type RiskLedgerStore } from "@mypropguard/domain";
import { rowToAccountRiskHead, rowToOrderReservation, rowToRuleVersion } from "./mappers.js";

/**
 * Postgres-backed RiskLedgerStore. `account_risk_heads` is the per-account
 * serialization root: `SELECT ... FOR UPDATE` inside a single transaction
 * blocks any other transaction trying to lock the same row, so concurrent
 * reservation attempts for one account are serialized by Postgres itself.
 * No database transaction spans managed signing or venue network I/O
 * (there is none in Phase 0/1 — this store only ever talks to Postgres).
 */
export class PgRiskLedgerStore implements RiskLedgerStore {
  constructor(private readonly pool: pg.Pool) {}

  async runExclusive<T>(accountId: string, fn: (ctx: LedgerContext) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Locks the row for the remainder of this transaction.
      await client.query("SELECT 1 FROM account_risk_heads WHERE account_id = $1 FOR UPDATE", [accountId]);

      const ctx: LedgerContext = {
        getAccountRiskHead: async (id) => {
          const result = await client.query("SELECT * FROM account_risk_heads WHERE account_id = $1", [id]);
          const row = result.rows[0];
          if (!row) throw new Error(`No account_risk_heads row for ${id}`);
          return rowToAccountRiskHead(row);
        },
        getActiveRules: async (id) => {
          const result = await client.query(
            "SELECT * FROM rule_versions WHERE account_id = $1 AND is_active = true",
            [id],
          );
          return result.rows.map(rowToRuleVersion);
        },
        getOutstandingReservationTotal: async (id) => {
          const result = await client.query(
            "SELECT COALESCE(SUM(reserved_amount), 0) AS total FROM order_reservations WHERE account_id = $1 AND status = $2",
            [id, OrderReservationStatus.HELD],
          );
          return new Decimal(result.rows[0].total as string);
        },
        insertReservation: async (input: NewReservationInput) => {
          const result = await client.query(
            `INSERT INTO order_reservations (account_id, client_intent_id, reserved_amount, status)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [input.accountId, input.clientIntentId, input.reservedAmount.toString(), OrderReservationStatus.HELD],
          );
          return rowToOrderReservation(result.rows[0]);
        },
        isProtectionEnabled: async (id) => {
          const result = await client.query("SELECT protection_enabled FROM protected_accounts WHERE account_id = $1", [id]);
          return Boolean(result.rows[0]?.protection_enabled);
        },
        setProtectionEnabled: async (id, enabled) => {
          await client.query("UPDATE protected_accounts SET protection_enabled = $2 WHERE account_id = $1", [id, enabled]);
        },
      };

      const result = await fn(ctx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
