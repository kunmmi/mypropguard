import { describe, expect, it, vi } from "vitest";
import { SessionTradeRefused, type SessionTrade } from "@mypropguard/evm";
import { OneClickRequestHandler, type OneClickHandlerDeps } from "../src/oneClick/oneClickRequestHandler.js";
import type { LinkedSession, OneClickRecord } from "../src/oneClick/oneClickStore.js";

const SAFE = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const SESSION_KEY = "0x3333333333333333333333333333333333333333";
const TOPIC = "topic-1";

function setup(overrides: { record?: Partial<OneClickRecord> | null; execute?: (trade: SessionTrade) => Promise<`0x${string}`> } = {}) {
  const session: LinkedSession = { topic: TOPIC, accountId: "acc-1", dappName: "PancakeSwap", dappUrl: "https://pancakeswap.finance", createdAt: new Date(), expiresAt: null };
  const record: OneClickRecord | undefined =
    overrides.record === null
      ? undefined
      : { accountId: "acc-1", sessionWalletId: "wallet-1", sessionWalletAddress: SESSION_KEY, status: "enabled", createdAt: new Date(), enabledAt: new Date(), ...overrides.record };
  const trades: unknown[] = [];
  const execute = vi.fn(overrides.execute ?? (async () => "0xabc0000000000000000000000000000000000000000000000000000000000001" as const));
  const deps: OneClickHandlerDeps = {
    store: {
      get: async () => record,
      getSession: async (topic) => (topic === TOPIC ? session : undefined),
      recordTrade: async (trade) => void trades.push(trade),
    },
    findAccount: async () => ({ evmSafeAddress: SAFE, evmChainId: 56 }),
    executors: { 56: { execute } },
  };
  return { handler: new OneClickRequestHandler(deps), execute, trades };
}

const buy = (extra: Record<string, unknown> = {}) => ({ method: "eth_sendTransaction", params: [{ from: SAFE, to: ROUTER, data: "0x12345678", value: "0xde0b6b3a7640000", ...extra }] });

describe("OneClickRequestHandler", () => {
  it("signs and sends a trade from the linked exchange, and records it", async () => {
    const { handler, execute, trades } = setup();
    const reply = await handler.handle(TOPIC, "eip155:56", buy());

    expect(reply).toEqual({ result: "0xabc0000000000000000000000000000000000000000000000000000000000001" });
    expect(execute).toHaveBeenCalledWith({
      safeAddress: SAFE,
      sessionWalletId: "wallet-1",
      sessionWalletAddress: SESSION_KEY,
      to: ROUTER,
      value: 10n ** 18n,
      data: "0x12345678",
    });
    expect(trades).toMatchObject([{ accountId: "acc-1", dappName: "PancakeSwap", result: "SENT", valueWei: "1000000000000000000" }]);
  });

  it("explains a refusal from the Guard in plain words and records it", async () => {
    const { handler, trades } = setup({ execute: async () => { throw new SessionTradeRefused("GUARD_REFUSED", "Blocked by MyPropGuard: this buy is larger than the per-trade limit."); } });
    const reply = await handler.handle(TOPIC, "eip155:56", buy());

    expect(reply).toEqual({ error: { code: -32000, message: `Blocked by MyPropGuard: this buy is larger than the per-trade limit. [0x12345678 on ${ROUTER}]` } });
    expect(trades).toMatchObject([{ result: "REFUSED" }]);
  });

  it("does not leak internals when something unexpected breaks", async () => {
    const { handler, trades } = setup({ execute: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:8545\n    at secret stack"); } });
    const reply = (await handler.handle(TOPIC, "eip155:56", buy())) as { error: { message: string } };

    expect(reply.error.message).toContain("ECONNREFUSED");
    expect(reply.error.message).not.toContain("secret stack");
    expect(trades).toMatchObject([{ result: "ERROR" }]);
  });

  it("refuses at once when one-click trading is switched off, without signing anything", async () => {
    for (const record of [{ status: "revoked" as const }, { status: "pending" as const }]) {
      const { handler, execute } = setup({ record });
      const reply = (await handler.handle(TOPIC, "eip155:56", buy())) as { error: { message: string } };
      expect(reply.error.message).toContain("switched off");
      expect(execute).not.toHaveBeenCalled();
    }
    const { handler, execute } = setup({ record: null });
    expect(await handler.handle(TOPIC, "eip155:56", buy())).toHaveProperty("error");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a request on a link it does not know", async () => {
    const { handler, execute } = setup();
    expect(await handler.handle("someone-elses-topic", "eip155:56", buy())).toHaveProperty("error");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a trade on another chain, from another address, or a contract deployment", async () => {
    const { handler, execute } = setup();
    expect(await handler.handle(TOPIC, "eip155:1", buy())).toHaveProperty("error.code", 4901);
    expect(await handler.handle(TOPIC, "eip155:56", buy({ from: "0x9999999999999999999999999999999999999999" }))).toHaveProperty("error.code", -32602);
    expect(await handler.handle(TOPIC, "eip155:56", buy({ to: undefined }))).toHaveProperty("error.code", -32602);
    expect(await handler.handle(TOPIC, "eip155:56", buy({ data: "not hex" }))).toHaveProperty("error.code", -32602);
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats a missing value as zero and accepts the data under the input field too", async () => {
    const { handler, execute } = setup();
    await handler.handle(TOPIC, "eip155:56", { method: "eth_sendTransaction", params: [{ from: SAFE, to: ROUTER, input: "0xabcdef" }] });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ value: 0n, data: "0xabcdef" }));
  });

  it("never signs messages, because a Safe signature could be used to get around the limits", async () => {
    const { handler, execute } = setup();
    for (const method of ["personal_sign", "eth_sign", "eth_signTypedData", "eth_signTypedData_v4"]) {
      expect(await handler.handle(TOPIC, "eip155:56", { method, params: [] })).toHaveProperty("error.code", 4200);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers the basic wallet questions with the Safe as the only account", async () => {
    const { handler } = setup();
    expect(await handler.handle(TOPIC, "eip155:56", { method: "eth_accounts" })).toEqual({ result: [SAFE] });
    expect(await handler.handle(TOPIC, "eip155:56", { method: "eth_chainId" })).toEqual({ result: "0x38" });
    expect(await handler.handle(TOPIC, "eip155:56", { method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] })).toEqual({ result: null });
    expect(await handler.handle(TOPIC, "eip155:56", { method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })).toHaveProperty("error.code", 4902);
    expect(await handler.handle(TOPIC, "eip155:56", { method: "eth_getBalance" })).toHaveProperty("error.code", -32601);
  });

  it("names the refused call, and the spender of an approval, so a surprise refusal can be understood", async () => {
    const { handler } = setup({ execute: async () => { throw new SessionTradeRefused("GUARD_REFUSED", "Blocked."); } });
    const spender = "13f4ea83d0bd40e75c8222255bc855a974568dd4";
    const data = `0x39509351000000000000000000000000${spender}${"f".repeat(64)}`;
    const reply = (await handler.handle(TOPIC, "eip155:56", buy({ data, value: "0x0" }))) as { error: { message: string } };
    expect(reply.error.message).toContain(`increaseAllowance (0x39509351) for spender 0x${spender} on ${ROUTER}`);
  });
});
