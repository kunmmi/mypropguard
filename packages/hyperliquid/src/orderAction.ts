/**
 * Builds a Hyperliquid `order` L1 action with keys in the EXACT order the
 * official schema defines (this order is load-bearing — it's what gets
 * MsgPack-encoded and hashed in signing.ts). Ported from the field order in
 * nktkas/hyperliquid's OrderRequest schema (src/api/exchange/_methods/order.ts)
 * on 2026-09-17: outer `{ type, orders, grouping }`, per-order `{ a, b, p, s, r, t, c }`.
 */
export type TimeInForce = "Gtc" | "Ioc" | "Alo" | "FrontendMarket";

export interface BuildOrderActionInput {
  /** Hyperliquid asset index (see assetIndex.ts) — NOT the coin symbol. */
  assetIndex: number;
  isBuy: boolean;
  /** Decimal string, e.g. "50000". Never a JS number (precision). */
  price: string;
  /** Decimal string, e.g. "0.5". Never a JS number (precision). */
  size: string;
  reduceOnly: boolean;
  tif: TimeInForce;
  /** Client order id, 0x-prefixed 16-byte hex, if the caller wants one. */
  cloid?: `0x${string}`;
}

export function buildOrderAction(input: BuildOrderActionInput): Record<string, unknown> {
  const order: Record<string, unknown> = {
    a: input.assetIndex,
    b: input.isBuy,
    p: input.price,
    s: input.size,
    r: input.reduceOnly,
    t: { limit: { tif: input.tif } },
  };
  if (input.cloid) {
    order.c = input.cloid;
  }

  return {
    type: "order",
    orders: [order],
    grouping: "na",
  };
}
