import { describe, expect, it } from "vitest";
import { HyperliquidExchangeClient, splitSignature } from "../src/exchangeClient.js";

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("splitSignature (pure, no network)", () => {
  it("splits a 65-byte signature into r, s, v", () => {
    const r = "a".repeat(64);
    const s = "b".repeat(64);
    const v = "1c"; // 28
    const signature = `0x${r}${s}${v}` as `0x${string}`;

    expect(splitSignature(signature)).toEqual({
      r: `0x${r}`,
      s: `0x${s}`,
      v: 28,
    });
  });

  it("throws on a wrong-length signature", () => {
    expect(() => splitSignature("0xabcd" as `0x${string}`)).toThrow(/65-byte/);
  });
});

describe("HyperliquidExchangeClient.submitAction (injected fetch, no real network)", () => {
  const signature = `0x${"a".repeat(64)}${"b".repeat(64)}1c` as `0x${string}`;

  it("posts the action, nonce, and split signature, and returns the response on success", async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ status: "ok", response: { type: "order", data: { statuses: ["resting"] } } }), {
        status: 200,
      });
    }) as typeof fetch;

    const client = new HyperliquidExchangeClient({ fetchImpl });
    const result = await client.submitAction({
      action: { type: "order", orders: [], grouping: "na" },
      nonce: 123,
      signature,
    });

    expect(result).toEqual({ type: "order", data: { statuses: ["resting"] } });
    expect(capturedBody).toMatchObject({
      action: { type: "order", orders: [], grouping: "na" },
      nonce: 123,
      vaultAddress: null,
      signature: { r: `0x${"a".repeat(64)}`, s: `0x${"b".repeat(64)}`, v: 28 },
    });
  });

  it("throws when Hyperliquid rejects the action", async () => {
    const client = new HyperliquidExchangeClient({
      fetchImpl: fakeFetch({ status: "err", response: "Invalid nonce" }),
    });

    await expect(
      client.submitAction({ action: { type: "order", orders: [], grouping: "na" }, nonce: 1, signature }),
    ).rejects.toThrow(/rejected the action/);
  });

  it("throws on a non-OK HTTP response", async () => {
    const client = new HyperliquidExchangeClient({
      fetchImpl: (async () => new Response("server error", { status: 500 })) as typeof fetch,
    });

    await expect(
      client.submitAction({ action: { type: "order", orders: [], grouping: "na" }, nonce: 1, signature }),
    ).rejects.toThrow(/failed: 500/);
  });
});
