import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { DecisionOutcome, OrderReservationStatus, RuleType } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildProposedOrder, buildRuleVersion } from "@mypropguard/test-fixtures";
import { releaseReservation } from "../src/releaseReservation.js";
import { reserveOrder } from "../src/reserveOrder.js";

describe("releaseReservation", () => {
  it("frees the reserved budget so a later order that would otherwise be blocked can now go through", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_release_1", openNotional: new Decimal(0) }));
    store.seedRules("acct_release_1", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000)]);

    // Reserve the full cap - a signing failure downstream is what
    // authorizeAndSignOrder would throw before anything real happened.
    const first = await reserveOrder(store, {
      accountId: "acct_release_1",
      proposedOrder: buildProposedOrder({ clientIntentId: "intent_first", size: new Decimal(1_000), price: new Decimal(1) }),
      currentPositionSize: new Decimal(0),
    });
    expect(first.decision.outcome).toBe(DecisionOutcome.ALLOW);
    expect(first.reservation).not.toBeNull();

    // Without a release, this would BLOCK - the whole budget is still held.
    const beforeRelease = await reserveOrder(store, {
      accountId: "acct_release_1",
      proposedOrder: buildProposedOrder({ clientIntentId: "intent_second", size: new Decimal(1_000), price: new Decimal(1) }),
      currentPositionSize: new Decimal(0),
    });
    expect(beforeRelease.decision.outcome).toBe(DecisionOutcome.BLOCK);

    await releaseReservation(store, "acct_release_1", first.reservation!.id);

    const releasedRow = store.getReservations().find((r) => r.id === first.reservation!.id);
    expect(releasedRow?.status).toBe(OrderReservationStatus.RELEASED);
    expect(releasedRow?.releasedAt).not.toBeNull();

    const afterRelease = await reserveOrder(store, {
      accountId: "acct_release_1",
      proposedOrder: buildProposedOrder({ clientIntentId: "intent_third", size: new Decimal(1_000), price: new Decimal(1) }),
      currentPositionSize: new Decimal(0),
    });
    expect(afterRelease.decision.outcome).toBe(DecisionOutcome.ALLOW);
  });

  it("is a no-op when the reservation is already released (safe to call twice)", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_release_2", openNotional: new Decimal(0) }));
    store.seedRules("acct_release_2", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000)]);

    const { reservation } = await reserveOrder(store, {
      accountId: "acct_release_2",
      proposedOrder: buildProposedOrder({ clientIntentId: "intent_x", size: new Decimal(100), price: new Decimal(1) }),
      currentPositionSize: new Decimal(0),
    });

    await releaseReservation(store, "acct_release_2", reservation!.id);
    await expect(releaseReservation(store, "acct_release_2", reservation!.id)).resolves.not.toThrow();

    expect(store.getReservations().find((r) => r.id === reservation!.id)?.status).toBe(OrderReservationStatus.RELEASED);
  });

  it("is a no-op for an unknown reservation id", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_release_3" }));

    await expect(releaseReservation(store, "acct_release_3", "resv_does_not_exist")).resolves.not.toThrow();
  });
});
