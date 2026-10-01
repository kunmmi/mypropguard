import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import type { ClearinghouseState, EvmSafeEquityReader, VenueStateReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

function fakeVenueReader(state: ClearinghouseState): VenueStateReader {
  return { getClearinghouseState: async () => state };
}

function fakeEquityReader(equityUsd: Decimal): EvmSafeEquityReader {
  return { getEquityUsd: async () => equityUsd };
}

async function createEvmSafeAccount(app: ReturnType<typeof buildApp>, accountId: string) {
  await app.inject({
    method: "POST",
    url: "/v1/accounts",
    payload: {
      accountId,
      ownerUserId: "owner_recon",
      venue: "bsc-pancakeswap",
      initialEquity: "10000",
      evmOwnerWalletAddress: "0xTRADERWALLET",
      evmChainId: 56,
    },
  });
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

describe("POST /v1/accounts/:accountId/reconcile-evm", () => {
  it("reads live equity for the account's chain and updates its AccountRiskHead", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
      evmEquityReaders: { 56: fakeEquityReader(new Decimal(8_500)) },
    });
    await createEvmSafeAccount(app, "acct_recon_evm_1");

    const response = await app.inject({ method: "POST", url: "/v1/accounts/acct_recon_evm_1/reconcile-evm" });

    expect(response.statusCode).toBe(200);
    expect(response.json().currentEquity).toBe("8500");
  });

  it("returns 501 when no equity reader is configured for the account's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
    });
    await createEvmSafeAccount(app, "acct_recon_evm_2");

    const response = await app.inject({ method: "POST", url: "/v1/accounts/acct_recon_evm_2/reconcile-evm" });

    expect(response.statusCode).toBe(501);
  });

  it("returns 501 for a non-EVM (Hyperliquid) account", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_recon_hl" }));
    const app = buildApp({ store, evmEquityReaders: { 56: fakeEquityReader(new Decimal(0)) } });

    const response = await app.inject({ method: "POST", url: "/v1/accounts/acct_recon_hl/reconcile-evm" });

    expect(response.statusCode).toBe(501);
  });
});
