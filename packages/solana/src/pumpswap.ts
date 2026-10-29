import type { InspectedInstruction } from "./txInspect.js";
import { decodeTrade, type PumpInstructionLayout, type PumpTrade } from "./pumpfun.js";

/** PumpSwap, pump.fun's AMM: where a coin trades once it has outgrown the bonding curve. */
export const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

/**
 * PumpSwap's buy and sell instructions, from pump.fun's published IDL (github.com/pump-fun/pump-public-docs,
 * idl/pump_amm.json, last changed 2026-10-07, checked 2026-10-29). A pool trades a base asset (the coin) against a quote
 * asset (wrapped SOL for the pools this wallet trades): a buy spends quote for base, a sell gives up base for quote.
 *
 * The discriminators are the same as pump.fun's own `buy`/`sell`/`buy_v2`/... (Anchor derives them from the name alone),
 * so a trade is only ever read with the table of the program it calls.
 *
 * `multi_hop_swap` is left out on purpose: it routes through more than one pool and is refused as "not a buy or a sell".
 */
const V1 = { market: 0, user: 1, mint: 3, quoteMint: 4, associatedUser: 5, quoteUser: 6, tokenProgram: 11, quoteTokenProgram: 12 };
const V2 = { market: 0, user: 1, mint: 3, quoteMint: 4, associatedUser: 5, quoteUser: 6, tokenProgram: 9, quoteTokenProgram: 10 };

export const PUMPSWAP_INSTRUCTIONS: Readonly<Record<string, PumpInstructionLayout>> = {
  "66063d1201daebea": { name: "buy", kind: "buy", u64: ["base_amount_out", "max_quote_amount_in"], accounts: V1 },
  c62e1552b4d9e870: { name: "buy_exact_quote_in", kind: "buy", u64: ["spendable_quote_in", "min_base_amount_out"], accounts: V1 },
  b817ee6167c5d33d: { name: "buy_v2", kind: "buy", u64: ["base_amount_out", "max_quote_amount_in"], accounts: V2 },
  c2ab1c46684d5b2f: { name: "buy_exact_quote_in_v2", kind: "buy", u64: ["spendable_quote_in", "min_base_amount_out"], accounts: V2 },
  "33e685a4017f83ad": { name: "sell", kind: "sell", u64: ["base_amount_in", "min_quote_amount_out"], accounts: V1 },
  "5df6823ce7e940b2": { name: "sell_v2", kind: "sell", u64: ["base_amount_in", "min_quote_amount_out"], accounts: V2 },
};

/** Reads a PumpSwap buy or sell. Returns undefined for any other PumpSwap instruction, and throws if it is malformed. */
export function decodePumpSwapTrade(ix: InspectedInstruction): PumpTrade | undefined {
  if (ix.programId !== PUMPSWAP_PROGRAM_ID) return undefined;
  return decodeTrade(ix, PUMPSWAP_INSTRUCTIONS, "PumpSwap");
}
