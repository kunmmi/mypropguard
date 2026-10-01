import { RuleType, type EvmGuardRuleSyncer, type EvmSafeEquityReader, type RiskLedgerStore } from "@mypropguard/domain";
import { reconcileEvmAccountEquity } from "./reconcileEvmAccountEquity.js";

export interface ReconcileAllResult {
  accountId: string;
  error?: unknown;
}

/**
 * The periodic sweep that actually makes max-daily-loss freezing live: without something calling
 * this on a clock, an account's equity (and therefore its freeze state) only ever updates when a
 * rule is added or removed. A clock-based sweep is necessary specifically because the loss this
 * enforces is equity-based, not just realized P&L from trades - a trader can breach their daily
 * loss purely by holding a token whose price drops, with no new trade ever happening to trigger a
 * recheck.
 *
 * Only reconciles accounts that actually have an active MAX_DAILY_LOSS rule (via
 * `listAccountsWithActiveRuleType`), not every EVM Safe account, so this doesn't burn RPC calls on
 * accounts that don't use the feature. One account's failure (e.g. an RPC hiccup) is caught and
 * reported rather than aborting the sweep for every other account.
 */
export async function reconcileAllEvmAccountsWithDailyLossRule(
  store: RiskLedgerStore,
  equityReaders: Record<number, EvmSafeEquityReader> | undefined,
  evmGuardSyncers: Record<number, EvmGuardRuleSyncer> | undefined,
): Promise<readonly ReconcileAllResult[]> {
  if (!equityReaders || Object.keys(equityReaders).length === 0) return [];

  const accounts = await store.listAccountsWithActiveRuleType(RuleType.MAX_DAILY_LOSS);
  const evmAccounts = accounts.filter((a) => a.evmSafeAddress && a.evmChainId != null && equityReaders[a.evmChainId]);

  const results: ReconcileAllResult[] = [];
  for (const account of evmAccounts) {
    try {
      await reconcileEvmAccountEquity(store, equityReaders, evmGuardSyncers, account.accountId);
      results.push({ accountId: account.accountId });
    } catch (error) {
      results.push({ accountId: account.accountId, error });
    }
  }
  return results;
}
