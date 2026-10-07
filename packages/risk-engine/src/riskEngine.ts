import { Decimal } from "decimal.js";
import {
  DecisionOutcome,
  ReasonCode,
  RuleType,
  type AccountRiskHead,
  type DecisionArtifact,
  type ProposedOrder,
  type RuleVersion,
} from "@mypropguard/domain";
import { classifyPositionTransition } from "./positionTransition.js";
import { solveSafeSize } from "./safeSize.js";

export interface ProjectedRiskInput {
  accountRiskHead: AccountRiskHead;
  /** Active rule set for the account. At most one RuleVersion per RuleType is expected. */
  rules: readonly RuleVersion[];
  proposedOrder: ProposedOrder;
  /** Signed existing position size for proposedOrder.coin (positive = long, negative = short). */
  currentPositionSize: Decimal;
}

const SIZEABLE_RULES_IN_EVALUATION_ORDER = [
  RuleType.MAX_POSITION_SIZE,
  RuleType.MAX_LEVERAGE,
  RuleType.MAX_EXPOSURE,
] as const;

const REASON_CODE_BY_RULE: Record<RuleType, string> = {
  [RuleType.MAX_DAILY_LOSS]: ReasonCode.DAILY_LOSS_BUDGET_EXCEEDED,
  [RuleType.MAX_DRAWDOWN]: ReasonCode.DRAWDOWN_LIMIT_EXCEEDED,
  [RuleType.MAX_LEVERAGE]: ReasonCode.LEVERAGE_CEILING_EXCEEDED,
  [RuleType.MAX_POSITION_SIZE]: ReasonCode.POSITION_SIZE_LIMIT_EXCEEDED,
  [RuleType.MAX_EXPOSURE]: ReasonCode.EXPOSURE_LIMIT_EXCEEDED,
  [RuleType.MAX_TRADE_FREQUENCY]: ReasonCode.TRADE_FREQUENCY_LIMIT_EXCEEDED,
  [RuleType.COOLDOWN]: ReasonCode.COOLDOWN_ACTIVE,
};

/** The active rule of this type. If several are active (older data), the most recently created one is the current limit. */
function findRule(rules: readonly RuleVersion[], ruleType: RuleType): RuleVersion | undefined {
  return rules
    .filter((rule) => rule.ruleType === ruleType && rule.isActive)
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
}

function decision(
  outcome: DecisionOutcome,
  reasonCode: string,
  message: string,
  ruleType: RuleType | null,
  approvedSize: Decimal | null = null,
): DecisionArtifact {
  return { outcome, approvedSize, reasonCode, message, ruleType, evaluatedAt: new Date() };
}

/**
 * Pure, deterministic risk decision. No network/database I/O: callers are
 * responsible for loading account state and rules, and for atomically
 * reserving budget once ALLOW/RESIZE is returned (see packages/risk-ledger).
 */
