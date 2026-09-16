import { Decimal } from "decimal.js";
export * from "./inMemoryRiskLedgerStore.js";
import {
  OrderSide,
  RuleType,
  type AccountRiskHead,
  type ProposedOrder,
  type RiskDay,
  type RuleVersion,
} from "@mypropguard/domain";

let ruleVersionSequence = 0;

export function buildAccountRiskHead(overrides: Partial<AccountRiskHead> = {}): AccountRiskHead {
  return {
    accountId: "acct_test_1",
    equityStartOfDay: new Decimal(10_000),
    currentEquity: new Decimal(10_000),
    realizedPnlToday: new Decimal(0),
    peakEquity: new Decimal(10_000),
    currentDrawdown: new Decimal(0),
    openNotional: new Decimal(0),
    leverage: new Decimal(0),
    tradeCountToday: 0,
    lastTradeAt: null,
    version: 1,
    ...overrides,
  };
}

export function buildRuleVersion(
  ruleType: RuleType,
  param: Decimal.Value,
  overrides: Partial<RuleVersion> = {},
): RuleVersion {
  ruleVersionSequence += 1;
  return {
    id: `rule_${ruleVersionSequence}`,
    accountId: "acct_test_1",
    ruleType,
    param: new Decimal(param),
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function buildProposedOrder(overrides: Partial<ProposedOrder> = {}): ProposedOrder {
  return {
    clientIntentId: "intent_1",
    coin: "BTC",
    side: OrderSide.BUY,
    size: new Decimal(1),
    price: new Decimal(50_000),
    reduceOnly: false,
    ...overrides,
  };
}

export function buildRiskDay(overrides: Partial<RiskDay> = {}): RiskDay {
  return {
    accountId: "acct_test_1",
    riskDate: "2026-09-15",
    startOfDayEquity: new Decimal(10_000),
    realizedPnl: new Decimal(0),
    tradeCount: 0,
    updatedAt: new Date("2026-09-15T00:00:00Z"),
    ...overrides,
  };
}
