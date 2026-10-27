/** The account rules that bind a wallet, in plain words. Shared by the BNB Chain and Solana wallet cards. */
export interface AccountRulesView {
  maxTradesPerDay?: number;
  cooldownSec?: number;
  value: { maxDailyLossUsd?: number; maxDrawdown?: number; maxExposureUsd?: number; tokenLimits?: Record<string, number> };
}

export function accountRuleLines(rules: AccountRulesView | undefined): string[] {
  if (!rules) return [];
  const usd = (n: number) => `$${n.toLocaleString()}`;
  const lines: string[] = [];
  if (rules.maxTradesPerDay !== undefined) lines.push(`At most ${rules.maxTradesPerDay} trades a day`);
  if (rules.cooldownSec !== undefined) lines.push(`${rules.cooldownSec} seconds between trades`);
  if (rules.value.maxDailyLossUsd !== undefined) lines.push(`Buying pauses for the day if you lose ${usd(rules.value.maxDailyLossUsd)}`);
  if (rules.value.maxDrawdown !== undefined) lines.push(`Buying pauses if the wallet falls ${Math.round(rules.value.maxDrawdown * 1000) / 10}% from its highest value`);
  if (rules.value.maxExposureUsd !== undefined) lines.push(`No more than ${usd(rules.value.maxExposureUsd)} in open positions`);
  const sized = Object.keys(rules.value.tokenLimits ?? {}).length;
  if (sized > 0) lines.push(`A size limit on ${sized} token${sized === 1 ? "" : "s"}`);
  return lines;
}
