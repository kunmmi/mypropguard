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
  /** See RuleVersion.tokenAddress - only meaningful for MAX_POSITION_SIZE on EVM spot venues. */
  tokenAddress?: string | null;
}

export interface NewAccountInput {
  accountId: string;
  ownerUserId: string;
  venue: string;
  /** Starting equity snapshot the owner declares at provisioning time (no live venue read yet — Phase 2). */
  initialEquity: Decimal;
  initialRules: readonly NewAccountRuleInput[];
  /** Set when an AgentWalletProvisioner was used to create this account's own signing wallet. Null in the offline scaffold. */
  agentWalletId?: string | null;
  agentWalletAddress?: string | null;
  /**
   * Set when an EvmSafeProvisioner was used (EVM-chain venues only, e.g. "arbitrum-gmx",
   * "bsc-pancakeswap", "ethereum-uniswap") - the trader's own wallet address, which becomes the
   * sole owner of the provisioned Safe. Unlike agentWalletAddress (a MyPropGuard-managed Privy
   * wallet), this address belongs to the trader and MyPropGuard never holds its key.
   */
  evmOwnerWalletAddress?: string | null;
  /** The Safe address provisioned for this account - what the trader connects to the exchange's own UI with. Null in the offline scaffold or for non-EVM venues. */
  evmSafeAddress?: string | null;
  /** Which EVM chain the Safe above was deployed on (e.g. 42161 for Arbitrum, 56 for BSC, 1 for Ethereum). Null unless evmSafeAddress is set. */
  evmChainId?: number | null;
}

export interface ProvisionedAgentWallet {
  walletId: string;
  walletAddress: string;
}

/**
 * Creates a fresh, distinct signing wallet for one account. Separate from
 * SignerGateway (which signs with a wallet that already exists) - this is
 * the step before it: giving each account its own wallet to eventually
 * sign with, and an address for its owner to go approve as a Hyperliquid
 * agent. HyperliquidAgentWalletProvisioner (packages/hyperliquid) wraps a
 * real Privy wallet-creation call.
 */
export interface AgentWalletProvisioner {
  provisionWallet(): Promise<ProvisionedAgentWallet>;
}

export interface ProvisionedEvmSafe {
  safeAddress: string;
  chainId: number;
}

/**
 * Deploys a Safe for a trader with MyPropGuard's risk Guard already attached - the EVM-chain
 * equivalent of AgentWalletProvisioner, for venues like "arbitrum-gmx"/"bsc-pancakeswap"/
 * "ethereum-uniswap" (see packages/evm-guard). Unlike AgentWalletProvisioner, MyPropGuard never
 * holds a key for the resulting account: `ownerWalletAddress` becomes the Safe's sole owner, and
 * the trader keeps trading directly through the exchange's own UI from that point on.
 * packages/evm's SafeDeployer wraps the real on-chain deployment this calls into.
 */
export interface EvmSafeProvisioner {
  provisionSafe(ownerWalletAddress: string): Promise<ProvisionedEvmSafe>;
}

/** What changed about one rule - enough for an EvmGuardRuleSyncer to decide which on-chain call applies. */
export interface EvmRuleSyncInput {
  safeAddress: string;
  ruleType: RuleType;
  param: Decimal;
  /** Required for MAX_POSITION_SIZE (the Guard's per-token limit); ignored otherwise. */
  tokenAddress?: string | null;
}

/**
 * Pushes a changed risk rule on-chain to a trader's already-deployed Guard, so it's enforced on
 * the exchange's own UI too, not just through MyPropGuard's dashboard. Only rule types the
 * relevant Guard contract actually understands are supported - MAX_POSITION_SIZE (per-token) and
 * MAX_TRADE_FREQUENCY for the spot Guards (PancakeSwap/Uniswap); unsupported combinations should
 * be rejected by the caller before reaching this port, not silently ignored here.
 */
