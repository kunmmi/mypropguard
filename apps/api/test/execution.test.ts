import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderReservationStatus, RuleType, type OrderSubmitter, type SignerGateway } from "@mypropguard/domain";
import { FakeSignerGateway, InMemoryExecutionSequencer, PlaceholderActionHasher } from "@mypropguard/execution";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

function fakeSignerFor(address: string): SignerGateway {
  return {
    signExact: async (authorization) => ({
      authorization,
      signature: `sig_from_${address}`,
      signerAddress: address,
    }),
  };
}

function throwingSigner(): SignerGateway {
  return {
    signExact: async () => {
      throw new Error("signer unavailable");
    },
  };
}

function fakeOrderSubmitter(venueOrderId: string): OrderSubmitter {
  return {
    submit: async () => ({ venueOrderId }),
  };
}

function throwingOrderSubmitter(): OrderSubmitter {
  return {
    submit: async () => {
      throw new Error("venue rejected the order");
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

  it("NEVER submits to the venue, even when an order submitter is configured on the server", async () => {
    // This is the regression test for the actual safety bug: dry-run used
    // to submit whenever the server had ENABLE_VENUE_SUBMISSION on, making
    // a "Check order" UI button silently place a real trade. It must never
    // do that regardless of server config - submission lives only behind
    // the separately-named /v1/execution/submit route.
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_exec_4" }));
    store.seedRules("acct_exec_4", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    let submitCalled = false;
    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: new FakeSignerGateway(hasher),
      orderSubmitter: {
        submit: async () => {
          submitCalled = true;
          return { venueOrderId: "should_never_happen" };
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_intent_4",
        accountId: "acct_exec_4",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mock).toBe(true);
    expect(submitCalled).toBe(false);

    const reservation = store.getReservations().find((r) => r.accountId === "acct_exec_4");
    expect(reservation?.venueOrderId).toBeNull();
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

describe("POST /v1/execution/submit", () => {
  it("submits to the venue and records the venue order id when an order submitter is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_submit_1" }));
    store.seedRules("acct_submit_1", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: new FakeSignerGateway(hasher),
      orderSubmitter: fakeOrderSubmitter("venue_oid_123"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/submit",
      payload: {
        clientIntentId: "submit_intent_1",
        accountId: "acct_submit_1",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.submitted).toBe(true);
    expect(body.venueOrderId).toBe("venue_oid_123");

    const reservation = store.getReservations().find((r) => r.accountId === "acct_submit_1");
    expect(reservation?.venueOrderId).toBe("venue_oid_123");
  });

  it("signs but does not report submitted when no order submitter is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_submit_2" }));
    store.seedRules("acct_submit_2", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({ store, executionSequencer: new InMemoryExecutionSequencer(), hasher, signer: new FakeSignerGateway(hasher) });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/submit",
      payload: {
        clientIntentId: "submit_intent_2",
        accountId: "acct_submit_2",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.submitted).toBe(false);
    expect(body.venueOrderId).toBeNull();
    expect(body.signedAction).not.toBeNull();
  });

  it("releases the reservation when the venue rejects the submission", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_submit_3" }));
    store.seedRules("acct_submit_3", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: new FakeSignerGateway(hasher),
      orderSubmitter: throwingOrderSubmitter(),
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/submit",
      payload: {
        clientIntentId: "submit_intent_3",
        accountId: "acct_submit_3",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(500);
    const reservation = store.getReservations().find((r) => r.accountId === "acct_submit_3");
    expect(reservation?.status).toBe(OrderReservationStatus.RELEASED);
    expect(reservation?.venueOrderId).toBeNull();
  });

  it("returns 501 when no signer is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/submit",
      payload: { clientIntentId: "x", accountId: "acct_none", coin: "BTC", side: "BUY", size: "1", price: "1" },
    });

    expect(response.statusCode).toBe(501);
  });
});

describe("per-account wallet resolution", () => {
  it("signs with an account's own provisioned wallet via signerFactory, instead of the shared fallback signer", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_own_wallet" }));
    store.seedRules("acct_own_wallet", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);
    store.seedAccount({
      accountId: "acct_own_wallet",
      ownerUserId: "user_1",
      venue: "hyperliquid",
      protectionEnabled: false,
      createdAt: new Date(),
      agentWalletId: "wallet_own",
      agentWalletAddress: "0xOWNWALLET",
    });

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: new FakeSignerGateway(hasher), // shared fallback - must NOT be used here
      signerFactory: (walletId, walletAddress) => {
        expect(walletId).toBe("wallet_own");
        return fakeSignerFor(walletAddress);
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_own_wallet",
        accountId: "acct_own_wallet",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mockSignedAction.mockSignerAddress).toBe("0xOWNWALLET");
  });

  it("falls back to the shared signer when the account has no provisioned wallet, even though signerFactory is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_no_wallet" }));
    store.seedRules("acct_no_wallet", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);
    store.seedAccount({
      accountId: "acct_no_wallet",
      ownerUserId: "user_1",
      venue: "hyperliquid",
      protectionEnabled: false,
      createdAt: new Date(),
      agentWalletId: null,
      agentWalletAddress: null,
    });

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: new FakeSignerGateway(hasher),
      signerFactory: () => {
        throw new Error("signerFactory must not be called for an account with no provisioned wallet");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_no_wallet",
        accountId: "acct_no_wallet",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mockSignedAction.mockSignerAddress).toMatch(/^0xFAKE/);
  });

  it("submits through an account's own provisioned wallet via orderLifecycleFactory, instead of the shared fallback submitter", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_own_wallet_submit" }));
    store.seedRules("acct_own_wallet_submit", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);
    store.seedAccount({
      accountId: "acct_own_wallet_submit",
      ownerUserId: "user_1",
      venue: "hyperliquid",
      protectionEnabled: false,
      createdAt: new Date(),
      agentWalletId: "wallet_own_submit",
      agentWalletAddress: "0xOWNWALLETSUBMIT",
    });

    const hasher = new PlaceholderActionHasher();
    const app = buildApp({
      store,
      executionSequencer: new InMemoryExecutionSequencer(),
      hasher,
      signer: new FakeSignerGateway(hasher),
      signerFactory: (_walletId, walletAddress) => fakeSignerFor(walletAddress),
      orderSubmitter: fakeOrderSubmitter("should_never_happen"), // shared fallback - must NOT be used here
      orderLifecycleFactory: (walletId) => {
        expect(walletId).toBe("wallet_own_submit");
        return {
          ...fakeOrderSubmitter("venue_oid_from_own_wallet"),
          cancelOrder: async () => {},
          getOrderStatus: async () => ({ status: "OPEN" as const }),
        };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/submit",
      payload: {
        clientIntentId: "submit_own_wallet",
        accountId: "acct_own_wallet_submit",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.submitted).toBe(true);
    expect(body.venueOrderId).toBe("venue_oid_from_own_wallet");
  });
});
