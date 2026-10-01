import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { addRule, deactivateRule } from "../src/manageRules.js";

describe("RiskLedgerStore.listAccountsWithActiveRuleType", () => {
  it("returns only accounts with an active rule of the given type, across all owners", async () => {
    const store = new InMemoryRiskLedgerStore();
    await store.createAccount({
      accountId: "acct_with_loss_rule",
      ownerUserId: "owner_1",
      venue: "bsc-pancakeswap",
      initialEquity: new Decimal(1_000),
      initialRules: [{ ruleType: RuleType.MAX_DAILY_LOSS, param: new Decimal(100) }],
    });
    await store.createAccount({
      accountId: "acct_without_loss_rule",
      ownerUserId: "owner_2",
      venue: "bsc-pancakeswap",
      initialEquity: new Decimal(1_000),
      initialRules: [{ ruleType: RuleType.MAX_POSITION_SIZE, param: new Decimal(500) }],
    });

    const result = await store.listAccountsWithActiveRuleType(RuleType.MAX_DAILY_LOSS);

    expect(result.map((a) => a.accountId)).toEqual(["acct_with_loss_rule"]);
  });

  it("excludes an account whose MAX_DAILY_LOSS rule has been deactivated", async () => {
    const store = new InMemoryRiskLedgerStore();
    await store.createAccount({
      accountId: "acct_deactivated",
      ownerUserId: "owner_1",
      venue: "bsc-pancakeswap",
      initialEquity: new Decimal(1_000),
      initialRules: [],
    });
    const rule = await addRule(store, "acct_deactivated", RuleType.MAX_DAILY_LOSS, new Decimal(100));
    await deactivateRule(store, "acct_deactivated", rule.id);

    const result = await store.listAccountsWithActiveRuleType(RuleType.MAX_DAILY_LOSS);

    expect(result).toEqual([]);
  });

  it("returns an empty list when no accounts have the rule type", async () => {
    const store = new InMemoryRiskLedgerStore();
    await store.createAccount({
      accountId: "acct_1",
      ownerUserId: "owner_1",
      venue: "hyperliquid",
      initialEquity: new Decimal(1_000),
      initialRules: [],
    });

    expect(await store.listAccountsWithActiveRuleType(RuleType.MAX_DAILY_LOSS)).toEqual([]);
  });
});