export function evaluate(input: ProjectedRiskInput): DecisionArtifact {
  const { accountRiskHead, rules, proposedOrder, currentPositionSize } = input;

  if (proposedOrder.reduceOnly) {
    return decision(
      DecisionOutcome.ALLOW,
      ReasonCode.REDUCE_ONLY_ALWAYS_ALLOWED,
      "Reduce-only orders are always permitted.",
      null,
    );
  }

  const transition = classifyPositionTransition(currentPositionSize, proposedOrder.side, proposedOrder.size);
  if (!transition.isRiskIncreasing) {
    return decision(
      DecisionOutcome.ALLOW,
      ReasonCode.REDUCE_ONLY_ALWAYS_ALLOWED,
      "Order reduces or closes existing risk and is always permitted.",
      null,
    );
  }

  // The Hyperliquid watcher has locked this account for the UTC day after a rule was broken: no new exposure
  // may be opened until it lifts at the next UTC day (closing and reducing were already allowed above).
  const lockedDay = accountRiskHead.enforcement?.lockedDay;
  if (lockedDay && lockedDay === new Date().toISOString().slice(0, 10)) {
    return decision(
      DecisionOutcome.BLOCK,
      ReasonCode.ACCOUNT_LOCKED_FOR_TODAY,
      `Account is locked for today (${accountRiskHead.enforcement?.reason ?? "a rule was broken"}). Existing positions can be reduced or closed.`,
      null,
    );
  }

  const cooldownRule = findRule(rules, RuleType.COOLDOWN);
  if (cooldownRule && accountRiskHead.lastTradeAt) {
    const cooldownEndsAt = accountRiskHead.lastTradeAt.getTime() + cooldownRule.param.toNumber() * 1000;
    if (Date.now() < cooldownEndsAt) {
      return decision(
        DecisionOutcome.BLOCK,
        ReasonCode.COOLDOWN_ACTIVE,
        "Account is in a mandatory cooldown period.",
        RuleType.COOLDOWN,
      );
    }
  }

  const frequencyRule = findRule(rules, RuleType.MAX_TRADE_FREQUENCY);
  if (frequencyRule && accountRiskHead.tradeCountToday >= frequencyRule.param.toNumber()) {
    return decision(
      DecisionOutcome.BLOCK,
      ReasonCode.TRADE_FREQUENCY_LIMIT_EXCEEDED,
      "Maximum trade frequency for today has been reached.",
      RuleType.MAX_TRADE_FREQUENCY,
    );
  }

  const dailyLossRule = findRule(rules, RuleType.MAX_DAILY_LOSS);
  if (dailyLossRule) {
    const lossToday = Decimal.max(0, accountRiskHead.equityStartOfDay.minus(accountRiskHead.currentEquity));
    if (lossToday.gte(dailyLossRule.param)) {
      return decision(
        DecisionOutcome.BLOCK,
        ReasonCode.DAILY_LOSS_BUDGET_EXCEEDED,
        "Daily loss budget has been exhausted.",
        RuleType.MAX_DAILY_LOSS,
      );
    }
  }

  const drawdownRule = findRule(rules, RuleType.MAX_DRAWDOWN);
  if (drawdownRule && accountRiskHead.peakEquity.gt(0)) {
    const drawdown = Decimal.max(0, accountRiskHead.peakEquity.minus(accountRiskHead.currentEquity)).div(
      accountRiskHead.peakEquity,
    );
    if (drawdown.gte(drawdownRule.param)) {
      return decision(
        DecisionOutcome.BLOCK,
        ReasonCode.DRAWDOWN_LIMIT_EXCEEDED,
        "Maximum drawdown limit has been breached.",
        RuleType.MAX_DRAWDOWN,
      );
    }
  }

  const notional = proposedOrder.size.times(proposedOrder.price);
  const existingNotional = accountRiskHead.openNotional;

  for (const ruleType of SIZEABLE_RULES_IN_EVALUATION_ORDER) {
    const rule = findRule(rules, ruleType);
    if (!rule) continue;

    const capNotional = ruleType === RuleType.MAX_LEVERAGE ? rule.param.times(accountRiskHead.currentEquity) : rule.param;
    const projectedNotional = existingNotional.plus(notional);
    if (projectedNotional.lte(capNotional)) continue;

    const safeSize = solveSafeSize({
      ruleType,
      param: rule.param,
      existingNotional,
      equity: accountRiskHead.currentEquity,
      price: proposedOrder.price,
      proposedSize: proposedOrder.size,
    });

    if (safeSize === null) {
      return decision(
        DecisionOutcome.BLOCK,
        REASON_CODE_BY_RULE[ruleType],
        `${ruleType} cap leaves no room for this order.`,
        ruleType,
      );
    }

    return decision(
      DecisionOutcome.RESIZE,
      REASON_CODE_BY_RULE[ruleType],
      `Order resized to stay within ${ruleType} cap.`,
      ruleType,
      safeSize,
    );
  }

  return decision(DecisionOutcome.ALLOW, ReasonCode.WITHIN_LIMITS, "Order is within all active limits.", null);
}
