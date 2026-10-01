import { Decimal } from "decimal.js";
import {
  RuleType,
  StateConfidence,
  type AccountRiskHead,
  type EvmGuardRuleSyncer,
  type EvmSafeEquityReader,
  type RiskLedgerStore,
} from "@mypropguard/domain";
import { checkAndEnforceDailyLossFreeze } from "./checkAndEnforceDailyLossFreeze.js";

export class EvmAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account ${accountId} is not an EVM Safe account, or has no EVM equity reader configured for its chain.`);
    this.name = "EvmAccountNotFoundError";
  }
}

/**
 * The EVM-chain equivalent of reconcileAccountFromVenue: reads an EVM Safe's live on-chain USD
 * equity and folds it into `account_risk_heads`, the same way Hyperliquid accounts get their
 * equity from the venue's Info API. Values only the tokens the account has an active
 * MAX_POSITION_SIZE rule for (see EvmEquityQuery's NatSpec) - there's no general way to enumerate
 * every token a Safe holds.
 *
 * Immediately re-checks the max-daily-loss freeze state afterward (see
 * checkAndEnforceDailyLossFreeze) - this is the one function that actually makes that freeze
 * mechanism live, by giving it a real, current `currentEquity` to compare against instead of
 * whatever the account's equity was when it was created.
 */
export async function reconcileEvmAccountEquity(
  store: RiskLedgerStore,
  equityReaders: Record<number, EvmSafeEquityReader> | undefined,
  evmGuardSyncers: Record<number, EvmGuardRuleSyncer> | undefined,
  accountId: string,
): Promise<AccountRiskHead> {
  const account = await store.findAccountById(accountId);
  if (!account?.evmSafeAddress || account.evmChainId == null) {
    throw new EvmAccountNotFoundError(accountId);
  }

  const reader = equityReaders?.[account.evmChainId];
  if (!reader) {
    throw new EvmAccountNotFoundError(accountId);
  }

  const safeAddress = account.evmSafeAddress;

  const updatedHead = await store.runExclusive(accountId, async (ctx) => {
    const [head, rules] = await Promise.all([ctx.getAccountRiskHead(accountId), ctx.getActiveRules(accountId)]);
    const trackedTokens = [
      ...new Set(
        rules
          .filter((r) => r.ruleType === RuleType.MAX_POSITION_SIZE && r.tokenAddress)
          .map((r) => r.tokenAddress as string),
      ),
    ];

    const equityUsd = await reader.getEquityUsd({ safeAddress, trackedTokens });

    const updated: AccountRiskHead = {
      ...head,
      currentEquity: equityUsd,
      peakEquity: Decimal.max(head.peakEquity, equityUsd),
    };
    await ctx.updateAccountRiskHead(updated);
    await ctx.recordStateCheckpoint({ accountId, confidence: StateConfidence.VERIFIED, verifiedAt: new Date() });
    return updated;
  });

  await checkAndEnforceDailyLossFreeze(store, accountId, evmGuardSyncers);

  return updatedHead;
}
