import { describe, expect, it, vi } from "vitest";
import { GoldRushTokenDiscovery } from "../src/goldRushTokenDiscovery.js";

const SAFE = "0x5afe00000000000000000000000000000000a001";

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("GoldRushTokenDiscovery", () => {
  it("asks for spam-filtered balances on the right chain with the key as a bearer token", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ data: { items: [] } }));
    await new GoldRushTokenDiscovery({ apiKey: "KEY", chain: "bsc-mainnet", fetchImpl: fetchImpl as any }).discoverTokens(SAFE);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe(`/v1/bsc-mainnet/address/${SAFE}/balances_v2/`);
    expect(url.searchParams.get("no-spam")).toBe("true");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
  });

  it("returns lowercased token addresses, skipping the native coin and anything flagged as spam", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        data: {
          items: [
            { contract_address: "0xAAAA000000000000000000000000000000000001", balance: "5" },
            { contract_address: "0xBBBB000000000000000000000000000000000002", is_spam: true },
            { contract_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", native_token: true },
            { contract_address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" },
            { contract_address: "0xDDDD000000000000000000000000000000000004", is_spam: false },
          ],
        },
      }),
    );
    const tokens = await new GoldRushTokenDiscovery({ apiKey: "K", chain: "bsc-mainnet", fetchImpl: fetchImpl as any }).discoverTokens(SAFE);
    expect(tokens).toEqual(["0xaaaa000000000000000000000000000000000001", "0xdddd000000000000000000000000000000000004"]);
  });

  it("throws, with GoldRush's reason, on a rejection so a bad key never looks like 'no tokens'", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: true, error_message: "Invalid API key" }) }) as Response);
    await expect(new GoldRushTokenDiscovery({ apiKey: "bad", chain: "bsc-mainnet", fetchImpl: fetchImpl as any }).discoverTokens(SAFE)).rejects.toThrow(
      "HTTP 401 (Invalid API key)",
    );
  });

  it("also throws when GoldRush answers 200 but flags an error", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ error: true, error_message: "chain not supported" }));
    await expect(new GoldRushTokenDiscovery({ apiKey: "k", chain: "nope", fetchImpl: fetchImpl as any }).discoverTokens(SAFE)).rejects.toThrow("chain not supported");
  });
});
