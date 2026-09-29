import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { OrderSide } from "@mypropguard/domain";
import { HyperliquidActionHasher } from "../src/hyperliquidActionHasher.js";
import { HYPERLIQUID_MAINNET_INFO_URL, HYPERLIQUID_TESTNET_INFO_URL } from "../src/infoClient.js";
import { PrivyClient } from "../src/privyClient.js";
import { PrivySignerGateway } from "../src/privySignerGateway.js";

const FIXTURE_META = { universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }] };

function buildFetch(urlsHit: string[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    urlsHit.push(String(url));
    if (String(url).includes("privy.io")) {
      return new Response(JSON.stringify({ data: { signature: `0x${"a".repeat(130)}` } }), { status: 200 });
    }
    void init;
    return new Response(JSON.stringify(FIXTURE_META), { status: 200 });
  }) as typeof fetch;
}

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

// FIXTURE_META is identical regardless of which URL serves it, so a
// "control" hasher built against any mocked URL computes the same
// connectionId the gateway will - its calls are tracked in their own array,
// separate from `gatewayUrlsHit`, so assertions only reflect what the
// gateway itself (the thing under test) actually did.
function computeExpectedConnectionId(): Promise<string> {
  return new HyperliquidActionHasher({ assetIndexOptions: { fetchImpl: buildFetch([]) } }).computeConnectionId(action);
}

describe("PrivySignerGateway asset-index network selection (injected fetch, no real network or credentials)", () => {
  it("defaults to the TESTNET Info API when isTestnet is true and no assetIndexOptions given", async () => {
    const gatewayUrlsHit: string[] = [];
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl: buildFetch(gatewayUrlsHit) });
    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: "wallet_1",
      walletAddress: "0x0000000000000000000000000000000000000001",
      isTestnet: true,
      // Only mocks the network - baseUrl is left unset so the gateway's own
      // default-selection logic is what's under test here.
      assetIndexOptions: { fetchImpl: buildFetch(gatewayUrlsHit) },
    });

    const connectionId = await computeExpectedConnectionId();
    await gateway.signExact(
      { connectionId, reservationId: "resv_1", accountId: "acct_1", issuedAt: new Date(), expiresAt: action.expiresAt },
      action,
    );

    expect(gatewayUrlsHit.some((url) => url === HYPERLIQUID_TESTNET_INFO_URL)).toBe(true);
    expect(gatewayUrlsHit.some((url) => url === HYPERLIQUID_MAINNET_INFO_URL)).toBe(false);
  });

  it("defaults to the MAINNET Info API when isTestnet is false", async () => {
    const gatewayUrlsHit: string[] = [];
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl: buildFetch(gatewayUrlsHit) });
    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: "wallet_1",
      walletAddress: "0x0000000000000000000000000000000000000001",
      isTestnet: false,
      assetIndexOptions: { fetchImpl: buildFetch(gatewayUrlsHit) },
    });

    const connectionId = await computeExpectedConnectionId();
    await gateway.signExact(
      { connectionId, reservationId: "resv_1", accountId: "acct_1", issuedAt: new Date(), expiresAt: action.expiresAt },
      action,
    );

    expect(gatewayUrlsHit.some((url) => url === HYPERLIQUID_MAINNET_INFO_URL)).toBe(true);
    expect(gatewayUrlsHit.some((url) => url === HYPERLIQUID_TESTNET_INFO_URL)).toBe(false);
  });

  it("an explicit assetIndexOptions.baseUrl overrides the isTestnet default", async () => {
    const gatewayUrlsHit: string[] = [];
    const customUrl = "https://custom.example/info";
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl: buildFetch(gatewayUrlsHit) });
    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: "wallet_1",
      walletAddress: "0x0000000000000000000000000000000000000001",
      isTestnet: true,
      assetIndexOptions: { baseUrl: customUrl, fetchImpl: buildFetch(gatewayUrlsHit) },
    });

    const connectionId = await computeExpectedConnectionId();
    await gateway.signExact(
      { connectionId, reservationId: "resv_1", accountId: "acct_1", issuedAt: new Date(), expiresAt: action.expiresAt },
      action,
    );

    expect(gatewayUrlsHit.some((url) => url === customUrl)).toBe(true);
    expect(gatewayUrlsHit.some((url) => url === HYPERLIQUID_TESTNET_INFO_URL)).toBe(false);
  });
});
