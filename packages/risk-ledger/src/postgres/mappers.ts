import { Decimal } from "decimal.js";
import type { AccountRiskHead, OrderReservation, RuleVersion, StateCheckpoint } from "@mypropguard/domain";
import { OrderReservationStatus, StateConfidence } from "@mypropguard/domain";

export function rowToAccountRiskHead(row: Record<string, unknown>): AccountRiskHead {
  return {
    accountId: row.account_id as string,
    equityStartOfDay: new Decimal(row.equity_start_of_day as string),
    currentEquity: new Decimal(row.current_equity as string),
    realizedPnlToday: new Decimal(row.realized_pnl_today as string),
    peakEquity: new Decimal(row.peak_equity as string),
    currentDrawdown: new Decimal(row.current_drawdown as string),
    openNotional: new Decimal(row.open_notional as string),
    leverage: new Decimal(row.leverage as string),
    tradeCountToday: Number(row.trade_count_today),
    lastTradeAt: row.last_trade_at ? new Date(row.last_trade_at as string) : null,
    version: Number(row.version),
  };
}

export function rowToRuleVersion(row: Record<string, unknown>): RuleVersion {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    ruleType: row.rule_type as RuleVersion["ruleType"],
    param: new Decimal(row.param as string),
    effectiveFrom: new Date(row.effective_from as string),
    isActive: row.is_active as boolean,
    createdAt: new Date(row.created_at as string),
  };
}

export function rowToOrderReservation(row: Record<string, unknown>): OrderReservation {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    clientIntentId: row.client_intent_id as string,
    reservedAmount: new Decimal(row.reserved_amount as string),
    status: row.status as OrderReservationStatus,
    createdAt: new Date(row.created_at as string),
    releasedAt: row.released_at ? new Date(row.released_at as string) : null,
  };
}

export function rowToStateCheckpoint(row: Record<string, unknown>): StateCheckpoint {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    confidence: row.confidence as StateConfidence,
    verifiedAt: new Date(row.verified_at as string),
  };
}
