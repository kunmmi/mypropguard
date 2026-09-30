import type { ProtectedAccount, RiskLedgerStore } from "@mypropguard/domain";

/** Lists accounts owned by one user. */
export async function listAccounts(store: RiskLedgerStore, ownerUserId: string): Promise<readonly ProtectedAccount[]> {
  return store.listAccounts(ownerUserId);
}
