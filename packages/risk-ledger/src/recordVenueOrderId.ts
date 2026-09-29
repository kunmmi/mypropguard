import type { RiskLedgerStore } from "@mypropguard/domain";

/**
 * Records the venue's own order id on a reservation once its authorized
 * action is actually submitted and accepted. Runs inside the same
 * per-account critical section as reserveOrder/releaseReservation.
 */
export async function recordVenueOrderId(
  store: RiskLedgerStore,
  accountId: string,
  reservationId: string,
  venueOrderId: string,
): Promise<void> {
  await store.runExclusive(accountId, (ctx) => ctx.recordVenueOrderId(reservationId, venueOrderId));
}
