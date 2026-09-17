import type { CanonicalOrderAction, OrderSide } from "@mypropguard/domain";
import type { Decimal } from "decimal.js";

export interface CanonicalizeOrderInput {
  accountId: string;
  clientIntentId: string;
  coin: string;
  side: OrderSide;
  /** Approved size (post-resize, if applicable) — never the raw requested size. */
  size: Decimal;
  price: Decimal;
  reduceOnly: boolean;
  nonce: number;
  /** How long this action stays valid before it must be treated as stale. */
  ttlMs: number;
  now?: Date;
}

export function canonicalizeOrderAction(input: CanonicalizeOrderInput): CanonicalOrderAction {
  const now = input.now ?? new Date();
  return {
    accountId: input.accountId,
    clientIntentId: input.clientIntentId,
    coin: input.coin,
    side: input.side,
    size: input.size,
    price: input.price,
    reduceOnly: input.reduceOnly,
    nonce: input.nonce,
    expiresAt: new Date(now.getTime() + input.ttlMs),
  };
}
