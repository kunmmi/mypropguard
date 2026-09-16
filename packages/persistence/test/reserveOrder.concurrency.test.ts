import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { DecisionOutcome, RuleType } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildProposedOrder, buildRuleVersion } from "@mypropguard/test-fixtures";
import { reserveOrder } from "../src/reserveOrder.js";

describe("reserveOrder concurrency", () => {
  it("lets only one of two simultaneous orders fully through when both would exhaust the same exposure cap", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(
      buildAccountRiskHead({
        accountId: "acct_concurrent",
        openNotional: new Decimal(0),
      }),
    );
    store.seedRules("acct_concurrent", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000)]);

    // Each order's notional (price 1 * size 700 = 700) fits the $1,000 cap on
    // its own, but both together (1,400) do not. Whichever one the mutex lets
    // through first reserves the full 700; the other must see that
    // outstanding reservation and be resized down rather than also getting a
    // full, unadjusted ALLOW.
    const makeOrder = (clientIntentId: string) =>
      reserveOrder(store, {
        accountId: "acct_concurrent",
        proposedOrder: buildProposedOrder({ clientIntentId, size: new Decimal(700), price: new Decimal(1) }),
        currentPositionSize: new Decimal(0),
      });

    const [first, second] = await Promise.all([makeOrder("intent_a"), makeOrder("intent_b")]);

    const totalReservedNotional = store
      .getReservations()
      .reduce((sum, r) => sum.plus(r.reservedAmount), new Decimal(0));

    // The combined reserved notional must never exceed the account's cap,
    // regardless of how the two calls interleaved.
    expect(totalReservedNotional.lte(1_000)).toBe(true);

    const outcomes = [first.decision.outcome, second.decision.outcome];
    // At least one of the two could not get its full requested size.
    expect(outcomes).toContain(DecisionOutcome.RESIZE);
  });

  it("allows both orders when the combined size fits comfortably within the cap", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(
      buildAccountRiskHead({
        accountId: "acct_comfortable",
        openNotional: new Decimal(0),
      }),
    );
    store.seedRules("acct_comfortable", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 10_000)]);

    const makeOrder = (clientIntentId: string) =>
      reserveOrder(store, {
        accountId: "acct_comfortable",
        proposedOrder: buildProposedOrder({ clientIntentId, size: new Decimal(10), price: new Decimal(1) }),
        currentPositionSize: new Decimal(0),
      });

    const [first, second] = await Promise.all([makeOrder("intent_c"), makeOrder("intent_d")]);

    expect(first.decision.outcome).toBe(DecisionOutcome.ALLOW);
    expect(second.decision.outcome).toBe(DecisionOutcome.ALLOW);
    expect(store.getReservations()).toHaveLength(2);
  });
});
