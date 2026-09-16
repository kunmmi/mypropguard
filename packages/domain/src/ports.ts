import { Decimal } from "decimal.js";
import type { AccountRiskHead, OrderReservation, RuleVersion } from "./entities.js";
import type { RuleType, StateConfidence } from "./enums.js";

export interface NewReservationInput {
  accountId: string;
  clientIntentId: string;
  reservedAmount: Decimal;
}

export interface NewAccountRuleInput {
  ruleType: RuleType;
  param: Decimal;
}

export interface NewAccountInput {
  accountId: string;
  ownerUserId: string;
  venue: string;
  /** Starting equity snapshot the owner declares at provisioning time (no live venue read yet — Phase 2). */
  initialEquity: Decimal;
  initialRules: readonly NewAccountRuleInput[];
}

/**
 * The transactional context available inside a `RiskLedgerStore.runExclusive`
 * critical section: everything a caller needs to make and record a risk
 * decision for one account, without knowing whether it's backed by
 * Postgres row-locking or an in-memory test double.
 */
export interface LedgerContext {
  getAccountRiskHead(accountId: string): Promise<AccountRiskHead>;
  updateAccountRiskHead(head: AccountRiskHead): Promise<void>;
  getActiveRules(accountId: string): Promise<readonly RuleVersion[]>;
  /** Sum of reservedAmount for all HELD reservations on this account. */
  getOutstandingReservationTotal(accountId: string): Promise<Decimal>;
  insertReservation(input: NewReservationInput): Promise<OrderReservation>;
  isProtectionEnabled(accountId: string): Promise<boolean>;
  setProtectionEnabled(accountId: string, enabled: boolean): Promise<void>;
  recordStateCheckpoint(checkpoint: NewStateCheckpointInput): Promise<void>;
  getLatestStateCheckpoint(accountId: string): Promise<StateCheckpoint | null>;
}

export interface NewStateCheckpointInput {
  accountId: string;
  confidence: StateConfidence;
  verifiedAt: Date;
}

export interface StateCheckpoint extends NewStateCheckpointInput {
  id: string;
}

/** One position on a venue, as read from that venue's public account-state API. */
export interface VenuePosition {
  coin: string;
  /** Signed size: positive = long, negative = short. */
  size: Decimal;
  positionValue: Decimal;
  leverage: Decimal;
}

/** Venue-native account snapshot, normalized just enough to feed AccountRiskHead. */
export interface ClearinghouseState {
  accountValue: Decimal;
  totalMarginUsed: Decimal;
  /** Aggregate absolute notional across all open positions. */
  totalNotionalPosition: Decimal;
  withdrawable: Decimal;
  positions: readonly VenuePosition[];
}

/**
 * A read-only venue state reader (Phase 2). Deliberately narrow: no
 * signing, no order placement — just public account-state reads. Hyperliquid
 * implements this in packages/hyperliquid; other venues can add their own
 * later without changing the reconciliation orchestrator.
 */
export interface VenueStateReader {
  getClearinghouseState(address: string): Promise<ClearinghouseState>;
}

/**
 * The core concurrency contract from the blueprint: `account_risk_heads` is
 * the per-account serialization root, so any mutation that can change
 * whether new risk may be opened must run inside an exclusive critical
 * section for that account. A Postgres-backed implementation achieves this
 * with `SELECT ... FOR UPDATE`; an in-memory implementation can use a plain
 * mutex — both must guarantee only one `fn` runs at a time per accountId.
 */
export interface RiskLedgerStore {
  runExclusive<T>(accountId: string, fn: (ctx: LedgerContext) => Promise<T>): Promise<T>;
  /** Provisions a brand-new account. Throws AccountAlreadyExistsError on a duplicate accountId. */
  createAccount(input: NewAccountInput): Promise<void>;
}

export class AccountAlreadyExistsError extends Error {
  constructor(public readonly accountId: string) {
    super(`Account already exists: ${accountId}`);
    this.name = "AccountAlreadyExistsError";
  }
}
