import { describe, expect, it } from "vitest";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";
import type { SolanaDeps } from "../src/routes/solana.js";
import type { SolanaRequestRecord, SolanaWalletRow } from "../src/solana/solanaStore.js";
import type { LinkedSession } from "../src/oneClick/oneClickStore.js";

const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function rig() {
  const rows = new Map<string, SolanaWalletRow>();
  const requests: SolanaRequestRecord[] = [];
  const pairs: unknown[][] = [];
  const disconnected: string[] = [];
  const offFor: unknown[][] = [];
  const sessions: LinkedSession[] = [
    { topic: "sol-1", accountId: "a1", kind: "solana", dappName: "pump.fun", dappUrl: "https://pump.fun", createdAt: new Date(), expiresAt: null },
    { topic: "safe-1", accountId: "a1", kind: "safe", dappName: "PancakeSwap", dappUrl: null, createdAt: new Date(), expiresAt: null },
    { topic: "sol-other", accountId: "a2", kind: "solana", dappName: "pump.fun", dappUrl: null, createdAt: new Date(), expiresAt: null },
  ];
  const store: any = {
    get: async (id: string) => rows.get(id),
    create: async (i: any) => void rows.set(i.accountId, { accountId: i.accountId, walletId: i.walletId, address: i.address, status: "active", createdAt: new Date() }),
    setStatus: async (id: string, status: "active" | "off") => void (rows.get(id)!.status = status),
    listRequests: async () => requests.map((r) => ({ createdAt: new Date(), ...r, code: r.code ?? null, message: r.message ?? null, detail: r.detail ?? null })),
  };
  const solana: SolanaDeps = {
    store,
    service: {
      pair: async (...a: unknown[]) => void pairs.push(a),
      disconnect: async (t: string) => void disconnected.push(t),
      disconnectAccount: async (...a: unknown[]) => void offFor.push(a),
    } as never,
    createWallet: async () => ({ id: "privy-sol", address: ADDRESS }),
  };
  const oneClick: any = { store: { listSessions: async (id: string) => sessions.filter((s) => s.accountId === id), getSession: async (t: string) => sessions.find((s) => s.topic === t) } };
  const app = buildApp({ store: new InMemoryRiskLedgerStore(), solana, oneClick });
  const mk = (id: string) => app.inject({ method: "POST", url: "/v1/accounts", payload: { accountId: id, ownerUserId: "u", initialEquity: "1" } });
  const post = (id: string, path: string, payload: unknown = {}) => app.inject({ method: "POST", url: `/v1/accounts/${id}/solana/${path}`, payload: payload as never });
  return { app, rows, requests, pairs, disconnected, offFor, mk, post };
}

describe("Solana wallet routes", () => {
  it("reports no wallet yet, then creates one and returns its address", async () => {
    const { app, mk, post } = rig();
    await mk("a1");
    expect((await app.inject({ method: "GET", url: "/v1/accounts/a1/solana" })).json()).toEqual({ available: true, exists: false });
    expect((await post("a1", "create")).json()).toEqual({ ok: true, address: ADDRESS, status: "active" });
    expect((await app.inject({ method: "GET", url: "/v1/accounts/a1/solana" })).json()).toMatchObject({ exists: true, address: ADDRESS, status: "active" });
  });

  it("refuses a second wallet, and an account that does not exist", async () => {
    const { mk, post } = rig();
    await mk("a1");
    await post("a1", "create");
    expect((await post("a1", "create")).statusCode).toBe(409);
    expect((await post("ghost", "create")).statusCode).toBe(404);
  });

  it("lists only this account's Solana links, not its Safe links or anyone else's", async () => {
    const { app, mk, post } = rig();
    await mk("a1");
    await post("a1", "create");
    const links = (await app.inject({ method: "GET", url: "/v1/accounts/a1/solana" })).json().links;
    expect(links.map((l: { topic: string }) => l.topic)).toEqual(["sol-1"]);
  });

  it("shows what sites asked for, with the decoded detail", async () => {
    const { app, mk, post, requests } = rig();
    await mk("a1");
    await post("a1", "create");
    requests.push({ accountId: "a1", dappName: "pump.fun", kind: "transaction", method: "solana_signTransaction", result: "REFUSED", code: "TRADING_NOT_ENABLED", message: "2 steps", detail: { transactions: [] } });
    const body = (await app.inject({ method: "GET", url: "/v1/accounts/a1/solana" })).json();
    expect(body.requests[0]).toMatchObject({ kind: "transaction", result: "REFUSED", code: "TRADING_NOT_ENABLED", detail: { transactions: [] } });
  });

  it("connects a site as a Solana link, only while switched on", async () => {
    const { mk, post, pairs } = rig();
    await mk("a1");
    expect((await post("a1", "pair", { uri: "wc:x" })).statusCode).toBe(409);
    await post("a1", "create");
    expect((await post("a1", "pair", { uri: "wc:abc" })).statusCode).toBe(200);
    expect(pairs).toEqual([["a1", "wc:abc", "solana"]]);
    expect((await post("a1", "pair", {})).statusCode).toBe(400);
  });

  it("disconnects only a Solana link that belongs to this account", async () => {
    const { mk, post, disconnected } = rig();
    await mk("a1");
    expect((await post("a1", "disconnect", { topic: "sol-1" })).statusCode).toBe(200);
    expect((await post("a1", "disconnect", { topic: "safe-1" })).statusCode).toBe(404);
    expect((await post("a1", "disconnect", { topic: "sol-other" })).statusCode).toBe(404);
    expect((await post("a1", "disconnect", {})).statusCode).toBe(400);
    expect(disconnected).toEqual(["sol-1"]);
  });

  it("switching off drops only the Solana links and stops the wallet answering", async () => {
    const { mk, post, rows, offFor } = rig();
    await mk("a1");
    await post("a1", "create");
    expect((await post("a1", "off")).statusCode).toBe(200);
    expect(rows.get("a1")!.status).toBe("off");
    expect(offFor).toEqual([["a1", "solana"]]);
    expect((await post("a1", "pair", { uri: "wc:abc" })).statusCode).toBe(409);
    await post("a1", "on");
    expect(rows.get("a1")!.status).toBe("active");
  });
});
