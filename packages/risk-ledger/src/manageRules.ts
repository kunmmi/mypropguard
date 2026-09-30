import type { Decimal } from "decimal.js";
import type { RiskLedgerStore, RuleType, RuleVersion } from "@mypropguard/domain";

/** Active rules for one account. Runs inside the account's lock, same as any other LedgerContext read. */
export async function listRules(store: RiskLedgerStore, accountId: string): Promise<readonly RuleVersion[]> {
  return store.runExclusive(accountId, (ctx) => ctx.getActiveRules(accountId));
}

/** Adds a new rule to an account's active mandate. */
export async function addRule(store: RiskLedgerStore, accountId: string, ruleType: RuleType, param: Decimal): Promise<RuleVersion> {
  return store.runExclusive(accountId, (ctx) => ctx.insertRule(accountId, { ruleType, param }));
}

/** Deactivates a rule so it no longer applies to future risk decisions. */
export async function deactivateRule(store: RiskLedgerStore, accountId: string, ruleId: string): Promise<void> {
  await store.runExclusive(accountId, (ctx) => ctx.deactivateRule(ruleId));
}
