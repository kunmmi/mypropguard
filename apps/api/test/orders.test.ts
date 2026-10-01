import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderReservationStatus, RuleType, type OrderCanceller, type OrderLifecycleReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

function makeStoreWithAccount(accountId: string) {
  const store = new InMemoryRiskLedgerStore();
  store.seedAccountRiskHead(buildAccountRiskHead({ accountId, openNotional: new Decimal(0) }));
  store.seedRules(accountId, [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);
  store.seedProtectionEnabled(accountId, true);
  return store;
}

describe("POST /v1/orders", () => {
  it("accepts a valid order within limits and returns a schema-valid response", async () => {
    const store = makeStoreWithAccount("acct_api_1");
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_1",
        accountId: "acct_api_1",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ACCEPTED");
    expect(body.approvedSize).toBe("1");
  });

  it("resizes an order that would breach the account's position-size cap", async () => {
    const store = makeStoreWithAccount("acct_api_2");
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_2",
        accountId: "acct_api_2",
        coin: "BTC",
        side: "BUY",
        size: "5",
        price: "50000", // 250,000 notional requested against a 100,000 cap
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("RESIZED");
    expect(body.approvedSize).toBe("2");
  });

  it("rejects a malformed request with 400 instead of a 500", async () => {
    const store = makeStoreWithAccount("acct_api_3");
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { accountId: "acct_api_3" }, // missing required fields
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for an unknown order id on both GET and cancel", async () => {
    const store = makeStoreWithAccount("acct_api_4");
    const app = buildApp({ store });

    const get = await app.inject({ method: "GET", url: "/v1/orders/does-not-exist" });
    expect(get.statusCode).toBe(404);

    const cancel = await app.inject({ method: "POST", url: "/v1/orders/does-not-exist/cancel" });
    expect(cancel.statusCode).toBe(404);
    expect(cancel.json().status).toBe("NOT_FOUND");
  });

  it("reports a real order as PENDING (never submitted, since /v1/orders never signs/submits)", async () => {
    const store = makeStoreWithAccount("acct_api_5");
    const app = buildApp({ store });

    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_5",
        accountId: "acct_api_5",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });
    const orderId = created.json().orderId;

    const get = await app.inject({ method: "GET", url: `/v1/orders/${orderId}` });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.venueOrderId).toBeNull();
    expect(body.result).toBe("PENDING");
  });

  it("cancelling a never-submitted order just releases the local hold - no venue canceller needed", async () => {
    const store = makeStoreWithAccount("acct_api_6");
    const app = buildApp({ store });

    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_6",
        accountId: "acct_api_6",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });
    const orderId = created.json().orderId;

    const cancel = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    const cancelBody = cancel.json();
    expect(cancelBody.status).toBe("CANCELED");
    expect(cancelBody.reasonCode).toBe("NEVER_SUBMITTED");

    // Cancelling twice must not double-release or silently succeed again.
    const secondCancel = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel` });
    expect(secondCancel.statusCode).toBe(409);
    expect(secondCancel.json().status).toBe("REJECTED");
  });

  it("reports a real live status once a reservation has a venue order id and a lifecycle reader is configured", async () => {
    const store = makeStoreWithAccount("acct_api_7");
    const orderLifecycleReader: OrderLifecycleReader = {
      getOrderStatus: async () => ({ status: "OPEN" }),
    };
    const app = buildApp({ store, orderLifecycleReader });

    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_7",
        accountId: "acct_api_7",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });
    const orderId = created.json().orderId;

    // Simulates what /v1/execution/dry-run does once real submission is
    // configured - reservation gets a real venue order id.
    await store.runExclusive("acct_api_7", (ctx) => ctx.recordVenueOrderId(orderId, "venue_oid_1"));

    const get = await app.inject({ method: "GET", url: `/v1/orders/${orderId}?venueAddress=0xabc` });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body.venueOrderId).toBe("venue_oid_1");
    expect(body.result).toBe("COMMITTED");
  });

  it("cancels a submitted order on the venue and releases the reservation", async () => {
    const store = makeStoreWithAccount("acct_api_8");
    let cancelledArgs: [string, string] | null = null;
    const orderCanceller: OrderCanceller = {
      cancelOrder: async (coin, venueOrderId) => {
        cancelledArgs = [coin, venueOrderId];
      },
    };
    const app = buildApp({ store, orderCanceller });

    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_8",
        accountId: "acct_api_8",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });
    const orderId = created.json().orderId;
    await store.runExclusive("acct_api_8", (ctx) => ctx.recordVenueOrderId(orderId, "venue_oid_2"));

    const cancel = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().reasonCode).toBe("CANCELED_ON_VENUE");
    expect(cancelledArgs).toEqual(["BTC", "venue_oid_2"]);

    const reservation = store.getReservations().find((r) => r.id === orderId);
    expect(reservation?.status).toBe(OrderReservationStatus.RELEASED);
  });

  it("returns 501 for cancel when a venue order id exists but no canceller is configured", async () => {
    const store = makeStoreWithAccount("acct_api_9");
    const app = buildApp({ store });

    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_9",
        accountId: "acct_api_9",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });
    const orderId = created.json().orderId;
    await store.runExclusive("acct_api_9", (ctx) => ctx.recordVenueOrderId(orderId, "venue_oid_3"));

    const cancel = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel` });
    expect(cancel.statusCode).toBe(501);
  });

  it("cancels and reads status through an account's own provisioned wallet via orderLifecycleFactory, instead of the shared fallback", async () => {
    const store = makeStoreWithAccount("acct_api_10");
    store.seedAccount({
      accountId: "acct_api_10",
      ownerUserId: "user_1",
      venue: "hyperliquid",
      protectionEnabled: true,
      createdAt: new Date(),
      agentWalletId: "wallet_orders_10",
      agentWalletAddress: "0xORDERSWALLET10",
      evmOwnerWalletAddress: null,
      evmSafeAddress: null,
      evmChainId: null,
    });

    let cancelledArgs: [string, string] | null = null;
    const app = buildApp({
      store,
      orderCanceller: {
        cancelOrder: async () => {
          throw new Error("shared fallback canceller must not be used for an account with its own wallet");
        },
      },
      orderLifecycleReader: {
        getOrderStatus: async () => {
          throw new Error("shared fallback reader must not be used for an account with its own wallet");
        },
      },
      orderLifecycleFactory: (walletId) => {
        expect(walletId).toBe("wallet_orders_10");
        return {
          submit: async () => ({ venueOrderId: "unused" }),
          cancelOrder: async (coin, venueOrderId) => {
            cancelledArgs = [coin, venueOrderId];
          },
          getOrderStatus: async () => ({ status: "OPEN" }),
        };
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        clientIntentId: "intent_10",
        accountId: "acct_api_10",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
        orderStyle: "MARKET",
        reduceOnly: false,
      },
    });
    const orderId = created.json().orderId;
    await store.runExclusive("acct_api_10", (ctx) => ctx.recordVenueOrderId(orderId, "venue_oid_own_wallet"));

    const get = await app.inject({ method: "GET", url: `/v1/orders/${orderId}?venueAddress=0xabc` });
    expect(get.statusCode).toBe(200);
    expect(get.json().result).toBe("COMMITTED");

    const cancel = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().reasonCode).toBe("CANCELED_ON_VENUE");
    expect(cancelledArgs).toEqual(["BTC", "venue_oid_own_wallet"]);
  });
});
