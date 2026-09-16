import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
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

  it("returns 501 for cancel/get-order until Phase 2/3 execution exists", async () => {
    const store = makeStoreWithAccount("acct_api_4");
    const app = buildApp({ store });

    const cancel = await app.inject({ method: "POST", url: "/v1/orders/some-id/cancel" });
    expect(cancel.statusCode).toBe(501);

    const get = await app.inject({ method: "GET", url: "/v1/orders/some-id" });
    expect(get.statusCode).toBe(501);
  });
});
