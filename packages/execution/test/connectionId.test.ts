import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderSide, type CanonicalOrderAction } from "@mypropguard/domain";
import { PlaceholderActionHasher } from "../src/connectionId.js";

const hasher = new PlaceholderActionHasher();

function action(overrides: Partial<CanonicalOrderAction> = {}): CanonicalOrderAction {
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

describe("PlaceholderActionHasher", () => {
  it("is deterministic for identical actions", async () => {
    expect(await hasher.computeConnectionId(action())).toBe(await hasher.computeConnectionId(action()));
  });

  it("changes when any economically meaningful field changes", async () => {
    const base = await hasher.computeConnectionId(action());
    expect(await hasher.computeConnectionId(action({ size: new Decimal(2) }))).not.toBe(base);
    expect(await hasher.computeConnectionId(action({ price: new Decimal(51_000) }))).not.toBe(base);
    expect(await hasher.computeConnectionId(action({ side: OrderSide.SELL }))).not.toBe(base);
    expect(await hasher.computeConnectionId(action({ nonce: 2 }))).not.toBe(base);
    expect(await hasher.computeConnectionId(action({ reduceOnly: true }))).not.toBe(base);
  });
});
