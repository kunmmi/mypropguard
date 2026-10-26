import { formatEther, type Address } from "viem";
import type { FloatRefusalCode } from "./floatPolicy.js";

/** The account's MyPropGuard rules that depend on what the wallet is worth. Amounts are in US dollars. */
export interface FloatValueRules {
  /** Most the wallet may lose in a UTC day before buying stops. */
  maxDailyLossUsd?: number;
  /** Fall from the wallet's highest value, as a fraction (0.2 = 20%), at which buying stops. */
  maxDrawdown?: number;
  /** Most the open positions may be worth in total after a buy. */
  maxExposureUsd?: number;
  /** Most of one token the wallet may hold, in whole tokens, keyed by lower-case token address. */
  tokenLimits?: Record<string, number>;
}

export const hasValueRules = (r: FloatValueRules): boolean =>
  r.maxDailyLossUsd !== undefined || r.maxDrawdown !== undefined || r.maxExposureUsd !== undefined || Object.keys(r.tokenLimits ?? {}).length > 0;

export interface FloatRiskInput {
  rules: FloatValueRules;
  usdPerBnb: number;
  buy: {
    spendWei: bigint;
    token?: Address;
    /** Whole tokens the wallet would hold of this token after the buy, when known. */
    projectedTokens?: number;
  };
  holdings: { equityWei: bigint; positionsWei: bigint };
  /** Change in the wallet's trading result since the start of the UTC day, in wei of BNB. Negative = losing. */
  pnlTodayWei: bigint;
  /** The wallet's highest value so far, in wei of BNB (at least its value now). */
  peakEquityWei: bigint;
}

export type FloatRiskRefusal = { code: Extract<FloatRefusalCode, "LOSS_LIMIT" | "DRAWDOWN_LIMIT" | "POSITION_LIMIT" | "EXPOSURE_LIMIT">; message: string };

const bnbToUsd = (wei: bigint, usdPerBnb: number): number => Number(formatEther(wei)) * usdPerBnb;
const usd = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : 0 })}`;

/**
 * Judges a buy against the rules that depend on value. Pure: the caller reads the chain and the books. Selling is never
 * judged here, because selling only ever reduces risk.
 */
export function checkValueRules(input: FloatRiskInput): FloatRiskRefusal | null {
  const { rules, usdPerBnb, buy, holdings } = input;

  if (rules.maxDailyLossUsd !== undefined && input.pnlTodayWei < 0n) {
    const lost = bnbToUsd(-input.pnlTodayWei, usdPerBnb);
    if (lost >= rules.maxDailyLossUsd) {
      return {
        code: "LOSS_LIMIT",
        message: `You are down about ${usd(lost)} today, which reaches your daily loss limit of ${usd(rules.maxDailyLossUsd)}. Buying is paused until tomorrow. Selling still works.`,
      };
    }
  }

  if (rules.maxDrawdown !== undefined && input.peakEquityWei > 0n && holdings.equityWei < input.peakEquityWei) {
    const fall = Number(input.peakEquityWei - holdings.equityWei) / Number(input.peakEquityWei);
    if (fall >= rules.maxDrawdown) {
      const pct = (n: number) => `${(n * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
      return {
        code: "DRAWDOWN_LIMIT",
        message: `Your wallet is down ${pct(fall)} from its highest value, which reaches your limit of ${pct(rules.maxDrawdown)}. Buying is paused until it recovers. Selling still works.`,
      };
    }
  }

  const tokenLimit = buy.token ? rules.tokenLimits?.[buy.token.toLowerCase()] : undefined;
  if (tokenLimit !== undefined && buy.projectedTokens !== undefined && buy.projectedTokens > tokenLimit) {
    return {
      code: "POSITION_LIMIT",
      message: `This buy would bring you to about ${Math.floor(buy.projectedTokens).toLocaleString()} of this token. Your limit for it is ${tokenLimit.toLocaleString()}.`,
    };
  }

  if (rules.maxExposureUsd !== undefined) {
    const after = bnbToUsd(holdings.positionsWei + buy.spendWei, usdPerBnb);
    if (after > rules.maxExposureUsd) {
      const room = Math.max(0, rules.maxExposureUsd - bnbToUsd(holdings.positionsWei, usdPerBnb));
      return {
        code: "EXPOSURE_LIMIT",
        message: `This buy would put about ${usd(after)} into open positions. Your limit is ${usd(rules.maxExposureUsd)}, so you have about ${usd(room)} of room.`,
      };
    }
  }
  return null;
}