export interface EvmGuardRuleSyncer {
  syncRule(input: EvmRuleSyncInput): Promise<void>;
  /**
   * Records that an account has breached its max-daily-loss rule today, freezing it through the
   * end of the current UTC day - called when the off-chain ledger determines a breach occurred.
   * Deliberately one-directional: there is no corresponding "unfreeze" method on this port,
   * because the underlying contract has no such function for anyone to call, including the admin -
   * a freeze can only ever expire on its own at the next UTC day. See
   * packages/evm-guard/ROADMAP.md for why the admin key is still the one that has to report the
   * breach in the first place (full on-chain P&L verification remains out of scope).
   */
  freezeForToday(safeAddress: string): Promise<void>;
}

export interface EvmEquityQuery {
  safeAddress: string;
  /**
   * ERC-20 addresses to value in addition to the Safe's native-token balance: the tokens the Safe has
   * acquired through its own transactions (found by an EvmFlowReader) and any token with a per-token
   * rule. Only these are counted - there is no general way to enumerate every token an address
   * holds on-chain, and counting unsolicited airdrops would let anyone inflate an account's equity.
   */
  trackedTokens: readonly string[];
  /** Read balances and prices as of this block, so equity and capital flows describe the same instant. */
  blockNumber?: number;
}

/**
 * Reads an EVM Safe's live USD equity - the EVM-chain equivalent of VenueStateReader, feeding
 * AccountRiskHead.currentEquity the same way reconcileAccountFromVenue does for Hyperliquid, so
 * checkAndEnforceDailyLossFreeze has a real number to compare against instead of whatever the
 * account's equity was frozen at when it was created.
 */
export interface EvmSafeEquityReader {
  getEquityUsd(query: EvmEquityQuery): Promise<Decimal>;
  /** USD value of `rawAmount` base units of `token` (the zero address is the native coin). */
  getTokenValueUsd(token: string, rawAmount: bigint, blockNumber?: number): Promise<Decimal>;
}

/** What the chain says about a Safe at one block. */
export interface EvmSafeSnapshot {
  blockNumber: number;
  /** How many transactions the Safe has executed. */
  nonce: number;
  /** Raw balance of each asset (the zero address is the native coin). */
  balances: Record<string, bigint>;
  /** The Guard's running total of what the Safe has sent out, per asset. Zero if the Guard has no such record. */
  withdrawn: Record<string, bigint>;
}

/**
 * Reads a Safe's balances, transaction count and the Guard's withdrawal totals at a block, using
 * only ordinary state reads (no event logs, which free public RPCs refuse to serve).
 */
export interface EvmSafeStateReader {
  /** The newest block that is safe to treat as final (head minus a few confirmations). */
  getSettledBlock(): Promise<number>;
  /** Reads the native coin, the chain's base tokens and every asset in `extraAssets`. */
  getSnapshot(input: { safeAddress: string; extraAssets: readonly string[]; blockNumber: number }): Promise<EvmSafeSnapshot>;
}

/**
 * Finds the ERC-20s a Safe holds. There is no way to enumerate an address's tokens from a plain
 * RPC, so this is backed by a wallet-token API (Moralis). It is only asked when the Safe has run a
 * transaction since the last reconcile, because only a Safe transaction can bring in a token
 * the owner chose to buy.
 */
export interface EvmTokenDiscovery {
  /**
   * `context.nonce` is the Safe's transaction count on-chain. A provider that works from an index of
   * the Safe's own transactions must throw if its index has not caught up to it, rather than
   * return a stale token list that would make a fresh buy look like a loss.
   */
  discoverTokens(safeAddress: string, context?: { nonce: number }): Promise<string[]>;
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
  /** The venue's own clock (ms) when this state was computed. */
  time?: number;
}

/** A resting order on a venue account. */
export interface VenueOpenOrder {
  coin: string;
  /** The venue's own order id. */
  oid: number;
  isBuy: boolean;
  size: Decimal;
  reduceOnly: boolean;
}

