import { checkValueRules, hasValueRules, type FloatValueRules } from "@mypropguard/evm";
import type { SolanaRefusalCode, SolanaValuer } from "@mypropguard/solana";
import type { SolanaStore } from "./solanaStore.js";

type Ok = { ok: true; kind: "buy" | "sell"; mint: string; spendLamports: bigint; tokenAmount: bigint; minSolOut: bigint; summary: string };

export interface SolanaRiskGuardDeps {
  store: Pick<SolanaStore, "knownMints" | "mintFlows" | "getRiskState" | "saveRiskState">;
  valuer: Pick<SolanaValuer, "holdings" | "quoteBuy" | "quoteSell" | "balanceOf" | "decimals">;
  /** What one SOL is worth in US dollars right now. */
  usdPerSol(): Promise<number>;
  now?: () => number;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Enforces the account's loss, drawdown, size and exposure rules on the Solana wallet's buys. The same rules and the same
 * accounting as the BNB Chain wallet (see apps/api/src/float/floatRiskGuard.ts), in lamports.
 *
 * What the wallet is worth comes from live quotes. Its trading result is worked out from what each coin cost and what it
 * returned plus what is held now, so a deposit or a withdrawal is never mistaken for a gain or a loss.
 *
 * Does nothing, and asks the network nothing, when the account has no such rule. Selling is never judged here.
 */
export class SolanaRiskGuard {
  constructor(private readonly deps: SolanaRiskGuardDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async checkBuy(wallet: { accountId: string; address: string }, rules: FloatValueRules, decision: Ok): Promise<{ code: SolanaRefusalCode; message: string } | null> {
    if (!hasValueRules(rules)) return null;
    const { store, valuer } = this.deps;
    const mint = decision.mint;
    const tokenLimit = rules.tokenLimits?.[mint.toLowerCase()];
    const needsUsd = rules.maxDailyLossUsd !== undefined || rules.maxExposureUsd !== undefined;

    const known = await store.knownMints(wallet.accountId);
    const mints = known.includes(mint) ? known : [...known, mint];

    const [holdings, flows, state, usdPerSol, projected] = await Promise.all([
      valuer.holdings(wallet.address, mints),
      store.mintFlows(wallet.accountId),
      store.getRiskState(wallet.accountId),
      needsUsd ? this.deps.usdPerSol() : Promise.resolve(0),
      tokenLimit !== undefined ? this.projectedTokens(wallet.address, decision) : Promise.resolve(undefined),
    ]);

    // Trading result so far: for each coin, what it is worth now plus what it returned, less what it cost.
    const flowOf = new Map(flows.map((f) => [f.mint, f]));
    let pnlNow = 0n;
    for (const p of holdings.positions) {
      const f = flowOf.get(p.mint);
      pnlNow += p.valueLamports + (f?.proceedsLamports ?? 0n) - (f?.costLamports ?? 0n);
      flowOf.delete(p.mint);
    }
    for (const f of flowOf.values()) pnlNow += f.proceedsLamports - f.costLamports; // coins no longer held

    const today = utcDay(this.now());
    const dayStartPnl = state.day === today ? state.dayStartPnlLamports : pnlNow;
    const peak = holdings.equityLamports > state.peakEquityLamports ? holdings.equityLamports : state.peakEquityLamports;
    if (state.day !== today || peak !== state.peakEquityLamports) {
      await store.saveRiskState(wallet.accountId, { day: today, dayStartPnlLamports: dayStartPnl, peakEquityLamports: peak });
    }

    return checkValueRules({
      rules,
      decimals: 9,
      usdPerBnb: usdPerSol,
      buy: { spendWei: decision.spendLamports, token: mint as never, projectedTokens: projected },
      holdings: { equityWei: holdings.equityLamports, positionsWei: holdings.positionsLamports },
      pnlTodayWei: pnlNow - dayStartPnl,
      peakEquityWei: peak,
    });
  }

  /** What a sell should return in SOL, for the books. Null when it cannot be worked out. */
  async valueSell(decision: Ok): Promise<bigint | null> {
    if (decision.kind !== "sell" || decision.tokenAmount === 0n) return null;
    return this.deps.valuer.quoteSell(decision.mint, decision.tokenAmount);
  }

  /** Whole tokens the wallet would hold of the coin after this buy. */
  private async projectedTokens(wallet: string, decision: Ok): Promise<number> {
    const { valuer } = this.deps;
    const [decimals, held, quoted] = await Promise.all([valuer.decimals(decision.mint), valuer.balanceOf(decision.mint, wallet), valuer.quoteBuy(decision.mint, decision.spendLamports)]);
    const bought = quoted > 0n ? quoted : decision.tokenAmount;
    return Number(held + bought) / 10 ** decimals;
  }
}
