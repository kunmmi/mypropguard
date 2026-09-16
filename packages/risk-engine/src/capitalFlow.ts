import { Decimal } from "decimal.js";
import { CapitalFlowType } from "@mypropguard/domain";
import type { RiskDay } from "@mypropguard/domain";

export interface CapitalFlowEvent {
  type: CapitalFlowType;
  /** Signed amount: positive for deposits/profit, negative for withdrawals/loss. */
  amount: Decimal;
}

/**
 * Applies a batch of classified account events to a risk day's accounting.
 * Deposits/withdrawals shift the equity baseline but must NEVER be counted
 * as trading P&L, so they can't accidentally consume or pad the owner's
 * daily-loss budget (the doc calls this out repeatedly as a required
 * separation between capital flows and trading performance).
 */
export function applyCapitalFlowsToRiskDay(riskDay: RiskDay, events: readonly CapitalFlowEvent[]): RiskDay {
  let realizedPnl = riskDay.realizedPnl;
  let startOfDayEquity = riskDay.startOfDayEquity;

  for (const event of events) {
    if (event.type === CapitalFlowType.TRADING_PNL) {
      realizedPnl = realizedPnl.plus(event.amount);
    } else {
      startOfDayEquity = startOfDayEquity.plus(event.amount);
    }
  }

  return { ...riskDay, realizedPnl, startOfDayEquity, updatedAt: new Date() };
}
