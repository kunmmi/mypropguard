import { describe, expect, it } from "vitest";
import { HYPERLIQUID_MAINNET_INFO_URL, HyperliquidInfoClient, mapClearinghouseState } from "../src/infoClient.js";

const FIXTURE_RESPONSE = {
  marginSummary: { accountValue: "12345.67", totalMarginUsed: "2000.50", totalNtlPos: "8000.25" },
  withdrawable: "10345.17",
  assetPositions: [
    {
      position: { coin: "BTC", szi: "0.5", positionValue: "25000.00", leverage: { value: 3 } },
    },
    {
      position: { coin: "ETH", szi: "-2.0", positionValue: "6000.00", leverage: { value: 5 } },
    },
  ],
};

describe("mapClearinghouseState (pure, no network)", () => {
  it("maps Hyperliquid's raw response into the normalized ClearinghouseState shape", () => {
    const state = mapClearinghouseState(FIXTURE_RESPONSE);

    expect(state.accountValue.toString()).toBe("12345.67");
    expect(state.totalMarginUsed.toString()).toBe("2000.5");
    expect(state.totalNotionalPosition.toString()).toBe("8000.25");
    expect(state.withdrawable.toString()).toBe("10345.17");
    expect(state.positions).toHaveLength(2);
    expect(state.positions[0]!.coin).toBe("BTC");
    expect(state.positions[0]!.positionValue.toString()).toBe("25000");
    expect(state.positions[0]!.leverage.toString()).toBe("3");
  });

  it("preserves signed position size (short positions stay negative)", () => {
    const state = mapClearinghouseState(FIXTURE_RESPONSE);
    expect(state.positions[0]!.size.toString()).toBe("0.5");
    expect(state.positions[1]!.size.toString()).toBe("-2");
  });

  it("handles an account with no open positions", () => {
    const state = mapClearinghouseState({
      marginSummary: { accountValue: "0.0", totalMarginUsed: "0.0", totalNtlPos: "0.0" },
      withdrawable: "0.0",
      assetPositions: [],
    });

    expect(state.accountValue.toString()).toBe("0");
    expect(state.positions).toHaveLength(0);
  });
});

describe("HyperliquidInfoClient with an injected fetch (no real network)", () => {
  it("posts the clearinghouseState request and parses the response", async () => {
    const requests: Array<{ url: string; body: any }> = [];

    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      requests.push({ url, body });
      // A standard (non-unified) account: the perps balance is the account value.
      return new Response(JSON.stringify(body.type === "userAbstraction" ? "default" : FIXTURE_RESPONSE), { status: 200 });
    }) as typeof fetch;

    const client = new HyperliquidInfoClient({ fetchImpl: fakeFetch });
    const state = await client.getClearinghouseState("0xabc123");

    expect(requests.every((r) => r.url === HYPERLIQUID_MAINNET_INFO_URL)).toBe(true);
    expect(requests[0]!.body).toEqual({ type: "clearinghouseState", user: "0xabc123" });
    expect(state.accountValue.toString()).toBe("12345.67");
    expect(state.accountMode).toBe("standard");
  });

  it("throws with the status code on a non-OK response", async () => {
    const fakeFetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const client = new HyperliquidInfoClient({ fetchImpl: fakeFetch });

    await expect(client.getClearinghouseState("0xabc123")).rejects.toThrow("400");
  });
});

/**
 * Real-network smoke test against Hyperliquid's public mainnet API. Skipped
 * when offline; run with RUN_NETWORK_TESTS=1 to opt in explicitly. This is a
 * pure public read (any address, no auth) — it can never place a trade or
 * move funds.
 */
describe.skipIf(!process.env.RUN_NETWORK_TESTS)("HyperliquidInfoClient against the real API", () => {
  it("fetches clearinghouseState for a zero-activity address", async () => {
    const client = new HyperliquidInfoClient();
    const state = await client.getClearinghouseState("0x0000000000000000000000000000000000000000");

    expect(state.accountValue).toBeDefined();
    expect(Array.isArray(state.positions)).toBe(true);
  }, 15_000);
});
