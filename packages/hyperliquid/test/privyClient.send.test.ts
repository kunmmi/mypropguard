import { describe, expect, it } from "vitest";
import { PrivyClient } from "../src/privyClient.js";

/** Checks the exact requests the client makes against Privy's documented REST shapes. Live use still needs credentials. */
function client(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const r = handler(url, init);
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { calls, privy: new PrivyClient({ appId: "app-123", appSecret: "secret-xyz", fetchImpl }) };
}

const HASH = `0x${"ab".repeat(32)}` as const;

describe("PrivyClient.sendTransaction", () => {
  it("posts eth_sendTransaction with the chain, hex value, data and gas limit, and returns the hash", async () => {
    const { privy, calls } = client(() => ({ body: { method: "eth_sendTransaction", data: { hash: HASH, caip2: "eip155:56", transaction_id: "tx1" } } }));
    const hash = await privy.sendTransaction("wallet-1", "eip155:56", { to: "0x5c952063c7fc8610FFDB798152D69F0B9550762b", value: 100000000000000000n, data: "0xdeadbeef", gas: 210000n });
    expect(hash).toBe(HASH);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.privy.io/v1/wallets/wallet-1/rpc");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.body).toEqual({
      method: "eth_sendTransaction",
      caip2: "eip155:56",
      chain_type: "ethereum",
      params: { transaction: { to: "0x5c952063c7fc8610FFDB798152D69F0B9550762b", value: "0x16345785d8a0000", data: "0xdeadbeef", gas_limit: 210000 } },
    });
  });

  it("encodes the value as 0x-hex wei (0.1 BNB, zero and a large amount)", async () => {
    const { privy, calls } = client(() => ({ body: { data: { hash: HASH } } }));
    await privy.sendTransaction("w", "eip155:56", { to: "0x1", value: 0n, data: "0x" });
    await privy.sendTransaction("w", "eip155:56", { to: "0x1", value: 10n ** 21n, data: "0x" });
    expect(calls[0]!.body.params.transaction.value).toBe("0x0");
    expect(calls[1]!.body.params.transaction.value).toBe(`0x${(10n ** 21n).toString(16)}`);
  });

  it("omits gas_limit when none is given (Privy then estimates)", async () => {
    const { privy, calls } = client(() => ({ body: { data: { hash: HASH } } }));
    await privy.sendTransaction("w", "eip155:56", { to: "0x1", value: 1n, data: "0x" });
    expect(calls[0]!.body.params.transaction).not.toHaveProperty("gas_limit");
  });

  it("authenticates with the app id and secret, and sends a fresh idempotency key each time", async () => {
    const { privy, calls } = client(() => ({ body: { data: { hash: HASH } } }));
    await privy.sendTransaction("w", "eip155:56", { to: "0x1", value: 1n, data: "0x" });
    await privy.sendTransaction("w", "eip155:56", { to: "0x1", value: 1n, data: "0x" });
    const h = (i: number) => calls[i]!.init.headers as Record<string, string>;
    expect(h(0).Authorization).toBe(`Basic ${Buffer.from("app-123:secret-xyz").toString("base64")}`);
    expect(h(0)["privy-app-id"]).toBe("app-123");
    expect(h(0)["privy-idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h(0)["privy-idempotency-key"]).not.toBe(h(1)["privy-idempotency-key"]);
  });

  it("throws, with Privy's own message, on an HTTP error — and does not retry", async () => {
    const { privy, calls } = client(() => ({ status: 400, body: { error: "policy violation" } }));
    await expect(privy.sendTransaction("w", "eip155:56", { to: "0x1", value: 1n, data: "0x" })).rejects.toThrow(/400.*policy violation/);
    expect(calls).toHaveLength(1);
  });

  it("throws when a 200 reply carries no hash, rather than inventing one", async () => {
    const { privy } = client(() => ({ body: { data: {} } }));
    await expect(privy.sendTransaction("w", "eip155:56", { to: "0x1", value: 1n, data: "0x" })).rejects.toThrow(/no transaction hash/);
  });
});

describe("PrivyClient.personalSign", () => {
  it("posts personal_sign with the text and utf-8 encoding, and returns the signature", async () => {
    const sig = `0x${"cd".repeat(65)}` as const;
    const { privy, calls } = client(() => ({ body: { method: "personal_sign", data: { signature: sig, encoding: "hex" } } }));
    expect(await privy.personalSign("wallet-1", "You are sign in Meme 484138")).toBe(sig);
    expect(calls[0]!.body).toEqual({ method: "personal_sign", params: { message: "You are sign in Meme 484138", encoding: "utf-8" } });
    expect(calls[0]!.url).toBe("https://api.privy.io/v1/wallets/wallet-1/rpc");
  });

  it("throws on an HTTP error and on a reply with no signature", async () => {
    await expect(client(() => ({ status: 403, body: { error: "nope" } })).privy.personalSign("w", "x")).rejects.toThrow(/403/);
    await expect(client(() => ({ body: { data: {} } })).privy.personalSign("w", "x")).rejects.toThrow(/no signature/);
  });
});

describe("PrivyClient existing calls are unchanged", () => {
  it("createEthereumWallet and signTypedData do not send an idempotency key (behaviour as before)", async () => {
    const { privy, calls } = client((url) => ({ body: url.endsWith("/wallets") ? { id: "w1", address: "0xabc", chain_type: "ethereum" } : { data: { signature: "0x1" } } }));
    await privy.createEthereumWallet();
    await privy.signTypedData("w1", { domain: {}, types: {}, primaryType: "X", message: {} });
    for (const c of calls) expect((c.init.headers as Record<string, string>)["privy-idempotency-key"]).toBeUndefined();
  });
});
