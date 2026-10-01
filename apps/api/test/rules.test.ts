import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType, type ClearinghouseState, type EvmGuardRuleSyncer, type EvmRuleSyncInput, type VenueStateReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

async function createAccountWithRule(app: ReturnType<typeof buildApp>, accountId: string) {
  await app.inject({
    method: "POST",
    url: "/v1/accounts",
    payload: {
      accountId,
      ownerUserId: "owner_rules",
      initialEquity: "10000",
      initialRules: [{ ruleType: RuleType.MAX_DAILY_LOSS, param: "500" }],
    },
  });
}

/** Records every syncRule/freezeForToday call instead of touching any real chain - lets tests assert exactly what would have been pushed on-chain. */
function fakeEvmGuardSyncer(calls: EvmRuleSyncInput[], shouldThrow = false, freezeCalls: string[] = []): EvmGuardRuleSyncer {
  return {
    syncRule: async (input) => {
      if (shouldThrow) throw new Error("rpc call failed");
      calls.push(input);
    },
    freezeForToday: async (safeAddress) => {
      freezeCalls.push(safeAddress);
    },
  };
}

async function createEvmSafeAccount(app: ReturnType<typeof buildApp>, accountId: string) {
  await app.inject({
    method: "POST",
    url: "/v1/accounts",
    payload: {
      accountId,
      ownerUserId: "owner_rules",
      venue: "bsc-pancakeswap",
      initialEquity: "10000",
      evmOwnerWalletAddress: "0xTRADERWALLET",
      evmChainId: 56,
    },
  });
}

describe("GET /v1/accounts/:accountId/rules", () => {
  it("lists the account's active rules", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_1");

    const response = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_1/rules" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].ruleType).toBe(RuleType.MAX_DAILY_LOSS);
    expect(body.rules[0].param).toBe("500");
    expect(body.rules[0].isActive).toBe(true);
  });
});

describe("POST /v1/accounts/:accountId/rules", () => {
  it("adds a new rule and it shows up in the list", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_2");

    const addResponse = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_rules_api_2/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "50000" },
    });

    expect(addResponse.statusCode).toBe(201);
    expect(addResponse.json().rule.ruleType).toBe(RuleType.MAX_POSITION_SIZE);

    const listResponse = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_2/rules" });
    expect(listResponse.json().rules).toHaveLength(2);
  });

  it("rejects a malformed request with 400", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_3");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_rules_api_3/rules",
      payload: { ruleType: "NOT_A_REAL_RULE_TYPE", param: "50000" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /v1/accounts/:accountId/rules/:ruleId/deactivate", () => {
  it("deactivates a rule so it no longer shows up in the active list", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_4");

    const listBefore = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_4/rules" });
    const ruleId = listBefore.json().rules[0].id;

    const deactivateResponse = await app.inject({
      method: "POST",
      url: `/v1/accounts/acct_rules_api_4/rules/${ruleId}/deactivate`,
    });

    expect(deactivateResponse.statusCode).toBe(200);
    expect(deactivateResponse.json()).toEqual({ ruleId, isActive: false });

    const listAfter = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_4/rules" });
    expect(listAfter.json().rules).toHaveLength(0);
  });
});

describe("POST /v1/accounts/:accountId/rules - EVM on-chain sync", () => {
  it("pushes a MAX_POSITION_SIZE rule to the configured syncer for the account's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    const calls: EvmRuleSyncInput[] = [];
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
      evmGuardSyncers: { 56: fakeEvmGuardSyncer(calls) },
    });
    await createEvmSafeAccount(app, "acct_sync_1");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_sync_1/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "500", tokenAddress: "0xUSDT" },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      safeAddress: "0xSAFE_BSC",
      ruleType: RuleType.MAX_POSITION_SIZE,
      tokenAddress: "0xUSDT",
    });
    expect(calls[0]!.param.toString()).toBe("500");
  });

  it("rejects a MAX_POSITION_SIZE rule missing tokenAddress on an EVM Safe account", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
    });
    await createEvmSafeAccount(app, "acct_sync_2");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_sync_2/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "500" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("does not require tokenAddress or call any syncer for a non-EVM (Hyperliquid) account", async () => {
    const store = new InMemoryRiskLedgerStore();
    const calls: EvmRuleSyncInput[] = [];
    const app = buildApp({ store, evmGuardSyncers: { 56: fakeEvmGuardSyncer(calls) } });
    await createAccountWithRule(app, "acct_sync_3");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_sync_3/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "500" },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it("skips syncing when no syncer is configured for the account's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
    });
    await createEvmSafeAccount(app, "acct_sync_4");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_sync_4/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "500", tokenAddress: "0xUSDT" },
    });

    expect(response.statusCode).toBe(201);
  });

  it("deactivates the rule and fails the request when the on-chain push fails", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
      evmGuardSyncers: { 56: fakeEvmGuardSyncer([], true) },
    });
    await createEvmSafeAccount(app, "acct_sync_5");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_sync_5/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "500", tokenAddress: "0xUSDT" },
    });

    expect(response.statusCode).toBe(500);

    const listResponse = await app.inject({ method: "GET", url: "/v1/accounts/acct_sync_5/rules" });
    expect(listResponse.json().rules).toHaveLength(0);
  });
});

