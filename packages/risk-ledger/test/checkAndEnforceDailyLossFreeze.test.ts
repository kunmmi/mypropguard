import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType, type EvmGuardRuleSyncer, type ProtectedAccount } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { checkAndEnforceDailyLossFreeze } from "../src/checkAndEnforceDailyLossFreeze.js";

function evmAccount(overrides: Partial<ProtectedAccount> = {}): ProtectedAccount {
  return {
    accountId: "acct_evm_1",
    ownerUserId: "owner_1",
    venue: "bsc-pancakeswap",
    protectionEnabled: false,
    createdAt: new Date(),
    agentWalletId: null,
    agentWalletAddress: null,
    evmOwnerWalletAddress: "0xTRADER",
    evmSafeAddress: "0xSAFE",
    evmChainId: 56,
    ...overrides,
  };
}

function fakeSyncer(freezeCalls: string[]): EvmGuardRuleSyncer {
  return {
    syncRule: async () => {},
    freezeForToday: async (safeAddress) => {
      freezeCalls.push(safeAddress);
    },
  };
}

describe("checkAndEnforceDailyLossFreeze", () => {
  it("freezes the account's Guard when today's loss meets or exceeds the MAX_DAILY_LOSS rule", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_evm_1", equityStartOfDay: new Decimal(10_000), currentEquity: new Decimal(9_400) }),
    );
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500, { accountId: "acct_evm_1" })]);

    const freezeCalls: string[] = [];
    await checkAndEnforceDailyLossFreeze(store, "acct_evm_1", { 56: fakeSyncer(freezeCalls) });

    expect(freezeCalls).toEqual(["0xSAFE"]);
  });

  it("does not call freezeForToday when today's loss is within the MAX_DAILY_LOSS rule", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_evm_1", equityStartOfDay: new Decimal(10_000), currentEquity: new Decimal(9_800) }),
    );
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500, { accountId: "acct_evm_1" })]);

    const freezeCalls: string[] = [];
    await checkAndEnforceDailyLossFreeze(store, "acct_evm_1", { 56: fakeSyncer(freezeCalls) });

    // No "unfreeze" call exists - not being breached just means nothing is reported at all.
    expect(freezeCalls).toEqual([]);
  });

  it("does not call freezeForToday when there is no active MAX_DAILY_LOSS rule at all", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_evm_1", equityStartOfDay: new Decimal(10_000), currentEquity: new Decimal(1_000) }),
    );
    store.seedRules("acct_evm_1", []);

    const freezeCalls: string[] = [];
    await checkAndEnforceDailyLossFreeze(store, "acct_evm_1", { 56: fakeSyncer(freezeCalls) });

    expect(freezeCalls).toEqual([]);
  });

  it("does nothing for a non-EVM (Hyperliquid) account", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount({ accountId: "acct_hl_1", evmSafeAddress: null, evmChainId: null, venue: "hyperliquid" }));
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_hl_1" }));
    store.seedRules("acct_hl_1", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500, { accountId: "acct_hl_1" })]);

    const freezeCalls: string[] = [];
    await checkAndEnforceDailyLossFreeze(store, "acct_hl_1", { 56: fakeSyncer(freezeCalls) });

    expect(freezeCalls).toEqual([]);
  });

  it("does nothing when no syncer is configured for the account's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_evm_1", equityStartOfDay: new Decimal(10_000), currentEquity: new Decimal(9_000) }),
    );
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500, { accountId: "acct_evm_1" })]);

    const freezeCalls: string[] = [];
    await checkAndEnforceDailyLossFreeze(store, "acct_evm_1", { 1: fakeSyncer(freezeCalls) });

    expect(freezeCalls).toEqual([]);
  });

  it("does nothing when evmGuardSyncers is undefined entirely", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_evm_1" }));
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500, { accountId: "acct_evm_1" })]);

    await expect(checkAndEnforceDailyLossFreeze(store, "acct_evm_1", undefined)).resolves.not.toThrow();
  });
});
