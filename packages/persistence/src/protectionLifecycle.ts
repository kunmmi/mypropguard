import type { RiskLedgerStore } from "@mypropguard/domain";

export async function activateProtection(store: RiskLedgerStore, accountId: string): Promise<{ protectionOn: boolean }> {
  return store.runExclusive(accountId, async (ctx) => {
    await ctx.setProtectionEnabled(accountId, true);
    return { protectionOn: true };
  });
}

/**
 * Phase 0/1 deactivation is a plain toggle: there is no live agent/signer to
 * revoke yet (Phase 3+), so "safe drain" of outstanding risk before
 * deactivation is not yet meaningful — this must be revisited once
 * activation provisions a real execution agent.
 */
export async function deactivateProtection(
  store: RiskLedgerStore,
  accountId: string,
): Promise<{ protectionOn: boolean; drainedOutstandingRisk: boolean }> {
  return store.runExclusive(accountId, async (ctx) => {
    await ctx.setProtectionEnabled(accountId, false);
    return { protectionOn: false, drainedOutstandingRisk: false };
  });
}
