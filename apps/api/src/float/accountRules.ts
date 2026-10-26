import { RuleType, type RiskLedgerStore } from "@mypropguard/domain";

/**
 * The account's own MyPropGuard rules that also bind the wallet's buys: how many trades a day and the pause between
 * trades. (The loss and size rules need the value of what the wallet holds; they are not applied here yet.)
 * When a rule of one type exists more than once, the most recently created one is the current limit.
 */
export async function loadWalletAccountRules(
  store: Pick<RiskLedgerStore, "runExclusive">,
  accountId: string,
): Promise<{ maxTradesPerDay?: number; cooldownSec?: number }> {
  const rules = await store.runExclusive(accountId, (ctx) => ctx.getActiveRules(accountId));
  const current = (type: string) =>
    rules
      .filter((r) => r.ruleType === type && r.isActive)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  const out: { maxTradesPerDay?: number; cooldownSec?: number } = {};
  const frequency = current(RuleType.MAX_TRADE_FREQUENCY);
  if (frequency) out.maxTradesPerDay = Math.max(0, Math.floor(frequency.param.toNumber()));
  const cooldown = current(RuleType.COOLDOWN);
  if (cooldown) out.cooldownSec = Math.max(0, Math.floor(cooldown.param.toNumber()));
  return out;
}
