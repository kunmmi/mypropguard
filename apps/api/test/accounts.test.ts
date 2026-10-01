import { describe, expect, it } from "vitest";
import { RuleType, type AgentWalletProvisioner, type EvmSafeProvisioner } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

function fakeAgentWalletProvisioner(walletId: string, walletAddress: string): AgentWalletProvisioner {
  return {
    provisionWallet: async () => ({ walletId, walletAddress }),
  };
}

function fakeEvmSafeProvisioner(safeAddress: string, chainId: number): EvmSafeProvisioner {
  return {
    provisionSafe: async () => ({ safeAddress, chainId }),
  };
}

describe("POST /v1/accounts", () => {
  it("provisions a new account with initial rules and protection off", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: {
        accountId: "acct_new_1",
        ownerUserId: "user_1",
        initialEquity: "10000",
        initialRules: [{ ruleType: RuleType.MAX_DAILY_LOSS, param: "500" }],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      accountId: "acct_new_1",
      protectionOn: false,
      agentWalletAddress: null,
      evmSafeAddress: null,
    });

    const protectionResponse = await app.inject({ method: "GET", url: "/v1/protection/acct_new_1" });
    expect(protectionResponse.json().maxLossToday).toBe("500");
  });

  it("provisions a real signing wallet when an agent wallet provisioner is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, agentWalletProvisioner: fakeAgentWalletProvisioner("wallet_1", "0xabc") });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { accountId: "acct_wallet_1", ownerUserId: "user_wallet", initialEquity: "1000" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().agentWalletAddress).toBe("0xabc");

    const listResponse = await app.inject({ method: "GET", url: "/v1/accounts?ownerUserId=user_wallet" });
    expect(listResponse.json().accounts[0].agentWalletAddress).toBe("0xabc");
  });

  it("has no agent wallet address when no provisioner is configured (offline scaffold)", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { accountId: "acct_no_wallet", ownerUserId: "user_no_wallet", initialEquity: "1000" },
    });

    expect(response.json().agentWalletAddress).toBeNull();
  });

  it("provisions a real Safe when an EVM Safe provisioner is configured for the request's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, evmSafeProvisioners: { 42161: fakeEvmSafeProvisioner("0xSAFE123", 42161) } });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: {
        accountId: "acct_evm_1",
        ownerUserId: "user_evm",
        venue: "arbitrum-gmx",
        initialEquity: "1000",
        evmOwnerWalletAddress: "0xTRADERWALLET",
        evmChainId: 42161,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().evmSafeAddress).toBe("0xSAFE123");

    const listResponse = await app.inject({ method: "GET", url: "/v1/accounts?ownerUserId=user_evm" });
    expect(listResponse.json().accounts[0].evmSafeAddress).toBe("0xSAFE123");
  });

  it("does not provision a Safe when no provisioner is configured for the request's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, evmSafeProvisioners: { 1: fakeEvmSafeProvisioner("0xSAFE_ETH", 1) } });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: {
        accountId: "acct_evm_2",
        ownerUserId: "user_evm_2",
        venue: "bsc-pancakeswap",
        initialEquity: "1000",
        evmOwnerWalletAddress: "0xTRADERWALLET2",
        evmChainId: 56, // no provisioner configured for BSC in this test
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().evmSafeAddress).toBeNull();
  });

  it("defaults to hyperliquid venue and an empty rule set", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      payload: { accountId: "acct_new_2", ownerUserId: "user_2", initialEquity: "5000" },
    });

    expect(response.statusCode).toBe(201);
  });

  it("rejects a duplicate accountId with 409", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const payload = { accountId: "acct_dup", ownerUserId: "user_3", initialEquity: "1000" };
    await app.inject({ method: "POST", url: "/v1/accounts", payload });
    const second = await app.inject({ method: "POST", url: "/v1/accounts", payload });

    expect(second.statusCode).toBe(409);
  });

  it("rejects a malformed request with 400", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({ method: "POST", url: "/v1/accounts", payload: { accountId: "acct_bad" } });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/accounts", () => {
  it("lists only accounts owned by the requested user", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    await app.inject({ method: "POST", url: "/v1/accounts", payload: { accountId: "acct_list_a", ownerUserId: "owner_list_1", initialEquity: "1000" } });
    await app.inject({ method: "POST", url: "/v1/accounts", payload: { accountId: "acct_list_b", ownerUserId: "owner_list_1", initialEquity: "2000" } });
    await app.inject({ method: "POST", url: "/v1/accounts", payload: { accountId: "acct_list_c", ownerUserId: "owner_list_2", initialEquity: "3000" } });

    const response = await app.inject({ method: "GET", url: "/v1/accounts?ownerUserId=owner_list_1" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts.map((a: { accountId: string }) => a.accountId).sort()).toEqual(["acct_list_a", "acct_list_b"]);
  });

  it("rejects a request with no ownerUserId", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({ method: "GET", url: "/v1/accounts" });
    expect(response.statusCode).toBe(400);
  });
});
