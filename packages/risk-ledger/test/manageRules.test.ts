import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { addRule, deactivateRule, listRules, supersedePreviousRules } from "../src/manageRules.js";

describe("manageRules", () => {
  it("listRules returns only active rules", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_rules_1" }));
    store.seedRules("acct_rules_1", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000)]);

    const rules = await listRules(store, "acct_rules_1");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.ruleType).toBe(RuleType.MAX_POSITION_SIZE);
  });

  it("addRule appends a new active rule without touching existing ones", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_rules_2" }));
    store.seedRules("acct_rules_2", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000)]);

    const added = await addRule(store, "acct_rules_2", RuleType.MAX_DAILY_LOSS, new Decimal(500));
    expect(added.ruleType).toBe(RuleType.MAX_DAILY_LOSS);
    expect(added.isActive).toBe(true);

    const rules = await listRules(store, "acct_rules_2");
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.ruleType).sort()).toEqual([RuleType.MAX_DAILY_LOSS, RuleType.MAX_POSITION_SIZE].sort());
  });

  it("addRule stores tokenAddress for a per-token EVM rule", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_rules_token" }));

    const added = await addRule(store, "acct_rules_token", RuleType.MAX_POSITION_SIZE, new Decimal(500), "0xUSDT");
    expect(added.tokenAddress).toBe("0xUSDT");

    const rules = await listRules(store, "acct_rules_token");
    expect(rules[0]!.tokenAddress).toBe("0xUSDT");
  });

  it("deactivateRule removes a rule from listRules without affecting others", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_rules_3" }));
    const rule = buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000, { id: "rule_to_remove", accountId: "acct_rules_3" });
    const keep = buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500, { id: "rule_to_keep", accountId: "acct_rules_3" });
    store.seedRules("acct_rules_3", [rule, keep]);

    await deactivateRule(store, "acct_rules_3", "rule_to_remove");

    const rules = await listRules(store, "acct_rules_3");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe("rule_to_keep");
  });

  it("deactivateRule is a no-op for an unknown rule id", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_rules_4" }));
    store.seedRules("acct_rules_4", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1_000)]);

    await expect(deactivateRule(store, "acct_rules_4", "does_not_exist")).resolves.not.toThrow();
    expect(await listRules(store, "acct_rules_4")).toHaveLength(1);
  });
});

describe("supersedePreviousRules", () => {
  async function setup() {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_supersede" }));
    return store;
  }

  it("makes a changed limit replace the old one of the same kind, and leaves other kinds alone", async () => {
    const store = await setup();
    store.seedRules("acct_supersede", [
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 10, { accountId: "acct_supersede" }),
      buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500, { accountId: "acct_supersede" }),
    ]);
    const changed = await addRule(store, "acct_supersede", RuleType.MAX_POSITION_SIZE, new Decimal(20));

    expect(await supersedePreviousRules(store, "acct_supersede", changed)).toBe(1);

    const active = await listRules(store, "acct_supersede");
    expect(active.map((r) => [r.ruleType, r.param.toString()]).sort()).toEqual([
      [RuleType.MAX_DAILY_LOSS, "500"],
      [RuleType.MAX_POSITION_SIZE, "20"],
    ]);
  });

  it("treats per-token rules separately: a new limit for one token does not replace another token's", async () => {
    const store = await setup();
    const bnb = "0x0000000000000000000000000000000000000000";
    const cake = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
    store.seedRules("acct_supersede", [
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 1, { accountId: "acct_supersede", tokenAddress: bnb }),
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 5, { accountId: "acct_supersede", tokenAddress: cake }),
    ]);
    const changed = await addRule(store, "acct_supersede", RuleType.MAX_POSITION_SIZE, new Decimal(2), bnb.toUpperCase().replace("0X", "0x"));

    await supersedePreviousRules(store, "acct_supersede", changed);

    const active = await listRules(store, "acct_supersede");
    expect(active.map((r) => r.param.toString()).sort()).toEqual(["2", "5"]);
  });

  it("does nothing when there is nothing older", async () => {
    const store = await setup();
    const only = await addRule(store, "acct_supersede", RuleType.MAX_LEVERAGE, new Decimal(3));
    expect(await supersedePreviousRules(store, "acct_supersede", only)).toBe(0);
    expect(await listRules(store, "acct_supersede")).toHaveLength(1);
  });
});