/**
 * Acts on a trader's venue account on MyPropGuard's behalf, through the account's own approved agent wallet.
 * Deliberately narrow: it can only cancel orders and place reduce-only closing orders, so it can shrink or
 * remove exposure but never open any, and never move funds.
 */
export interface VenueEnforcer {
  cancelOrder(coin: string, oid: number): Promise<void>;
  /** Places a reduce-only, immediate-or-cancel order that can only shrink an existing position. */
  reduceOnlyClose(input: { coin: string; isBuy: boolean; size: Decimal }): Promise<{ detail: string }>;
}

/** USD moved into (+) or out of (-) a venue trading account by its owner - not profit or loss. */
export interface VenueCapitalFlow {
  /** Unique per flow (the venue transaction hash). */
  id: string;
  /** The venue's own clock (ms). */
  timeMs: number;
  amountUsd: Decimal;
}

/**
 * A read-only venue state reader (Phase 2). Deliberately narrow: no
 * signing, no order placement — just public account-state reads. Hyperliquid
 * implements this in packages/hyperliquid; other venues can add their own
 * later without changing the reconciliation orchestrator.
 */
export interface VenueStateReader {
  getClearinghouseState(address: string): Promise<ClearinghouseState>;
  /**
   * Deposits, withdrawals and transfers for the account after `afterMs` (exclusive), oldest first.
   * Optional: without it a reconcile cannot tell a withdrawal from a loss.
   */
  getCapitalFlows?(address: string, afterMs: number): Promise<readonly VenueCapitalFlow[]>;
  /** Resting orders on the account. Optional: only the watcher needs them. */
  getOpenOrders?(address: string): Promise<readonly VenueOpenOrder[]>;
}

/**
 * The core concurrency contract from the blueprint: `account_risk_heads` is
 * the per-account serialization root, so any mutation that can change
 * whether new risk may be opened must run inside an exclusive critical
 * section for that account. A Postgres-backed implementation achieves this
 * with `SELECT ... FOR UPDATE`; an in-memory implementation can use a plain
 * mutex — both must guarantee only one `fn` runs at a time per accountId.
 */
/** One thing the watcher decided to do (or, in log-only mode, would have done), and what happened. */
export interface EnforcementActionRecord {
  accountId: string;
  createdAt?: Date;
  mode: "log" | "enforce";
  kind: "LOCK" | "UNLOCK" | "CANCEL" | "TRIM" | "WARNING";
  coin?: string | null;
  detail: Record<string, unknown>;
  /** WOULD_DO: log-only mode. DONE / FAILED: enforce mode. INFO: a state change with nothing to execute. */
  result: "WOULD_DO" | "DONE" | "FAILED" | "INFO";
  error?: string | null;
}

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
  /** Looks up one account by id - e.g. to find its provisioned agent wallet before signing. Null if it doesn't exist. */
  findAccountById(accountId: string): Promise<ProtectedAccount | null>;
  /**
   * Cross-account lookup for a periodic sweep (e.g. reconcileAllEvmAccountsWithDailyLossRule) -
   * every account, regardless of owner, with at least one currently-active rule of the given
   * type. Read-only, no per-account lock needed.
   */
  listAccountsWithActiveRuleType(ruleType: RuleType): Promise<readonly ProtectedAccount[]>;
  /** Every account on a venue (e.g. "hyperliquid"), regardless of owner - for the watcher sweep. */
  listAccountsByVenue(venue: string): Promise<readonly ProtectedAccount[]>;
  /** Saves the trader's own address on the venue (Hyperliquid) so the watcher can read it. */
  setVenueAddress(accountId: string, venueAddress: string): Promise<void>;
  recordEnforcementAction(record: EnforcementActionRecord): Promise<void>;
  /** Newest first. */
  listEnforcementActions(accountId: string, limit: number): Promise<readonly EnforcementActionRecord[]>;
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
