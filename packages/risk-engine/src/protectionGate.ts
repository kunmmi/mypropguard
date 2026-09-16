import { Decimal } from "decimal.js";
import { ReasonCode, RuleType, type AccountRiskHead, type ProtectionGateResult, type RuleVersion } from "@mypropguard/domain";

export interface AccountProtectionInputs {
  accountRiskHead: AccountRiskHead;
  rules: readonly RuleVersion[];
  protectionEnabled: boolean;
  /** False whenever venue/account state continuity can't be verified (Phase 2 concept).
   * The UI must never show green protection when this is false. */
  stateConfidenceVerified: boolean;
  lastVerifiedAt: Date;
}

/**
 * Higher-level gate combining rule evaluation with account protection
 * status, backing the GET /v1/protection contract. Distinct from
 * RiskEngine.evaluate: this answers "can the bot trade at all right now",
 * not "is this specific order acceptable".
 */
export function evaluateProtectionGate(input: AccountProtectionInputs): ProtectionGateResult {
  const { accountRiskHead, rules, protectionEnabled, stateConfidenceVerified, lastVerifiedAt } = input;

  const dailyLossRule = rules.find((rule) => rule.ruleType === RuleType.MAX_DAILY_LOSS && rule.isActive);
  const maxLossToday = dailyLossRule?.param ?? new Decimal(0);
  const lossUsedToday = Decimal.max(0, accountRiskHead.equityStartOfDay.minus(accountRiskHead.currentEquity));

  if (!protectionEnabled) {
    return {
      protectionOn: false,
      botCanOpenNewTrades: false,
      walletNeedsAttention: false,
      blockingReason: ReasonCode.PROTECTION_OFF,
      maxLossToday,
      lossUsedToday,
      lastVerifiedAt,
    };
  }

  if (!stateConfidenceVerified) {
    return {
      protectionOn: true,
      botCanOpenNewTrades: false,
      walletNeedsAttention: true,
      blockingReason: ReasonCode.ACCOUNT_NEEDS_ATTENTION,
      maxLossToday,
      lossUsedToday,
      lastVerifiedAt,
    };
  }

  const budgetExhausted = maxLossToday.gt(0) && lossUsedToday.gte(maxLossToday);

  return {
    protectionOn: true,
    botCanOpenNewTrades: !budgetExhausted,
    walletNeedsAttention: false,
    blockingReason: budgetExhausted ? ReasonCode.DAILY_LOSS_BUDGET_EXCEEDED : null,
    maxLossToday,
    lossUsedToday,
    lastVerifiedAt,
  };
}
