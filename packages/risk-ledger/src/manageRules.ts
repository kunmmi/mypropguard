import type { Decimal } from "decimal.js";
import type { RiskLedgerStore, RuleType, RuleVersion } from "@mypropguard/domain";

/** Active rules for one account. Runs inside the account's lock, same as any other LedgerContext read. */
export async function listRules(store: RiskLedgerStore, accountId: string): Promise<readonly RuleVersion[]> {
  return store.runExclusive(accountId, (ctx) => ctx.getActiveRules(accountId));
}

/** Adds a new rule to an account's active mandate. */
export async function addRule(
  store: RiskLedgerStore,
  accountId: string,
  ruleType: RuleType,
  param: Decimal,
  tokenAddress?: string | null,
): Promise<RuleVersion> {
  return store.runExclusive(accountId, (ctx) => ctx.insertRule(accountId, { ruleType, param, tokenAddress }));
}

/**
 * Makes `kept` the only active rule of its kind: deactivates every other active rule with the same type (and, for
 * per-token rules, the same token). Changing a limit means adding a new rule, and the old one must stop applying;
 * left active it would keep being enforced next to the new one, which looks like the change did not take.
 * The deactivated rows stay in the table as history. Returns how many rules were replaced.
 */
export async function supersedePreviousRules(store: RiskLedgerStore, accountId: string, kept: RuleVersion): Promise<number> {
  const token = (value: string | null | undefined) => (value ? value.toLowerCase() : null);
  return store.runExclusive(accountId, async (ctx) => {
    const older = (await ctx.getActiveRules(accountId)).filter(
      (rule) => rule.id !== kept.id && rule.ruleType === kept.ruleType && token(rule.tokenAddress) === token(kept.tokenAddress),
    );
    for (const rule of older) await ctx.deactivateRule(rule.id);
    return older.length;
  });
}

/** Deactivates a rule so it no longer applies to future risk decisions. */
export async function deactivateRule(store: RiskLedgerStore, accountId: string, ruleId: string): Promise<void> {
  await store.runExclusive(accountId, (ctx) => ctx.deactivateRule(ruleId));
}
