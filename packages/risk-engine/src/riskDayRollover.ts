import { Decimal } from "decimal.js";
import type { RiskDay } from "@mypropguard/domain";

/**
 * Starts a fresh UTC risk day for an account. The new day's loss budget is
 * anchored to the equity actually verified at rollover time (not carried
 * over from the previous day's realizedPnl), so yesterday's losses/gains
 * cannot leak into today's daily-loss accounting.
 */
export function rolloverRiskDay(accountId: string, newRiskDate: string, verifiedEquity: Decimal): RiskDay {
  return {
    accountId,
    riskDate: newRiskDate,
    startOfDayEquity: verifiedEquity,
    realizedPnl: new Decimal(0),
    tradeCount: 0,
    updatedAt: new Date(),
  };
}

export function isNewRiskDay(previous: RiskDay | null, currentRiskDate: string): boolean {
  return previous === null || previous.riskDate !== currentRiskDate;
}
