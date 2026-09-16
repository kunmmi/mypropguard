/**
 * Rule types a protected account's mandate can be built from.
 * Scope is deliberately limited to the "cleaner deterministic V1 controls"
 * called out in the MyPropGuard blueprint (research update 2026-09-13):
 * risk-per-trade / protective-exit-coverage rules are deferred until that
 * lifecycle exists, so they are NOT included here yet.
 */
export const RuleType = {
  MAX_DAILY_LOSS: "MAX_DAILY_LOSS",
  MAX_DRAWDOWN: "MAX_DRAWDOWN",
  MAX_LEVERAGE: "MAX_LEVERAGE",
  MAX_POSITION_SIZE: "MAX_POSITION_SIZE",
  MAX_EXPOSURE: "MAX_EXPOSURE",
  MAX_TRADE_FREQUENCY: "MAX_TRADE_FREQUENCY",
  COOLDOWN: "COOLDOWN",
} as const;
export type RuleType = (typeof RuleType)[keyof typeof RuleType];

/** Rules whose breach can be resolved by shrinking the order instead of blocking it outright. */
export const SIZEABLE_RULE_TYPES: ReadonlySet<RuleType> = new Set([
  RuleType.MAX_LEVERAGE,
  RuleType.MAX_POSITION_SIZE,
  RuleType.MAX_EXPOSURE,
]);

export const DecisionOutcome = {
  ALLOW: "ALLOW",
  RESIZE: "RESIZE",
  BLOCK: "BLOCK",
} as const;
export type DecisionOutcome = (typeof DecisionOutcome)[keyof typeof DecisionOutcome];

export const OrderSide = {
  BUY: "BUY",
  SELL: "SELL",
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

/** How a fill changes an existing position, used to decide whether caps apply at all. */
export const PositionTransition = {
  OPEN: "OPEN",
  INCREASE: "INCREASE",
  REDUCE: "REDUCE",
  CLOSE: "CLOSE",
  FLIP: "FLIP",
} as const;
export type PositionTransition = (typeof PositionTransition)[keyof typeof PositionTransition];

/** Classification of an account-level cash event, kept separate from trading P&L. */
export const CapitalFlowType = {
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  TRADING_PNL: "TRADING_PNL",
} as const;
export type CapitalFlowType = (typeof CapitalFlowType)[keyof typeof CapitalFlowType];

export const OrderReservationStatus = {
  HELD: "HELD",
  CONSUMED: "CONSUMED",
  RELEASED: "RELEASED",
} as const;
export type OrderReservationStatus =
  (typeof OrderReservationStatus)[keyof typeof OrderReservationStatus];

/**
 * Whether an account's venue-derived state can be trusted right now. Per
 * the blueprint: "the UI must never show green protection when
 * authority/state continuity is unknown" — ProtectionGate only allows new
 * trades when the latest checkpoint is VERIFIED and still fresh.
 */
export const StateConfidence = {
  VERIFIED: "VERIFIED",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN",
} as const;
export type StateConfidence = (typeof StateConfidence)[keyof typeof StateConfidence];
