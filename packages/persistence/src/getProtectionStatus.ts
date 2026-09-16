import type { ProtectionGateResult, RiskLedgerStore } from "@mypropguard/domain";
import { evaluateProtectionGate } from "@mypropguard/risk-engine";

/**
 * Phase 0/1 protection status: `stateConfidenceVerified` is hardcoded false
 * because there is no live venue state-ingestion/reconciliation yet (that's
 * Phase 2). Per the blueprint, "the UI must never show green protection
 * when authority/state continuity is unknown" — so until Phase 2 lands,
 * GET /v1/protection can honestly report account/rule configuration but
 * must always surface `walletNeedsAttention: true` and refuse
 * `botCanOpenNewTrades`.
 */
export async function getProtectionStatus(store: RiskLedgerStore, accountId: string): Promise<ProtectionGateResult> {
  return store.runExclusive(accountId, async (ctx) => {
    // Sequential: the Postgres-backed LedgerContext shares one client per
    // transaction, which cannot multiplex concurrent queries.
    const head = await ctx.getAccountRiskHead(accountId);
    const rules = await ctx.getActiveRules(accountId);
    const protectionEnabled = await ctx.isProtectionEnabled(accountId);

    return evaluateProtectionGate({
      accountRiskHead: head,
      rules,
      protectionEnabled,
      stateConfidenceVerified: false,
      lastVerifiedAt: new Date(0),
    });
  });
}
