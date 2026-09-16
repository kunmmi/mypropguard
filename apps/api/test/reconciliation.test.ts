import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import type { ClearinghouseState, VenueStateReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

function fakeVenueReader(state: ClearinghouseState): VenueStateReader {
  return { getClearinghouseState: async () => state };
}

describe("POST /v1/accounts/:accountId/reconcile", () => {
  it("updates account state from the venue reader and flips protection to trade-ready", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_recon_1" }));
    store.seedProtectionEnabled("acct_recon_1", true);

    const venueReader = fakeVenueReader({
      accountValue: new Decimal(9_500),
      totalMarginUsed: new Decimal(500),
      totalNotionalPosition: new Decimal(2_000),
      withdrawable: new Decimal(9_000),
      positions: [],
    });

    const app = buildApp({ store, venueReader });

    const reconcileResponse = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_recon_1/reconcile",
      payload: { venueAddress: "0xabc" },
    });
    expect(reconcileResponse.statusCode).toBe(200);
    expect(reconcileResponse.json().currentEquity).toBe("9500");

    const protectionResponse = await app.inject({ method: "GET", url: "/v1/protection/acct_recon_1" });
    const body = protectionResponse.json();
    expect(body.botCanOpenNewTrades).toBe(true);
    expect(body.walletNeedsAttention).toBe(false);
  });

  it("returns 501 when no venue reader is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_none/reconcile",
      payload: { venueAddress: "0xabc" },
    });

    expect(response.statusCode).toBe(501);
  });

  it("rejects a malformed request with 400", async () => {
    const store = new InMemoryRiskLedgerStore();
    const venueReader = fakeVenueReader({
      accountValue: new Decimal(0),
      totalMarginUsed: new Decimal(0),
      totalNotionalPosition: new Decimal(0),
      withdrawable: new Decimal(0),
      positions: [],
    });
    const app = buildApp({ store, venueReader });

    const response = await app.inject({ method: "POST", url: "/v1/accounts/acct_x/reconcile", payload: {} });

    expect(response.statusCode).toBe(400);
  });
});