describe("POST /v1/accounts/:accountId/rules - MAX_DAILY_LOSS freeze enforcement", () => {
  it("does not report a breach when a MAX_DAILY_LOSS rule is added to an account with no loss yet", async () => {
    const store = new InMemoryRiskLedgerStore();
    const freezeCalls: string[] = [];
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
      evmGuardSyncers: { 56: fakeEvmGuardSyncer([], false, freezeCalls) },
    });
    await createEvmSafeAccount(app, "acct_freeze_1");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_freeze_1/rules",
      payload: { ruleType: RuleType.MAX_DAILY_LOSS, param: "500" },
    });

    expect(response.statusCode).toBe(201);
    // Freshly created account has no loss yet - there is no "confirm unfrozen" call, since no
    // such call exists; not being breached just means nothing gets reported at all.
    expect(freezeCalls).toEqual([]);
  });

  it("does not touch freeze state when a non-MAX_DAILY_LOSS rule is added", async () => {
    const store = new InMemoryRiskLedgerStore();
    const freezeCalls: string[] = [];
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
      evmGuardSyncers: { 56: fakeEvmGuardSyncer([], false, freezeCalls) },
    });
    await createEvmSafeAccount(app, "acct_freeze_2");

    await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_freeze_2/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "500", tokenAddress: "0xUSDT" },
    });

    expect(freezeCalls).toEqual([]);
  });

  it("re-checks freeze state when a rule is deactivated (no breach, so no call)", async () => {
    const store = new InMemoryRiskLedgerStore();
    const freezeCalls: string[] = [];
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
      evmGuardSyncers: { 56: fakeEvmGuardSyncer([], false, freezeCalls) },
    });
    await createEvmSafeAccount(app, "acct_freeze_3");

    const addResponse = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_freeze_3/rules",
      payload: { ruleType: RuleType.MAX_DAILY_LOSS, param: "500" },
    });
    const ruleId = addResponse.json().rule.id;
    freezeCalls.length = 0;

    const deactivateResponse = await app.inject({
      method: "POST",
      url: `/v1/accounts/acct_freeze_3/rules/${ruleId}/deactivate`,
    });

    expect(deactivateResponse.statusCode).toBe(200);
    expect(freezeCalls).toEqual([]);
  });

  it("reports a breach to the Guard when the account's equity has already dropped below the new rule's budget", async () => {
    const store = new InMemoryRiskLedgerStore();
    const freezeCalls: string[] = [];
    const venueReader: VenueStateReader = {
      getClearinghouseState: async (): Promise<ClearinghouseState> => ({
        accountValue: new Decimal(9_000), // down from the 10,000 initialEquity
        totalMarginUsed: new Decimal(0),
        totalNotionalPosition: new Decimal(0),
        withdrawable: new Decimal(9_000),
        positions: [],
      }),
    };
    const app = buildApp({
      store,
      venueReader,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
      evmGuardSyncers: { 56: fakeEvmGuardSyncer([], false, freezeCalls) },
    });
    await createEvmSafeAccount(app, "acct_freeze_5");

    await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_freeze_5/reconcile",
      payload: { venueAddress: "0xanything" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_freeze_5/rules",
      payload: { ruleType: RuleType.MAX_DAILY_LOSS, param: "500" }, // already lost 1000, over the 500 budget
    });

    expect(response.statusCode).toBe(201);
    expect(freezeCalls).toEqual(["0xSAFE_BSC"]);
  });

  it("does not error when no syncer is configured for a MAX_DAILY_LOSS rule add", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({
      store,
      evmSafeProvisioners: { 56: { provisionSafe: async () => ({ safeAddress: "0xSAFE_BSC", chainId: 56 }) } },
    });
    await createEvmSafeAccount(app, "acct_freeze_4");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_freeze_4/rules",
      payload: { ruleType: RuleType.MAX_DAILY_LOSS, param: "500" },
    });

    expect(response.statusCode).toBe(201);
  });
});
