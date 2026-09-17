import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderSide } from "@mypropguard/domain";
import { computeConnectionId } from "../src/connectionId.js";

function action(overrides: Partial<Parameters<typeof computeConnectionId>[0]> = {}) {
  return {
    accountId: "acct_1",
    clientIntentId: "intent_1",
    coin: "BTC",
    side: OrderSide.BUY,
    size: new Decimal(1),
    price: new Decimal(50_000),
    reduceOnly: false,
    nonce: 1,
    expiresAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("computeConnectionId", () => {
  it("is deterministic for identical actions", () => {
    expect(computeConnectionId(action())).toBe(computeConnectionId(action()));
  });

  it("changes when any economically meaningful field changes", () => {
    const base = computeConnectionId(action());
    expect(computeConnectionId(action({ size: new Decimal(2) }))).not.toBe(base);
    expect(computeConnectionId(action({ price: new Decimal(51_000) }))).not.toBe(base);
    expect(computeConnectionId(action({ side: OrderSide.SELL }))).not.toBe(base);
    expect(computeConnectionId(action({ nonce: 2 }))).not.toBe(base);
    expect(computeConnectionId(action({ reduceOnly: true }))).not.toBe(base);
  });
});
