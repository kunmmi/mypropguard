import { describe, expect, it, vi } from "vitest";
import { MoralisTokenDiscovery } from "../src/moralisTokenDiscovery.js";

const SAFE = "0x5afe00000000000000000000000000000000a001";

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("MoralisTokenDiscovery", () => {
  it("asks for spam-filtered tokens on the right chain with the API key in a header", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ result: [] }));
    await new MoralisTokenDiscovery({ apiKey: "KEY", chain: "bsc", fetchImpl: fetchImpl as any }).discoverTokens(SAFE);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe(`/api/v2.2/wallets/${SAFE}/tokens`);
    expect(url.searchParams.get("chain")).toBe("bsc");
    expect(url.searchParams.get("exclude_spam")).toBe("true");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("KEY");
  });

  it("returns lowercased token addresses, skipping the native coin and anything flagged as spam", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        result: [
          { token_address: "0xAAAA000000000000000000000000000000000001" },
          { token_address: "0xBBBB000000000000000000000000000000000002", possible_spam: true },
          { token_address: "0xCCCC000000000000000000000000000000000003", native_token: true },
          { token_address: "0x0000000000000000000000000000000000000000" },
          { token_address: "0xDDDD000000000000000000000000000000000004", possible_spam: false },
        ],
      }),
    );
    const tokens = await new MoralisTokenDiscovery({ apiKey: "K", chain: "bsc", fetchImpl: fetchImpl as any }).discoverTokens(SAFE);
    expect(tokens).toEqual(["0xaaaa000000000000000000000000000000000001", "0xdddd000000000000000000000000000000000004"]);
  });

  it("follows the pagination cursor", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ result: [{ token_address: "0x1111000000000000000000000000000000000001" }], cursor: "next" }))
      .mockResolvedValueOnce(okResponse({ result: [{ token_address: "0x2222000000000000000000000000000000000002" }], cursor: null }));
    const tokens = await new MoralisTokenDiscovery({ apiKey: "K", chain: "bsc", fetchImpl: fetchImpl as any }).discoverTokens(SAFE);

    expect(tokens).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = fetchImpl.mock.calls[1]![0] as URL;
    expect(secondUrl.searchParams.get("cursor")).toBe("next");
  });

  it("throws on an error response so a bad key or rate limit never looks like 'no tokens'", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response);
    await expect(new MoralisTokenDiscovery({ apiKey: "bad", chain: "bsc", fetchImpl: fetchImpl as any }).discoverTokens(SAFE)).rejects.toThrow("HTTP 401");
  });

  it("includes Moralis's own explanation of a rejection, so a bad key is easy to tell from a rate limit", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ message: "Invalid key" }) }) as Response);
    await expect(new MoralisTokenDiscovery({ apiKey: "bad", chain: "bsc", fetchImpl: fetchImpl as any }).discoverTokens(SAFE)).rejects.toThrow(
      "HTTP 401 (Invalid key)",
    );
  });
});
