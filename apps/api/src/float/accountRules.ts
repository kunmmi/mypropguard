import { RuleType, type RiskLedgerStore } from "@mypropguard/domain";
import type { FloatValueRules } from "@mypropguard/evm";

export interface WalletAccountRules {
  /** Trades a day (the account's trade-frequency rule). */
  maxTradesPerDay?: number;
  /** Seconds between trades (the account's cooldown rule). */
  cooldownSec?: number;
  /** The rules that depend on what the wallet is worth. */
  value: FloatValueRules;
}

/**
 * The account's own MyPropGuard rules that also bind the wallet's buys.
 * When a rule of one type exists more than once, the most recently created one is the current limit; a token-size rule
 * is current per token.
 */
export async function loadWalletAccountRules(store: Pick<RiskLedgerStore, "runExclusive">, accountId: string): Promise<WalletAccountRules> {
  const rules = await store.runExclusive(accountId, (ctx) => ctx.getActiveRules(accountId));
  const newestFirst = rules.filter((r) => r.isActive).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  const current = (type: string) => newestFirst.find((r) => r.ruleType === type);
  const num = (r: { param: { toNumber(): number } } | undefined): number | undefined => (r ? r.param.toNumber() : undefined);

  const out: WalletAccountRules = { value: {} };
  const frequency = num(current(RuleType.MAX_TRADE_FREQUENCY));
  if (frequency !== undefined) out.maxTradesPerDay = Math.max(0, Math.floor(frequency));
  const cooldown = num(current(RuleType.COOLDOWN));
  if (cooldown !== undefined) out.cooldownSec = Math.max(0, Math.floor(cooldown));

  const dailyLoss = num(current(RuleType.MAX_DAILY_LOSS));
  if (dailyLoss !== undefined) out.value.maxDailyLossUsd = dailyLoss;
  const drawdown = num(current(RuleType.MAX_DRAWDOWN));
  if (drawdown !== undefined) out.value.maxDrawdown = drawdown;
  const exposure = num(current(RuleType.MAX_EXPOSURE));
  if (exposure !== undefined) out.value.maxExposureUsd = exposure;

  const tokenLimits: Record<string, number> = {};
  for (const rule of newestFirst) {
    const token = rule.ruleType === RuleType.MAX_POSITION_SIZE ? rule.tokenAddress?.toLowerCase() : undefined;
    if (token && tokenLimits[token] === undefined) tokenLimits[token] = rule.param.toNumber();
  }
  if (Object.keys(tokenLimits).length > 0) out.value.tokenLimits = tokenLimits;
  return out;
}
