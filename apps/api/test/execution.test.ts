import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderReservationStatus, RuleType, type SignerGateway } from "@mypropguard/domain";
import { FakeSignerGateway, InMemoryExecutionSequencer, PlaceholderActionHasher } from "@mypropguard/execution";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

function throwingSigner(): SignerGateway {
  return {
    signExact: async () => {
      throw new Error("signer unavailable");
    },
  };
}

describe("POST /v1/execution/dry-run", () => {
  it("runs risk + reservation + fake signing for an order within limits", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_exec_1" }));
    store.seedRules("acct_exec_1", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({ store, executionSequencer: new InMemoryExecutionSequencer(), hasher, signer: new FakeSignerGateway(hasher) });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_intent_1",
        accountId: "acct_exec_1",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mock).toBe(true);
    expect(body.decision.outcome).toBe("ALLOW");
    expect(body.mockSignedAction.mockSignerAddress).toMatch(/^0xFAKE/);
  });

  it("does not sign anything for a BLOCKed decision", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_exec_2", openNotional: new Decimal(100_000) }));
    store.seedRules("acct_exec_2", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({ store, executionSequencer: new InMemoryExecutionSequencer(), hasher, signer: new FakeSignerGateway(hasher) });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_intent_2",
        accountId: "acct_exec_2",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.decision.outcome).toBe("BLOCK");
    expect(body.mockSignedAction).toBeNull();
  });

  it("releases the reservation when signing fails, instead of permanently spending the budget", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_exec_3", openNotional: new Decimal(0) }));
    store.seedRules("acct_exec_3", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 60_000)]);

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: throwingSigner(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_intent_3",
        accountId: "acct_exec_3",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    // The signer's failure is an unexpected error, not a BLOCK - it
    // propagates to the generic 500 handler.
    expect(response.statusCode).toBe(500);

    const reservations = store.getReservations().filter((r) => r.accountId === "acct_exec_3");
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.status).toBe(OrderReservationStatus.RELEASED);
    expect(reservations[0]!.releasedAt).not.toBeNull();
  });

  it("returns 501 when no fake signer is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: { clientIntentId: "x", accountId: "acct_none", coin: "BTC", side: "BUY", size: "1", price: "1" },
    });

    expect(response.statusCode).toBe(501);
  });
});
