import type pg from "pg";
import { Decimal } from "decimal.js";
import {
  AccountAlreadyExistsError,
  OrderReservationStatus,
  type LedgerContext,
  type NewAccountInput,
  type NewAccountRuleInput,
  type NewReservationInput,
  type NewStateCheckpointInput,
  type OrderReservation,
  type ProtectedAccount,
  type RiskLedgerStore,
  type RuleType,
} from "@mypropguard/domain";
import {
  evmFlowStateToJson,
  venueFlowStateToJson,
  rowToAccountRiskHead,
  rowToOrderReservation,
  rowToProtectedAccount,
  rowToRuleVersion,
  rowToStateCheckpoint,
} from "./mappers.js";

const POSTGRES_UNIQUE_VIOLATION = "23505";

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
        updateAccountRiskHead: async (head) => {
          // evm_flow_state is only written when the head carries it, so accounts that never use it (and a
          // database that has not had migration 0009 yet) are unaffected.
          const writesEvm = head.evmFlowState !== undefined;
          const writesVenue = head.venueFlowState !== undefined;
          const evmParam = 11;
          const venueParam = writesEvm ? 12 : 11;
          await client.query(
            `UPDATE account_risk_heads SET
               equity_start_of_day = $2, current_equity = $3, realized_pnl_today = $4,
               peak_equity = $5, current_drawdown = $6, open_notional = $7, leverage = $8,
               trade_count_today = $9, last_trade_at = $10,
               ${writesEvm ? `evm_flow_state = $${evmParam}::jsonb,` : ""}
               ${writesVenue ? `venue_flow_state = $${venueParam}::jsonb,` : ""}
               version = version + 1, updated_at = now()
             WHERE account_id = $1`,
            [
              head.accountId,
              head.equityStartOfDay.toString(),
              head.currentEquity.toString(),
              head.realizedPnlToday.toString(),
              head.peakEquity.toString(),
              head.currentDrawdown.toString(),
              head.openNotional.toString(),
              head.leverage.toString(),
              head.tradeCountToday,
              head.lastTradeAt,
              ...(writesEvm ? [evmFlowStateToJson(head.evmFlowState)] : []),
              ...(writesVenue ? [venueFlowStateToJson(head.venueFlowState)] : []),
            ],
          );
        },
        getActiveRules: async (id) => {
          const result = await client.query(
            "SELECT * FROM rule_versions WHERE account_id = $1 AND is_active = true",
            [id],
          );
          return result.rows.map(rowToRuleVersion);
        },
        insertRule: async (accountId: string, input: NewAccountRuleInput) => {
          const result = await client.query(
            "INSERT INTO rule_versions (account_id, rule_type, param, token_address) VALUES ($1, $2, $3, $4) RETURNING *",
            [accountId, input.ruleType, input.param.toString(), input.tokenAddress ?? null],
          );
          return rowToRuleVersion(result.rows[0]);
        },
        deactivateRule: async (ruleId: string) => {
          await client.query("UPDATE rule_versions SET is_active = false WHERE id = $1 AND is_active = true", [ruleId]);
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
            `INSERT INTO order_reservations (account_id, client_intent_id, coin, reserved_amount, status)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [input.accountId, input.clientIntentId, input.coin, input.reservedAmount.toString(), OrderReservationStatus.HELD],
          );
          return rowToOrderReservation(result.rows[0]);
        },
        releaseReservation: async (reservationId: string) => {
          await client.query(
            `UPDATE order_reservations SET status = $2, released_at = now()
             WHERE id = $1 AND status = $3`,
            [reservationId, OrderReservationStatus.RELEASED, OrderReservationStatus.HELD],
          );
        },
        recordVenueOrderId: async (reservationId: string, venueOrderId: string) => {
          await client.query("UPDATE order_reservations SET venue_order_id = $2 WHERE id = $1", [
            reservationId,
            venueOrderId,
          ]);
        },
        isProtectionEnabled: async (id) => {
          const result = await client.query("SELECT protection_enabled FROM protected_accounts WHERE account_id = $1", [id]);
          return Boolean(result.rows[0]?.protection_enabled);
        },
        setProtectionEnabled: async (id, enabled) => {
          await client.query("UPDATE protected_accounts SET protection_enabled = $2 WHERE account_id = $1", [id, enabled]);
        },
        recordStateCheckpoint: async (input: NewStateCheckpointInput) => {
          await client.query(
            "INSERT INTO state_checkpoints (account_id, confidence, verified_at) VALUES ($1, $2, $3)",
            [input.accountId, input.confidence, input.verifiedAt],
          );
        },
        getLatestStateCheckpoint: async (id) => {
          const result = await client.query(
            "SELECT * FROM state_checkpoints WHERE account_id = $1 ORDER BY verified_at DESC LIMIT 1",
            [id],
          );
          return result.rows[0] ? rowToStateCheckpoint(result.rows[0]) : null;
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

  async findReservationById(reservationId: string): Promise<OrderReservation | null> {
    const result = await this.pool.query("SELECT * FROM order_reservations WHERE id = $1", [reservationId]);
    return result.rows[0] ? rowToOrderReservation(result.rows[0]) : null;
  }

  async listAccounts(ownerUserId: string): Promise<readonly ProtectedAccount[]> {
    const result = await this.pool.query(
      "SELECT * FROM protected_accounts WHERE owner_user_id = $1 ORDER BY created_at DESC",
      [ownerUserId],
    );
    return result.rows.map(rowToProtectedAccount);
  }

  async findAccountById(accountId: string): Promise<ProtectedAccount | null> {
    const result = await this.pool.query("SELECT * FROM protected_accounts WHERE account_id = $1", [accountId]);
    return result.rows[0] ? rowToProtectedAccount(result.rows[0]) : null;
  }

  async listAccountsWithActiveRuleType(ruleType: RuleType): Promise<readonly ProtectedAccount[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT pa.* FROM protected_accounts pa
       JOIN rule_versions rv ON rv.account_id = pa.account_id
       WHERE rv.rule_type = $1 AND rv.is_active = true`,
      [ruleType],
    );
    return result.rows.map(rowToProtectedAccount);
  }

  async createAccount(input: NewAccountInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO protected_accounts (account_id, owner_user_id, venue, protection_enabled, agent_wallet_id, agent_wallet_address, evm_owner_wallet_address, evm_safe_address, evm_chain_id)
           VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8)`,
          [
            input.accountId,
            input.ownerUserId,
            input.venue,
            input.agentWalletId ?? null,
            input.agentWalletAddress ?? null,
            input.evmOwnerWalletAddress ?? null,
            input.evmSafeAddress ?? null,
            input.evmChainId ?? null,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AccountAlreadyExistsError(input.accountId);
        }
        throw error;
      }

      const equity = input.initialEquity.toString();
      await client.query(
        `INSERT INTO account_risk_heads (account_id, equity_start_of_day, current_equity, peak_equity, open_notional)
         VALUES ($1, $2, $2, $2, 0)`,
        [input.accountId, equity],
      );

      for (const rule of input.initialRules) {
        await client.query(
          "INSERT INTO rule_versions (account_id, rule_type, param, token_address) VALUES ($1, $2, $3, $4)",
          [input.accountId, rule.ruleType, rule.param.toString(), rule.tokenAddress ?? null],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === POSTGRES_UNIQUE_VIOLATION;
}
