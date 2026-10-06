import { describe, expect, it, vi } from "vitest";
import { SafeTxServiceTokenDiscovery } from "../src/safeTxServiceTokenDiscovery.js";

const SAFE = "0x4F7Cd9A21e3c5666588E2E735653F8fcd907D634";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const SPAM = "0x00000000000000000000000000000000005b4a11";
const POOL = "0x1E21360000000000000000000000000000000001";

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Routes by URL path, the way the real service does. */
function service(routes: { executed?: unknown[]; transfers?: unknown[]; executedStatus?: number }) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/multisig-transactions/")) {
      if (routes.executedStatus && routes.executedStatus !== 200) return json({}, routes.executedStatus);
      return json({ count: (routes.executed ?? []).length, next: null, results: routes.executed ?? [] });
    }
    if (u.includes("/transfers/")) return json({ count: (routes.transfers ?? []).length, next: null, results: routes.transfers ?? [] });
    throw new Error(`unexpected url ${u}`);
  });
}

const tx = (nonce: number, hash: string) => ({ nonce, transactionHash: hash, isExecuted: true });
const transfer = (token: string, from: string, to: string, hash: string) => ({ type: "ERC20_TRANSFER", from, to, tokenAddress: token, transactionHash: hash });

describe("SafeTxServiceTokenDiscovery", () => {
  it("finds a token that arrived in one of the Safe's own executed transactions", async () => {
    const fetchImpl = service({
      executed: [tx(2, "0xsell"), tx(1, "0xapprove"), tx(0, "0xbuy")],
      transfers: [transfer(CAKE, SAFE, POOL, "0xsell"), transfer(CAKE, POOL, SAFE, "0xbuy")],
    });
    const tokens = await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 3 });
    expect(tokens).toEqual([CAKE.toLowerCase()]);
  });

  it("ignores a token that was simply sent to the Safe (an airdrop), since it is not in a Safe transaction", async () => {
    const fetchImpl = service({
      executed: [tx(0, "0xbuy")],
      transfers: [transfer(SPAM, "0xsomeone", SAFE, "0xairdrop"), transfer(CAKE, POOL, SAFE, "0xbuy")],
    });
    const tokens = await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 1 });
    expect(tokens).toEqual([CAKE.toLowerCase()]);
  });

  it("ignores transfers out of the Safe", async () => {
    const fetchImpl = service({ executed: [tx(0, "0xsend")], transfers: [transfer(CAKE, SAFE, POOL, "0xsend")] });
    const tokens = await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 1 });
    expect(tokens).toEqual([]);
  });

  it("matches addresses and hashes regardless of letter case", async () => {
    const fetchImpl = service({
      executed: [tx(0, "0xAbC123")],
      transfers: [transfer(CAKE, POOL, SAFE.toLowerCase(), "0xabc123")],
    });
    const tokens = await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 1 });
    expect(tokens).toEqual([CAKE.toLowerCase()]);
  });

  it("throws when the index has not caught up to the Safe's on-chain transaction count, rather than miss the newest buy", async () => {
    const fetchImpl = service({ executed: [tx(0, "0xbuy")], transfers: [] });
    await expect(
      new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 2 }),
    ).rejects.toThrow("indexed 1 of 2");
  });

  it("returns nothing for a brand-new Safe the service does not know yet (nonce 0)", async () => {
    const fetchImpl = service({ executedStatus: 404 });
    expect(await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 0 })).toEqual([]);
  });

  it("treats a Safe the service does not know as an error once the Safe has run transactions", async () => {
    const fetchImpl = service({ executedStatus: 404 });
    await expect(
      new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 1 }),
    ).rejects.toThrow("HTTP 404");
  });

  it("follows pagination", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/multisig-transactions/")) {
        return u.includes("page2")
          ? json({ next: null, results: [tx(0, "0xbuy")] })
          : json({ next: "https://example.test/multisig-transactions/?page2", results: [tx(1, "0xsell")] });
      }
      return json({ next: null, results: [transfer(CAKE, POOL, SAFE, "0xbuy")] });
    });
    const tokens = await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 2 });
    expect(tokens).toEqual([CAKE.toLowerCase()]);
  });

  it("uses the chain slug in the URL and sends a key only when one is configured", async () => {
    const fetchImpl = service({ executed: [], transfers: [] });
    await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", fetchImpl: fetchImpl as any }).discoverTokens(SAFE, { nonce: 0 });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/tx-service/bnb/api/v1/safes/");
    expect(((fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBeUndefined();

    const keyed = service({ executed: [], transfers: [] });
    await new SafeTxServiceTokenDiscovery({ chainSlug: "bnb", apiKey: "K", fetchImpl: keyed as any }).discoverTokens(SAFE, { nonce: 0 });
    expect(((keyed.mock.calls[0]![1] as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer K");
  });
});
