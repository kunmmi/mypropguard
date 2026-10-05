import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType, type EvmSafeEquityReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { reconcileAllEvmAccountsWithDailyLossRule } from "../src/reconcileAllEvmAccountsWithDailyLossRule.js";

function fakeEquityReader(equityByAddress: Record<string, Decimal>, calls: string[]): EvmSafeEquityReader {
  return {
    getTokenValueUsd: async () => new Decimal(0),
    getEquityUsd: async (query) => {
      calls.push(query.safeAddress);
      return equityByAddress[query.safeAddress] ?? new Decimal(0);
    },
  };
}

async function createEvmAccountWithDailyLossRule(
  store: InMemoryRiskLedgerStore,
  accountId: string,
  safeAddress: string,
  chainId: number,
) {
  await store.createAccount({
    accountId,
    ownerUserId: "owner_1",
    venue: "bsc-pancakeswap",
    initialEquity: new Decimal(1_000),
    initialRules: [{ ruleType: RuleType.MAX_DAILY_LOSS, param: new Decimal(100) }],
    evmOwnerWalletAddress: "0xTRADER",
    evmSafeAddress: safeAddress,
    evmChainId: chainId,
  });
}

describe("reconcileAllEvmAccountsWithDailyLossRule", () => {
  it("reconciles every EVM account that has an active MAX_DAILY_LOSS rule", async () => {
    const store = new InMemoryRiskLedgerStore();
    await createEvmAccountWithDailyLossRule(store, "acct_1", "0xSAFE_1", 56);
    await createEvmAccountWithDailyLossRule(store, "acct_2", "0xSAFE_2", 56);
    await store.createAccount({
      accountId: "acct_no_rule",
      ownerUserId: "owner_1",
      venue: "bsc-pancakeswap",
      initialEquity: new Decimal(1_000),
      initialRules: [],
      evmOwnerWalletAddress: "0xTRADER",
      evmSafeAddress: "0xSAFE_3",
      evmChainId: 56,
    });

    const calls: string[] = [];
    const results = await reconcileAllEvmAccountsWithDailyLossRule(
      store,
      { 56: fakeEquityReader({ "0xSAFE_1": new Decimal(900), "0xSAFE_2": new Decimal(800) }, calls) },
      undefined,
    );

    expect(calls.sort()).toEqual(["0xSAFE_1", "0xSAFE_2"]);
    expect(results.map((r) => r.accountId).sort()).toEqual(["acct_1", "acct_2"]);
    expect(results.every((r) => !r.error)).toBe(true);
  });

  it("skips accounts on a chain with no configured equity reader", async () => {
    const store = new InMemoryRiskLedgerStore();
    await createEvmAccountWithDailyLossRule(store, "acct_eth", "0xSAFE_ETH", 1);

    const calls: string[] = [];
    const results = await reconcileAllEvmAccountsWithDailyLossRule(store, { 56: fakeEquityReader({}, calls) }, undefined);

    expect(calls).toEqual([]);
    expect(results).toEqual([]);
  });

  it("returns an empty list immediately when no equity readers are configured at all", async () => {
    const store = new InMemoryRiskLedgerStore();
    await createEvmAccountWithDailyLossRule(store, "acct_1", "0xSAFE_1", 56);

    const results = await reconcileAllEvmAccountsWithDailyLossRule(store, undefined, undefined);

    expect(results).toEqual([]);
  });

  it("reports one account's failure without stopping the rest", async () => {
    const store = new InMemoryRiskLedgerStore();
    await createEvmAccountWithDailyLossRule(store, "acct_ok", "0xSAFE_OK", 56);
    await createEvmAccountWithDailyLossRule(store, "acct_fail", "0xSAFE_FAIL", 56);

    const reader: EvmSafeEquityReader = {
      getTokenValueUsd: async () => new Decimal(0),
      getEquityUsd: async (query) => {
        if (query.safeAddress === "0xSAFE_FAIL") throw new Error("rpc error");
        return new Decimal(900);
      },
    };

    const results = await reconcileAllEvmAccountsWithDailyLossRule(store, { 56: reader }, undefined);

    const ok = results.find((r) => r.accountId === "acct_ok");
    const failed = results.find((r) => r.accountId === "acct_fail");
    expect(ok?.error).toBeUndefined();
    expect(failed?.error).toBeInstanceOf(Error);
  });
});
