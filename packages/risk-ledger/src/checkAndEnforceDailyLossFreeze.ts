import { Decimal } from "decimal.js";
import { RuleType, type EvmGuardRuleSyncer, type RiskLedgerStore } from "@mypropguard/domain";

/**
 * Freezes or unfreezes an EVM Safe account's on-chain Guard based on whether it has breached its
 * MAX_DAILY_LOSS rule - the "backend-signed attestation" compromise documented in
 * packages/evm-guard/ROADMAP.md (max daily loss needs P&L across multiple trades, which a Guard
 * can't see from a single transaction's calldata alone, so MyPropGuard's own backend decides and
 * the Guard just enforces whatever it's told).
 *
 * Uses the exact same `equityStartOfDay - currentEquity >= maxDailyLoss` comparison as
 * packages/risk-engine's RiskEngine, for consistency with how Hyperliquid accounts are already
 * blocked - but for an EVM account, `currentEquity` only reflects reality once something feeds the
 * Safe's live on-chain USD value into `account_risk_heads` (an EVM equivalent of
 * `reconcileAccountFromVenue`, which doesn't exist yet - see the ROADMAP for why: pricing
 * arbitrary ERC-20 holdings needs a price oracle, a separate, still-undecided piece of work). Until
 * that exists, this function is correct and tested, but has no live data to act on for a real EVM
 * account - call sites should not assume it reflects live trading activity yet.
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

  await syncer.setFrozen(account.evmSafeAddress, isBreached);
}
