import { formatUnits, type Address } from "viem";
import { checkValueRules, hasValueRules, type FloatDecision, type FloatRefusalCode, type FloatValueRules, type FloatValuer } from "@mypropguard/evm";
import type { FloatStore } from "./floatStore.js";

export interface FloatRiskGuardDeps {
  store: Pick<FloatStore, "knownTokens" | "tokenFlows" | "getRiskState" | "saveRiskState">;
  valuer: Pick<FloatValuer, "holdings" | "quoteBuy" | "quoteSell" | "decimals" | "balanceOf">;
  /** What one BNB is worth in US dollars right now. */
  usdPerBnb(): Promise<number>;
  now?: () => number;
}

type Ok = Extract<FloatDecision, { ok: true }>;

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Enforces the account's loss, drawdown, size and exposure rules on the trading wallet's buys.
 *
 * What the wallet is worth comes from live market quotes (four.meme's own sell quote, or PancakeSwap once a token has
 * moved there). Its trading result is worked out from what each token cost and what it returned plus what is held now,
 * so a deposit or a withdrawal is never mistaken for a gain or a loss.
 *
 * Does nothing, and asks the chain nothing, when the account has no such rule: a plain account pays no extra delay.
 * Selling is never judged here.
 */
export class FloatRiskGuard {
  constructor(private readonly deps: FloatRiskGuardDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async checkBuy(
    wallet: { accountId: string; address: Address },
    rules: FloatValueRules,
    decision: Ok,
  ): Promise<{ code: FloatRefusalCode; message: string } | null> {
    if (!hasValueRules(rules)) return null;
    const { store, valuer } = this.deps;
    const token = decision.token;
    const tokenLimit = token ? rules.tokenLimits?.[token.toLowerCase()] : undefined;
    const needsUsd = rules.maxDailyLossUsd !== undefined || rules.maxExposureUsd !== undefined;

    const known = await store.knownTokens(wallet.accountId);
    const tokens = token && !known.some((t) => t.toLowerCase() === token.toLowerCase()) ? [...known, token] : known;

    const [holdings, flows, state, usdPerBnb, projected] = await Promise.all([
      valuer.holdings(wallet.address, tokens),
      store.tokenFlows(wallet.accountId),
      store.getRiskState(wallet.accountId),
      needsUsd ? this.deps.usdPerBnb() : Promise.resolve(0),
      token && tokenLimit !== undefined ? this.projectedTokens(wallet.address, token, decision.spendWei) : Promise.resolve(undefined),
    ]);

    // Trading result so far: for each token, what it is worth now plus what it returned, less what it cost.
    const flowOf = new Map(flows.map((f) => [f.token.toLowerCase(), f]));
    let pnlNow = 0n;
    for (const p of holdings.positions) {
      const f = flowOf.get(p.token.toLowerCase());
      pnlNow += p.valueWei + (f?.proceedsWei ?? 0n) - (f?.costWei ?? 0n);
      flowOf.delete(p.token.toLowerCase());
    }
    for (const f of flowOf.values()) pnlNow += f.proceedsWei - f.costWei; // tokens no longer held

    const today = utcDay(this.now());
    const dayStartPnl = state.day === today ? state.dayStartPnlWei : pnlNow;
    const peak = holdings.equityWei > state.peakEquityWei ? holdings.equityWei : state.peakEquityWei;
    if (state.day !== today || peak !== state.peakEquityWei) {
      await store.saveRiskState(wallet.accountId, { day: today, dayStartPnlWei: dayStartPnl, peakEquityWei: peak });
    }

    return checkValueRules({
      rules,
      usdPerBnb,
      buy: { spendWei: decision.spendWei, token, projectedTokens: projected },
      holdings: { equityWei: holdings.equityWei, positionsWei: holdings.positionsWei },
      pnlTodayWei: pnlNow - dayStartPnl,
      peakEquityWei: peak,
    });
  }

  /** What a sell should return in BNB, for the books. Null when it cannot be worked out. */
  async valueSell(decision: Ok): Promise<bigint | null> {
    if (decision.kind !== "sell" || !decision.token || decision.sellAmount === undefined) return null;
    return this.deps.valuer.quoteSell(decision.token, decision.sellAmount);
  }

  /** Whole tokens the wallet would hold of `token` after spending `spendWei` on it. */
  private async projectedTokens(wallet: Address, token: Address, spendWei: bigint): Promise<number> {
    const { valuer } = this.deps;
    const [decimals, held, bought] = await Promise.all([
      valuer.decimals(token),
      valuer.balanceOf(token, wallet),
      valuer.quoteBuy(token, spendWei),
    ]);
    return Number(formatUnits(held + bought, decimals));
  }
}
