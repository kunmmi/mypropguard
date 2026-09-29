import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderSide } from "@mypropguard/domain";
import { HyperliquidOrderLifecycle } from "../src/orderLifecycle.js";
import { HYPERLIQUID_TESTNET_EXCHANGE_URL } from "../src/exchangeClient.js";
import { HYPERLIQUID_TESTNET_INFO_URL } from "../src/infoClient.js";
import { PrivyClient } from "../src/privyClient.js";

const FIXTURE_META = { universe: [{ name: "BTC" }] };

function buildFetch(handlers: { onExchange?: (body: unknown) => unknown; onInfo?: (body: unknown) => unknown }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (String(url).includes("privy.io")) {
      return new Response(JSON.stringify({ data: { signature: `0x${"a".repeat(130)}` } }), { status: 200 });
    }
    if (String(url) === HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      return new Response(JSON.stringify(handlers.onExchange?.(body) ?? { status: "ok", response: {} }), { status: 200 });
    }
    if (body?.type === "meta") {
      return new Response(JSON.stringify(FIXTURE_META), { status: 200 });
    }
    return new Response(JSON.stringify(handlers.onInfo?.(body) ?? {}), { status: 200 });
  }) as typeof fetch;
}

describe("HyperliquidOrderLifecycle (injected fetch, no real network or credentials)", () => {
  const action = {
    accountId: "acct_1",
    clientIntentId: "intent_1",
    coin: "BTC",
    side: OrderSide.BUY,
    size: new Decimal(1),
    price: new Decimal(50_000),
    reduceOnly: false,
    nonce: 1,
    expiresAt: new Date(Date.now() + 30_000),
  };
  const signed = {
    authorization: { connectionId: "0xdead", reservationId: "resv_1", accountId: "acct_1", issuedAt: new Date(), expiresAt: action.expiresAt },
    signature: `0x${"a".repeat(130)}`,
    signerAddress: "0x0000000000000000000000000000000000000001",
  };

  it("submit() extracts the venue order id from a resting order response", async () => {
    const fetchImpl = buildFetch({
      onExchange: () => ({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 555 } }] } } }),
    });
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl });
    const lifecycle = new HyperliquidOrderLifecycle({ privyClient, walletId: "wallet_1", isTestnet: true, assetIndexOptions: { fetchImpl }, exchangeClientOptions: { fetchImpl } });

    const result = await lifecycle.submit(signed, action);
    expect(result.venueOrderId).toBe("555");
  });

  it("submit() extracts the venue order id from a filled order response", async () => {
    const fetchImpl = buildFetch({
      onExchange: () => ({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 777, totalSz: "1", avgPx: "50000" } }] } } }),
    });
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl });
    const lifecycle = new HyperliquidOrderLifecycle({ privyClient, walletId: "wallet_1", isTestnet: true, assetIndexOptions: { fetchImpl }, exchangeClientOptions: { fetchImpl } });

    const result = await lifecycle.submit(signed, action);
    expect(result.venueOrderId).toBe("777");
  });

  it("submit() throws if the venue accepts the order but returns no oid", async () => {
    const fetchImpl = buildFetch({ onExchange: () => ({ status: "ok", response: { type: "order", data: { statuses: [{}] } } }) });
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl });
    const lifecycle = new HyperliquidOrderLifecycle({ privyClient, walletId: "wallet_1", isTestnet: true, assetIndexOptions: { fetchImpl }, exchangeClientOptions: { fetchImpl } });

    await expect(lifecycle.submit(signed, action)).rejects.toThrow(/no order id/);
  });

  it("cancelOrder() resolves the asset index and submits a real cancel action shape", async () => {
    let capturedExchangeBody: unknown;
    const fetchImpl = buildFetch({
      onExchange: (body) => {
        capturedExchangeBody = body;
        return { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } };
      },
    });
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl });
    const lifecycle = new HyperliquidOrderLifecycle({ privyClient, walletId: "wallet_1", isTestnet: true, assetIndexOptions: { fetchImpl }, exchangeClientOptions: { fetchImpl } });

    await lifecycle.cancelOrder("BTC", "555");

    expect(capturedExchangeBody).toMatchObject({ action: { type: "cancel", cancels: [{ a: 0, o: 555 }] } });
  });

  it("cancelOrder() throws when the venue rejects the cancel", async () => {
    const fetchImpl = buildFetch({
      onExchange: () => ({ status: "ok", response: { type: "cancel", data: { statuses: [{ error: "Order already filled" }] } } }),
    });
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl });
    const lifecycle = new HyperliquidOrderLifecycle({ privyClient, walletId: "wallet_1", isTestnet: true, assetIndexOptions: { fetchImpl }, exchangeClientOptions: { fetchImpl } });

    await expect(lifecycle.cancelOrder("BTC", "555")).rejects.toThrow(/already filled/);
  });

  it("getOrderStatus() maps a real resting-order response to OPEN", async () => {
    const fetchImpl = buildFetch({
      onInfo: () => ({ status: "order", order: { order: {}, status: "open", statusTimestamp: 1 } }),
    });
    const lifecycle = new HyperliquidOrderLifecycle({
      privyClient: new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl }),
      walletId: "wallet_1",
      isTestnet: true,
      infoOptions: { fetchImpl },
    });

    const result = await lifecycle.getOrderStatus("0xabc", "555");
    expect(result.status).toBe("OPEN");
  });

  it("getOrderStatus() maps an unknown oid to UNKNOWN", async () => {
    const fetchImpl = buildFetch({ onInfo: () => ({ status: "unknownOid" }) });
    const lifecycle = new HyperliquidOrderLifecycle({
      privyClient: new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl }),
      walletId: "wallet_1",
      isTestnet: true,
      infoOptions: { fetchImpl },
    });

    const result = await lifecycle.getOrderStatus("0xabc", "999");
    expect(result.status).toBe("UNKNOWN");
  });

  it("defaults assetIndexOptions/exchangeClientOptions/infoOptions.baseUrl from isTestnet", () => {
    const lifecycle = new HyperliquidOrderLifecycle({
      privyClient: new PrivyClient({ appId: "id", appSecret: "secret" }),
      walletId: "wallet_1",
      isTestnet: true,
    });
    expect(lifecycle["assetIndexOptions"].baseUrl).toBe(HYPERLIQUID_TESTNET_INFO_URL);
    expect(lifecycle["exchangeClientOptions"].baseUrl).toBe(HYPERLIQUID_TESTNET_EXCHANGE_URL);
    expect(lifecycle["infoOptions"].baseUrl).toBe(HYPERLIQUID_TESTNET_INFO_URL);
  });
});
