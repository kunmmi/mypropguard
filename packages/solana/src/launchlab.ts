import type { InspectedInstruction } from "./txInspect.js";
import { decodeTrade, type PumpInstructionLayout, type PumpTrade } from "./pumpfun.js";

/** Raydium LaunchLab: the bonding-curve launchpad behind letsbonk.fun and Raydium's own launchpad. */
export const LAUNCHLAB_PROGRAM_ID = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

/**
 * LaunchLab's buy and sell instructions, from Raydium's published IDL (github.com/raydium-io/raydium-idl,
 * raydium_launchpad/raydium_launchpad.json, last changed 2026-05-07, checked 2026-10-29). All four take the same accounts:
 * [payer, authority, global_config, platform_config, pool_state, user_base_token, user_quote_token, base_vault,
 * quote_vault, base_token_mint, quote_token_mint, base_token_program, quote_token_program, event_authority, program].
 * The payer is the trader. A pool sells a base token (the coin) for a quote token (wrapped SOL for the pools this wallet
 * trades; some letsbonk.fun pools use a stablecoin instead, and those are refused).
 *
 * `amount_in` is SOL on a buy but the coin on a sell, so each layout says which argument is which amount. The third
 * argument, `share_fee_rate`, is a cut (in millionths) the site asks to be paid to a fee receiver of its choosing.
 */
const ACCOUNTS = { user: 0, market: 4, associatedUser: 5, quoteUser: 6, mint: 9, quoteMint: 10, tokenProgram: 11, quoteTokenProgram: 12 };

export const LAUNCHLAB_INSTRUCTIONS: Readonly<Record<string, PumpInstructionLayout>> = {
  faea0d7bd59c13ec: { name: "buy_exact_in", kind: "buy", u64: ["amount_in", "minimum_amount_out", "share_fee_rate"], amounts: { spend: "amount_in", tokens: "minimum_amount_out" }, accounts: ACCOUNTS },
  "18d3742869039938": { name: "buy_exact_out", kind: "buy", u64: ["amount_out", "maximum_amount_in", "share_fee_rate"], amounts: { spend: "maximum_amount_in", tokens: "amount_out" }, accounts: ACCOUNTS },
  "9527de9bd37c981a": { name: "sell_exact_in", kind: "sell", u64: ["amount_in", "minimum_amount_out", "share_fee_rate"], amounts: { tokens: "amount_in", minSolOut: "minimum_amount_out" }, accounts: ACCOUNTS },
  "5fc8472208090ba6": { name: "sell_exact_out", kind: "sell", u64: ["amount_out", "maximum_amount_in", "share_fee_rate"], amounts: { tokens: "maximum_amount_in", minSolOut: "amount_out" }, accounts: ACCOUNTS },
};

/** Reads a LaunchLab buy or sell. Returns undefined for any other LaunchLab instruction, and throws if it is malformed. */
export function decodeLaunchLabTrade(ix: InspectedInstruction): PumpTrade | undefined {
  if (ix.programId !== LAUNCHLAB_PROGRAM_ID) return undefined;
  return decodeTrade(ix, LAUNCHLAB_INSTRUCTIONS, "Raydium LaunchLab");
}
