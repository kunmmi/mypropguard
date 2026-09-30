import { Decimal } from "decimal.js";
import type { AccountRiskHead, OrderReservation, ProtectedAccount, RuleVersion } from "./entities.js";
import type { OrderSide, RuleType, StateConfidence } from "./enums.js";

export interface NewReservationInput {
  accountId: string;
  clientIntentId: string;
  coin: string;
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
  /** Adds a new rule version to this account's active mandate. */
  insertRule(accountId: string, input: NewAccountRuleInput): Promise<RuleVersion>;
  /** Deactivates a rule so it no longer applies to future risk decisions. No-op if already inactive - idempotent, same as releaseReservation. */
  deactivateRule(ruleId: string): Promise<void>;
  /** Sum of reservedAmount for all HELD reservations on this account. */
  getOutstandingReservationTotal(accountId: string): Promise<Decimal>;
  insertReservation(input: NewReservationInput): Promise<OrderReservation>;
  /**
   * Releases a HELD reservation (e.g. after signing fails downstream) so it
   * stops counting against getOutstandingReservationTotal. No-op if the
   * reservation is already CONSUMED or RELEASED - releasing is idempotent,
   * never a hard error, since a caller retrying cleanup after a partial
   * failure must be safe to call twice.
   */
  releaseReservation(reservationId: string): Promise<void>;
  /** Records the venue's own order id once a reservation's authorized action is actually submitted and accepted. */
  recordVenueOrderId(reservationId: string, venueOrderId: string): Promise<void>;
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
  /**
   * Cross-account lookup by reservation id, for routes that only receive an
   * orderId (e.g. GET /v1/orders/:id) and don't yet know which account it
   * belongs to. Read-only - doesn't need the per-account exclusive lock.
   * Returns null if no reservation with that id exists.
   */
  findReservationById(reservationId: string): Promise<OrderReservation | null>;
  /** Lists accounts owned by one user. Read-only, no per-account lock needed. */
  listAccounts(ownerUserId: string): Promise<readonly ProtectedAccount[]>;
}

export class AccountAlreadyExistsError extends Error {
  constructor(public readonly accountId: string) {
    super(`Account already exists: ${accountId}`);
    this.name = "AccountAlreadyExistsError";
  }
}

/**
 * ---------------------------------------------------------------------
 * Phase 3 SCAFFOLD ONLY — architecture, not a real execution path.
 *
 * `computeConnectionId` (packages/execution) is a placeholder hash, NOT
 * Hyperliquid's real MsgPack+Keccak canonicalization. `FakeSignerGateway`
 * (packages/test-fixtures) signs with a made-up string, not a real key.
 * Nothing here can ever reach a real venue or move funds. Real signing
 * requires: byte-exact Hyperliquid wire-format compatibility, a real
 * signer vendor (Privy/Turnkey/etc.) with actual credentials, and a
 * funded+approved agent wallet — none of which exist yet, and none of
 * which should be added without an explicit, separate decision.
 * ---------------------------------------------------------------------
 */

/** A fully-specified, about-to-be-signed order action — one exact economic action. */
export interface CanonicalOrderAction {
  accountId: string;
  clientIntentId: string;
  coin: string;
  side: OrderSide;
  size: Decimal;
  price: Decimal;
  reduceOnly: boolean;
  nonce: number;
  expiresAt: Date;
}

/**
 * Binds a risk decision's reservation to one exact canonical action. A
 * signer must refuse to sign anything whose hash doesn't match this
 * connectionId — that's the "exact-hash authorization" invariant from the
 * blueprint, independent of which signer vendor eventually implements it.
 */
export interface ActionAuthorization {
  connectionId: string;
  reservationId: string;
  accountId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface SignedAction {
  authorization: ActionAuthorization;
  signature: string;
  signerAddress: string;
}

/**
 * Default-deny signing boundary: signs only the exact authorized action.
 * FakeSignerGateway (packages/execution) is venue-agnostic; PrivySignerGateway
 * (packages/hyperliquid) is the real Hyperliquid+Privy implementation.
 */
export interface SignerGateway {
  signExact(authorization: ActionAuthorization, action: CanonicalOrderAction): Promise<SignedAction>;
}

/**
 * Computes the connectionId a signer will be asked to authorize for a given
 * canonical action. Kept separate from the signer itself so the same
 * orchestrator (authorizeAndSignOrder) can run against a fast placeholder
 * hasher in tests or the real Hyperliquid MsgPack+Keccak256 hasher in
 * production — the signer independently recomputes the hash either way and
 * refuses anything that doesn't match, so using the wrong hasher for a given
 * signer simply fails closed rather than silently producing a bad signature.
 */
export interface ActionHasher {
  computeConnectionId(action: CanonicalOrderAction): Promise<string>;
}

export interface SubmittedOrder {
  /** The venue's own identifier for this order - opaque, venue-specific format. */
  venueOrderId: string;
}

/**
 * Submits an already-signed action to a venue and reports back its order
 * id. Separate from SignerGateway: signing produces a signature that's
 * valid regardless of whether it's ever sent anywhere; submitting is the
 * step that actually reaches the venue and can fail for reasons signing
 * can't (rejected order, network error, venue downtime).
 */
export interface OrderSubmitter {
  submit(signed: SignedAction, action: CanonicalOrderAction): Promise<SubmittedOrder>;
}

export type VenueOrderLifecycleStatus = "OPEN" | "FILLED" | "CANCELED" | "UNKNOWN";

export interface VenueOrderStatus {
  status: VenueOrderLifecycleStatus;
}

/** Reads live order status and cancels a resting order on a venue, given its venue order id. */
export interface OrderLifecycleReader {
  getOrderStatus(address: string, venueOrderId: string): Promise<VenueOrderStatus>;
}

export interface OrderCanceller {
  cancelOrder(coin: string, venueOrderId: string): Promise<void>;
}

export interface NonceLease {
  accountId: string;
  nonce: number;
  leasedAt: Date;
}

/**
 * Leases strictly-increasing nonces per account. Must be safe under
 * concurrency — two concurrent leases for the same account must never
 * return the same nonce (mirrors the RiskLedgerStore mutual-exclusion
 * requirement, but scoped to nonce issuance specifically).
 */
export interface ExecutionSequencer {
  leaseNonce(accountId: string): Promise<NonceLease>;
}
