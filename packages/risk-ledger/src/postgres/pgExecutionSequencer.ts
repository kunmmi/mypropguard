import type pg from "pg";
import type { ExecutionSequencer, NonceLease } from "@mypropguard/domain";

/**
 * Postgres-backed durable nonce sequencer. Nonces are current-millisecond
 * timestamps (Hyperliquid rejects anything lower than the last one it saw
 * for a given user - confirmed for real against testnet), monotonically
 * increasing per account even across server restarts, which an in-memory
 * counter cannot guarantee.
 *
 * The single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is atomic at
 * the row level in Postgres - concurrent leases for the same account
 * serialize on that row without needing a separate application-level lock
 * or transaction, the same guarantee InMemoryExecutionSequencer's mutex
 * gives in memory.
 */
export class PgExecutionSequencer implements ExecutionSequencer {
  constructor(private readonly pool: pg.Pool) {}

  async leaseNonce(accountId: string): Promise<NonceLease> {
    const candidate = Date.now();
    const result = await this.pool.query(
      `INSERT INTO nonce_leases (account_id, last_nonce)
       VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE
       SET last_nonce = GREATEST(nonce_leases.last_nonce + 1, EXCLUDED.last_nonce), updated_at = now()
       RETURNING last_nonce`,
      [accountId, candidate],
    );

    return { accountId, nonce: Number(result.rows[0].last_nonce), leasedAt: new Date() };
  }
}
