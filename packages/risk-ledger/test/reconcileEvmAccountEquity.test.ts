import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType, type EvmGuardRuleSyncer, type EvmSafeEquityReader, type ProtectedAccount } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { EvmAccountNotFoundError, reconcileEvmAccountEquity } from "../src/reconcileEvmAccountEquity.js";

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

function fakeEquityReader(equityUsd: Decimal, calls: { safeAddress: string; trackedTokens: readonly string[] }[]): EvmSafeEquityReader {
  return {
    getEquityUsd: async (query) => {
      calls.push(query);
      return equityUsd;
    },
  };
}

function fakeGuardSyncer(freezeCalls: string[]): EvmGuardRuleSyncer {
  return {
    syncRule: async () => {},
    freezeForToday: async (safeAddress) => {
      freezeCalls.push(safeAddress);
    },
  };
}

describe("reconcileEvmAccountEquity", () => {
  it("reads live equity and folds it into the account's AccountRiskHead", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_evm_1", equityStartOfDay: new Decimal(1000), currentEquity: new Decimal(1000), peakEquity: new Decimal(1000) }),
    );
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 500, { accountId: "acct_evm_1", tokenAddress: "0xUSDT" })]);

    const calls: { safeAddress: string; trackedTokens: readonly string[] }[] = [];
    const head = await reconcileEvmAccountEquity(
      store,
      { 56: fakeEquityReader(new Decimal(1500), calls) },
      undefined,
      "acct_evm_1",
    );

    expect(head.currentEquity.toString()).toBe("1500");
    expect(head.peakEquity.toString()).toBe("1500");
    expect(calls).toEqual([{ safeAddress: "0xSAFE", trackedTokens: ["0xUSDT"] }]);
  });

  it("passes only distinct MAX_POSITION_SIZE token addresses as trackedTokens", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_evm_1" }));
    store.seedRules("acct_evm_1", [
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 500, { accountId: "acct_evm_1", tokenAddress: "0xUSDT", id: "r1" }),
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 300, { accountId: "acct_evm_1", tokenAddress: "0xUSDT", id: "r2" }),
      buildRuleVersion(RuleType.MAX_TRADE_FREQUENCY, 10, { accountId: "acct_evm_1", id: "r3" }),
      buildRuleVersion(RuleType.MAX_DAILY_LOSS, 100, { accountId: "acct_evm_1", id: "r4" }),
    ]);

    const calls: { safeAddress: string; trackedTokens: readonly string[] }[] = [];
    await reconcileEvmAccountEquity(store, { 56: fakeEquityReader(new Decimal(0), calls) }, undefined, "acct_evm_1");

    expect(calls[0]!.trackedTokens).toEqual(["0xUSDT"]);
  });

  it("re-checks the max-daily-loss freeze state after updating equity", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_evm_1", equityStartOfDay: new Decimal(1000), currentEquity: new Decimal(1000) }),
    );
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 100, { accountId: "acct_evm_1" })]);

    const freezeCalls: string[] = [];
    await reconcileEvmAccountEquity(
      store,
      { 56: fakeEquityReader(new Decimal(850), []) }, // lost 150, over the 100 budget
      { 56: fakeGuardSyncer(freezeCalls) },
      "acct_evm_1",
    );

    expect(freezeCalls).toEqual(["0xSAFE"]);
  });

  it("throws EvmAccountNotFoundError for a non-EVM account", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount({ accountId: "acct_hl", evmSafeAddress: null, evmChainId: null }));
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_hl" }));

    await expect(reconcileEvmAccountEquity(store, { 56: fakeEquityReader(new Decimal(0), []) }, undefined, "acct_hl")).rejects.toThrow(
      EvmAccountNotFoundError,
    );
  });

  it("throws EvmAccountNotFoundError when no equity reader is configured for the account's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_evm_1" }));

    await expect(reconcileEvmAccountEquity(store, { 1: fakeEquityReader(new Decimal(0), []) }, undefined, "acct_evm_1")).rejects.toThrow(
      EvmAccountNotFoundError,
    );
  });
});
