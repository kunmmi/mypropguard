import { Decimal } from "decimal.js";
import type {
  OrderReservationStatus,
  OrderSide,
  RuleType,
} from "./enums.js";

/**
 * The per-account serialization root. Any mutation that can change whether
 * new risk may be opened must acquire this row's lock (see
 * packages/risk-ledger AccountRiskHeadRepository).
 */
export interface AccountRiskHead {
  accountId: string;
  /** Equity at the start of the current UTC risk day (excludes intraday capital flows). */
  equityStartOfDay: Decimal;
  currentEquity: Decimal;
  /** Realized + unrealized P&L for the current risk day, excluding deposits/withdrawals. */
  realizedPnlToday: Decimal;
  peakEquity: Decimal;
  currentDrawdown: Decimal;
  openNotional: Decimal;
  leverage: Decimal;
  tradeCountToday: number;
  lastTradeAt: Date | null;
  /** Optimistic-concurrency / row-lock version. */
  version: number;
}

/** Per-account, per-UTC-day rollover record used for daily-loss accounting. */
export interface RiskDay {
  accountId: string;
  riskDate: string; // YYYY-MM-DD, UTC
  startOfDayEquity: Decimal;
  realizedPnl: Decimal;
  tradeCount: number;
  updatedAt: Date;
}

export interface RuleVersion {
  id: string;
  accountId: string;
  ruleType: RuleType;
  /** Rule-specific numeric parameter (e.g. max daily loss amount, max leverage multiple). */
  param: Decimal;
  effectiveFrom: Date;
  isActive: boolean;
  createdAt: Date;
}

export interface OrderReservation {
  id: string;
  accountId: string;
  clientIntentId: string;
  /** Portion of the daily-loss/exposure budget this reservation holds. */
  reservedAmount: Decimal;
  status: OrderReservationStatus;
  createdAt: Date;
  releasedAt: Date | null;
}

export interface ProposedOrder {
  clientIntentId: string;
  coin: string;
  side: OrderSide;
  size: Decimal;
  price: Decimal;
  /** Explicit reduce-only flag from the caller; always bypasses risk-increasing caps. */
  reduceOnly: boolean;
}

export interface DecisionArtifact {
  outcome: "ALLOW" | "RESIZE" | "BLOCK";
  /** Present when outcome is RESIZE: the largest size that would be accepted. */
  approvedSize: Decimal | null;
  reasonCode: string;
  message: string;
  ruleType: RuleType | null;
  evaluatedAt: Date;
}

export interface ProtectionGateResult {
  protectionOn: boolean;
  botCanOpenNewTrades: boolean;
  walletNeedsAttention: boolean;
  blockingReason: string | null;
  maxLossToday: Decimal;
  lossUsedToday: Decimal;
  lastVerifiedAt: Date;
}
