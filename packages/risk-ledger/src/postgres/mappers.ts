import { Decimal } from "decimal.js";
import type { AccountRiskHead, EvmFlowState, OrderReservation, VenueFlowState, ProtectedAccount, RuleVersion, StateCheckpoint } from "@mypropguard/domain";
import { OrderReservationStatus, StateConfidence } from "@mypropguard/domain";

export function rowToProtectedAccount(row: Record<string, unknown>): ProtectedAccount {
  return {
    accountId: row.account_id as string,
    ownerUserId: row.owner_user_id as string,
    venue: row.venue as string,
    protectionEnabled: row.protection_enabled as boolean,
    createdAt: new Date(row.created_at as string),
    agentWalletId: (row.agent_wallet_id as string | null) ?? null,
    agentWalletAddress: (row.agent_wallet_address as string | null) ?? null,
    evmOwnerWalletAddress: (row.evm_owner_wallet_address as string | null) ?? null,
    evmSafeAddress: (row.evm_safe_address as string | null) ?? null,
    evmChainId: (row.evm_chain_id as number | null) ?? null,
  };
}

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
    // Absent (undefined) when the column does not exist yet, so a deploy can precede the migration.
    evmFlowState: "evm_flow_state" in row ? rowToEvmFlowState(row.evm_flow_state) : undefined,
    venueFlowState: "venue_flow_state" in row ? rowToVenueFlowState(row.venue_flow_state) : undefined,
  };
}

function rowToEvmFlowState(raw: unknown): EvmFlowState | null {
  if (!raw) return null;
  const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    day: string;
    cursorBlock: number;
    cumulativeFlowUsd: string;
    knownTokens?: string[];
    lastNonce?: number;
    lastBalances?: Record<string, string>;
    lastWithdrawn?: Record<string, string>;
  };
  return {
    day: value.day,
    cursorBlock: Number(value.cursorBlock),
    cumulativeFlowUsd: new Decimal(value.cumulativeFlowUsd),
    knownTokens: value.knownTokens ?? [],
    lastNonce: Number(value.lastNonce ?? 0),
    lastBalances: value.lastBalances ?? {},
    lastWithdrawn: value.lastWithdrawn ?? {},
  };
}

function rowToVenueFlowState(raw: unknown): VenueFlowState | null {
  if (!raw) return null;
  const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as { day: string; cursorMs: number; cumulativeFlowUsd: string };
  return { day: value.day, cursorMs: Number(value.cursorMs), cumulativeFlowUsd: new Decimal(value.cumulativeFlowUsd) };
}

export function venueFlowStateToJson(state: VenueFlowState | null | undefined): string | null {
  if (!state) return null;
  return JSON.stringify({ day: state.day, cursorMs: state.cursorMs, cumulativeFlowUsd: state.cumulativeFlowUsd.toString() });
}

export function evmFlowStateToJson(state: EvmFlowState | null | undefined): string | null {
  if (!state) return null;
  return JSON.stringify({
    day: state.day,
    cursorBlock: state.cursorBlock,
    cumulativeFlowUsd: state.cumulativeFlowUsd.toString(),
    knownTokens: state.knownTokens,
    lastNonce: state.lastNonce,
    lastBalances: state.lastBalances,
    lastWithdrawn: state.lastWithdrawn,
  });
}

export function rowToRuleVersion(row: Record<string, unknown>): RuleVersion {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    ruleType: row.rule_type as RuleVersion["ruleType"],
    param: new Decimal(row.param as string),
    tokenAddress: (row.token_address as string | null) ?? null,
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
    coin: row.coin as string,
    reservedAmount: new Decimal(row.reserved_amount as string),
    status: row.status as OrderReservationStatus,
    createdAt: new Date(row.created_at as string),
    releasedAt: row.released_at ? new Date(row.released_at as string) : null,
    venueOrderId: (row.venue_order_id as string | null) ?? null,
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
