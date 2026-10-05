import { Decimal } from "decimal.js";
import type {
  OrderReservationStatus,
  OrderSide,
  RuleType,
} from "./enums.js";

/** A provisioned account's identity/ownership record - separate from AccountRiskHead, which is the risk numbers. */
export interface ProtectedAccount {
  accountId: string;
  ownerUserId: string;
  venue: string;
  protectionEnabled: boolean;
  createdAt: Date;
  /**
   * This account's own delegated signing wallet, provisioned automatically
   * at creation - null until an AgentWalletProvisioner is configured
   * (offline scaffold has none). When set, apps/api's resolveSignerForAccount
   * and its order-lifecycle siblings sign/submit/cancel/read status through
   * THIS wallet instead of the single server-wide fallback signer - see
   * AppDeps.signerFactory/orderLifecycleFactory. This is also the address a
   * user needs to approve on Hyperliquid.
   */
  agentWalletId: string | null;
  agentWalletAddress: string | null;
  /**
   * For EVM-chain venues only (e.g. "arbitrum-gmx", "bsc-pancakeswap", "ethereum-uniswap"): the
   * trader's own wallet address, which owns the provisioned Safe below. MyPropGuard never holds
   * this address's key - contrast with agentWalletAddress, which MyPropGuard's Privy wallet
   * fully controls.
   */
  evmOwnerWalletAddress: string | null;
  /** The Safe address provisioned for this account - what the trader connects to the exchange's own UI with (see packages/evm-guard). Null for non-EVM venues. */
  evmSafeAddress: string | null;
  /** Which EVM chain evmSafeAddress was deployed on. Null unless evmSafeAddress is set. */
  evmChainId: number | null;
}

/**
 * The per-account serialization root. Any mutation that can change whether
 * new risk may be opened must acquire this row's lock (see
 * packages/risk-ledger AccountRiskHeadRepository).
 */
/**
 * EVM (Safe) accounts only: what is needed to turn raw on-chain balances into a daily profit/loss
 * number that deposits and withdrawals cannot distort. See reconcileEvmAccountEquity.
 */
export interface EvmFlowState {
  /** The UTC date (YYYY-MM-DD) that `equityStartOfDay` is anchored to. */
  day: string;
  /** The block the last reconcile read the chain at. */
  cursorBlock: number;
  /**
   * Net USD value of capital moved in (+) and out (-) since the account's first reconcile, each flow
   * valued when it was first observed. `currentEquity` is reported net of this, so a deposit is not
   * a gain and a withdrawal is not a loss.
   */
  cumulativeFlowUsd: Decimal;
  /** ERC-20s found in the Safe by token discovery, so they can be valued. */
  knownTokens: string[];
  /** The Safe's transaction count at the last reconcile. Unchanged means no Safe transaction ran since. */
  lastNonce: number;
  /** Raw balance of each watched asset at the last reconcile (address(0) = the native coin), as decimal strings. */
  lastBalances: Record<string, string>;
  /** The Guard's running withdrawal total per asset at the last reconcile, as decimal strings. */
  lastWithdrawn: Record<string, string>;
}

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
  /** EVM Safe accounts only; null/absent for every other account. */
  evmFlowState?: EvmFlowState | null;
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
  /**
   * For MAX_POSITION_SIZE rules on EVM spot venues only (e.g. "bsc-pancakeswap",
   * "ethereum-uniswap"): which ERC-20 token `param` limits per-trade spend in - those Guards'
   * setTokenLimit is per-token, so one generic number isn't enough to describe the rule. Null for
   * every other rule type/venue (Hyperliquid and GMX have no per-token concept here).
   */
  tokenAddress: string | null;
  effectiveFrom: Date;
  isActive: boolean;
  createdAt: Date;
}

export interface OrderReservation {
  id: string;
  accountId: string;
  clientIntentId: string;
  coin: string;
  /** Portion of the daily-loss/exposure budget this reservation holds. */
  reservedAmount: Decimal;
  status: OrderReservationStatus;
  createdAt: Date;
  releasedAt: Date | null;
  /** Set once the authorized action is actually submitted to a venue and accepted. Null until then. */
  venueOrderId: string | null;
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
