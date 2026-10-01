import { Decimal } from "decimal.js";
import { RuleType, type EvmGuardRuleSyncer, type RiskLedgerStore } from "@mypropguard/domain";

/**
 * Reports a MAX_DAILY_LOSS breach to an EVM Safe account's on-chain Guard - the "backend-signed
 * attestation" compromise documented in packages/evm-guard/ROADMAP.md (max daily loss needs P&L
 * across multiple trades, which a Guard can't see from a single transaction's calldata alone, so
 * MyPropGuard's own backend decides and the Guard just enforces whatever it's told).
 *
 * Deliberately one-directional, matching the contract: this only ever calls `freezeForToday` when
 * breached, and does nothing at all when not breached. There is no "unfreeze" call to make - once
 * recorded, a freeze can only ever lift on its own at the next UTC day, and no one (including this
 * function, including the admin key) can clear it early. This was a deliberate product decision:
 * the backend reports breaches, but never controls when a freeze ends.
 *
 * Uses the exact same `equityStartOfDay - currentEquity >= maxDailyLoss` comparison as
 * packages/risk-engine's RiskEngine, for consistency with how Hyperliquid accounts are already
 * blocked - but for an EVM account, `currentEquity` only reflects reality once something feeds the
 * Safe's live on-chain USD value into `account_risk_heads` (see reconcileEvmAccountEquity).
 *
 * No-op (does not call the syncer) when the account has no evmSafeAddress/evmChainId, or when no
 * syncer is configured for that chain - same "absent config = no-op" convention as the rest of the
 * EVM wiring.
 */
export async function checkAndEnforceDailyLossFreeze(
  store: RiskLedgerStore,
  accountId: string,
  evmGuardSyncers: Record<number, EvmGuardRuleSyncer> | undefined,
): Promise<void> {
  const account = await store.findAccountById(accountId);
  if (!account?.evmSafeAddress || account.evmChainId == null) return;

  const syncer = evmGuardSyncers?.[account.evmChainId];
  if (!syncer) return;

  const isBreached = await store.runExclusive(accountId, async (ctx) => {
    const [head, rules] = await Promise.all([ctx.getAccountRiskHead(accountId), ctx.getActiveRules(accountId)]);
    const dailyLossRule = rules.find((r) => r.ruleType === RuleType.MAX_DAILY_LOSS);
    if (!dailyLossRule) return false;

    const lossToday = Decimal.max(0, head.equityStartOfDay.minus(head.currentEquity));
    return lossToday.gte(dailyLossRule.param);
  });

  if (isBreached) {
    await syncer.freezeForToday(account.evmSafeAddress);
  }
}
