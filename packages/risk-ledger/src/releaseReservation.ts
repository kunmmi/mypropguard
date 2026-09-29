import type { RiskLedgerStore } from "@mypropguard/domain";

/**
 * Releases a HELD reservation back to the account's available budget.
 * Runs inside the same per-account critical section reserveOrder uses, so a
 * release can never race a concurrent reservation attempt reading a stale
 * outstanding total.
 *
 * The gap this closes: reserveOrder commits a reservation as its own
 * transaction, separate from whatever happens next (e.g. execution's
 * sign/submit pipeline). If that next step fails - a signer refusal, a
 * network error, an expired authorization - the reservation was already
 * spent against the account's daily budget for a trade that never happened.
 * Call this whenever a reservation's downstream step fails, so a failed
 * signature doesn't silently and permanently eat into real risk budget.
 */
export async function releaseReservation(store: RiskLedgerStore, accountId: string, reservationId: string): Promise<void> {
  await store.runExclusive(accountId, (ctx) => ctx.releaseReservation(reservationId));
}
