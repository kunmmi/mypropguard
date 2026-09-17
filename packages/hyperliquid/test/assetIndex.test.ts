import { describe, expect, it } from "vitest";
import { fetchAssetIndex } from "../src/assetIndex.js";

const FIXTURE_META = {
  universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }],
};

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("fetchAssetIndex (injected fetch, no real network)", () => {
  it("resolves a known coin to its index in the universe array", async () => {
    const index = await fetchAssetIndex("ETH", { fetchImpl: fakeFetch(FIXTURE_META) });
    expect(index).toBe(1);
  });

  it("throws for an unknown coin", async () => {
    await expect(fetchAssetIndex("DOGE", { fetchImpl: fakeFetch(FIXTURE_META) })).rejects.toThrow(/Unknown Hyperliquid asset/);
  });

  it("throws on a non-OK response", async () => {
    const badFetch = (async () => new Response("error", { status: 500 })) as typeof fetch;
    await expect(fetchAssetIndex("BTC", { fetchImpl: badFetch })).rejects.toThrow(/failed: 500/);
  });
});

/** Real-network smoke test, opt-in only. Public read, no side effects. */
describe.skipIf(!process.env.RUN_NETWORK_TESTS)("fetchAssetIndex against the real API", () => {
  it("resolves BTC to a real asset index", async () => {
    const index = await fetchAssetIndex("BTC");
    expect(index).toBeGreaterThanOrEqual(0);
  }, 15_000);
});
