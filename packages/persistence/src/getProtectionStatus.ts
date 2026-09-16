import { StateConfidence, type ProtectionGateResult, type RiskLedgerStore } from "@mypropguard/domain";
import { evaluateProtectionGate } from "@mypropguard/risk-engine";

/**
 * How long a VERIFIED reconciliation (see reconcileAccountFromVenue) stays
 * trusted before ProtectionGate must treat state as unknown again. Phase 2
 * reconciliation is on-demand/polled, not a continuous WebSocket stream
 * (that's a later scale-out step per the blueprint), so this window bounds
 * how stale "verified" is allowed to mean in practice.
 */
const STATE_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

/**
 * Per the blueprint, "the UI must never show green protection when
 * authority/state continuity is unknown". Before Phase 2's first
 * reconciliation for an account, there is no checkpoint at all, so
 * `botCanOpenNewTrades` stays false and `walletNeedsAttention` stays true —
 * exactly the same honest behavior as before Phase 2 existed, but now it
 * flips to true once a fresh VERIFIED checkpoint exists.
 */
export async function getProtectionStatus(store: RiskLedgerStore, accountId: string): Promise<ProtectionGateResult> {
  return store.runExclusive(accountId, async (ctx) => {
    // Sequential: the Postgres-backed LedgerContext shares one client per
    // transaction, which cannot multiplex concurrent queries.
    const head = await ctx.getAccountRiskHead(accountId);
    const rules = await ctx.getActiveRules(accountId);
    const protectionEnabled = await ctx.isProtectionEnabled(accountId);
    const checkpoint = await ctx.getLatestStateCheckpoint(accountId);

    const isFresh = checkpoint !== null && Date.now() - checkpoint.verifiedAt.getTime() <= STATE_FRESHNESS_WINDOW_MS;
    const stateConfidenceVerified = checkpoint?.confidence === StateConfidence.VERIFIED && isFresh;

    return evaluateProtectionGate({
      accountRiskHead: head,
      rules,
      protectionEnabled,
      stateConfidenceVerified,
      lastVerifiedAt: checkpoint?.verifiedAt ?? new Date(0),
    });
  });
}
