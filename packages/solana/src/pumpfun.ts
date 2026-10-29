import { PublicKey } from "@solana/web3.js";
import type { InspectedInstruction } from "./txInspect.js";

/** pump.fun's bonding-curve program. */
export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Wrapped SOL, the quote mint of a SOL-paired coin. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * The buy and sell instructions of pump.fun's program: their 8-byte discriminators, the position of each account that
 * matters, and which of their u64 arguments is what. Generated from pump.fun's published IDL
 * (github.com/pump-fun/pump-public-docs, idl/pump.json), checked 2026-10-26.
 *
 * `spendArg` is the SOL a buy may cost at most (`max_sol_cost`) or will spend (`spendable_*_in`); `tokenArg` is the
 * token amount a buy asks for or at least expects, or a sell gives up.
 */
export interface PumpInstructionLayout {
  name: string;
  kind: "buy" | "sell";
  /** The u64 arguments, in order, after the 8-byte discriminator. */
  u64: readonly string[];
  /**
   * Which argument is which amount, for programs whose names do not say (LaunchLab's `amount_in` is SOL on a buy but the
   * coin on a sell). Without it the amounts are found by name.
   */
  amounts?: { spend?: string; tokens: string; minSolOut?: string };
  /**
   * Index of each account in the instruction's account list; -1 where the instruction has none. `market` is the bonding
   * curve (pump.fun) or the pool (PumpSwap). `quoteUser` is the wallet's own account for the quote asset: where a buy's
   * SOL comes from and a sale's SOL goes, when that is wrapped SOL.
   */
  accounts: { user: number; mint: number; market: number; associatedUser: number; tokenProgram: number; quoteMint: number; quoteUser: number; quoteTokenProgram: number };
}

const OLD = { quoteMint: -1, quoteUser: -1, quoteTokenProgram: -1 };
const V2 = { user: 13, mint: 1, market: 10, associatedUser: 14, tokenProgram: 3, quoteMint: 2, quoteUser: 15, quoteTokenProgram: 4 };
const V3 = { user: 8, mint: 1, market: 5, associatedUser: 9, tokenProgram: 3, quoteMint: 2, quoteUser: 10, quoteTokenProgram: 4 };

export const PUMP_INSTRUCTIONS: Readonly<Record<string, PumpInstructionLayout>> = {
  "66063d1201daebea": { name: "buy", kind: "buy", u64: ["amount", "max_sol_cost"], accounts: { user: 6, mint: 2, market: 3, associatedUser: 5, tokenProgram: 8, ...OLD } },
  "38fc74089edfcd5f": { name: "buy_exact_sol_in", kind: "buy", u64: ["spendable_sol_in", "min_tokens_out"], accounts: { user: 6, mint: 2, market: 3, associatedUser: 5, tokenProgram: 8, ...OLD } },
  b817ee6167c5d33d: { name: "buy_v2", kind: "buy", u64: ["amount", "max_sol_cost"], accounts: V2 },
  "07051dc4f5176550": { name: "buy_v3", kind: "buy", u64: ["amount", "max_sol_cost"], accounts: V3 },
  c2ab1c46684d5b2f: { name: "buy_exact_quote_in_v2", kind: "buy", u64: ["spendable_quote_in", "min_tokens_out"], accounts: V2 },
  e1f7501ed5b38488: { name: "buy_exact_quote_in_v3", kind: "buy", u64: ["spendable_quote_in", "min_tokens_out"], accounts: V3 },
  "33e685a4017f83ad": { name: "sell", kind: "sell", u64: ["amount", "min_sol_output"], accounts: { user: 6, mint: 2, market: 3, associatedUser: 5, tokenProgram: 9, ...OLD } },
  "5df6823ce7e940b2": { name: "sell_v2", kind: "sell", u64: ["amount", "min_sol_output"], accounts: V2 },
  "1c92de7726c469d5": { name: "sell_v3", kind: "sell", u64: ["amount", "min_sol_output"], accounts: V3 },
};

export type TradeVenue = "pump.fun" | "PumpSwap" | "Raydium LaunchLab";

export interface PumpTrade {
  venue: TradeVenue;
  /** Which instruction it is, e.g. "buy_v2". */
  instruction: string;
  kind: "buy" | "sell";
  mint: string;
  /** The account that signs and pays: must be the wallet. */
  user: string;
  /** Where the tokens go (buy) or come from (sell). */
  associatedUser: string;
  tokenProgram: string;
  /** The bonding curve (pump.fun) or the pool (PumpSwap) the trade is made against. */
  market: string;
  /** The coin's quote asset, when the instruction names one (undefined on the older instructions). */
  quoteMint?: string;
  /** The account a buy's quote is paid from and a sale's quote is paid to, when the instruction names one. */
  quoteUser?: string;
  quoteTokenProgram?: string;
  /** For a buy: the most SOL (lamports) it may cost, or the SOL it will spend. Zero for a sell. */
  spendLamports: bigint;
  /** For a buy: the tokens it asks for or at least expects. For a sell: the tokens it gives up. */
  tokenAmount: bigint;
  /** For a sell: the least SOL (lamports) it will accept. */
  minSolOut: bigint;
  /** The share of the trade the site asks to be paid to a fee receiver it chooses (LaunchLab), in millionths. */
  shareFeeRate?: bigint;
}

const u64At = (data: Buffer, offset: number): bigint => data.readBigUInt64LE(offset);

/** Reads a pump.fun buy or sell. Returns undefined for any other pump.fun instruction, and throws if it is malformed. */
export function decodePumpTrade(ix: InspectedInstruction): PumpTrade | undefined {
  if (ix.programId !== PUMP_PROGRAM_ID) return undefined;
  return decodeTrade(ix, PUMP_INSTRUCTIONS, "pump.fun");
}

/**
 * Reads a trade with its program's layout table. pump.fun and PumpSwap name their arguments differently (pump.fun:
 * `max_sol_cost`, `min_sol_output`; PumpSwap: `max_quote_amount_in`, `min_quote_amount_out`), so each amount is looked up
 * under every name it goes by, unless the layout says which argument is which.
 */
export function decodeTrade(ix: InspectedInstruction, table: Readonly<Record<string, PumpInstructionLayout>>, venue: TradeVenue): PumpTrade | undefined {
  const layout = table[ix.discriminator];
  if (!layout) return undefined;
  const data = Buffer.from(ix.dataHex, "hex");
  if (data.length < 8 + 8 * layout.u64.length) throw new Error(`The ${layout.name} instruction is too short.`);
  const args: Record<string, bigint> = {};
  layout.u64.forEach((name, i) => (args[name] = u64At(data, 8 + 8 * i)));
  const at = (index: number): string => {
    const key = ix.accounts[index]?.pubkey;
    if (!key || key.startsWith("lookup:")) throw new Error(`The ${layout.name} instruction hides an account that must be checked.`);
    return key;
  };
  const a = layout.accounts;
  const isBuy = layout.kind === "buy";
  const roles = layout.amounts;
  const arg = (name: string | undefined): bigint => (name !== undefined ? (args[name] ?? 0n) : 0n);
  const amounts = roles
    ? { spendLamports: isBuy ? arg(roles.spend) : 0n, tokenAmount: arg(roles.tokens), minSolOut: isBuy ? 0n : arg(roles.minSolOut) }
    : {
        spendLamports: isBuy ? (args.max_sol_cost ?? args.max_quote_amount_in ?? args.spendable_quote_in ?? args.spendable_sol_in ?? 0n) : 0n,
        tokenAmount: isBuy ? (args.amount ?? args.base_amount_out ?? args.min_tokens_out ?? args.min_base_amount_out ?? 0n) : (args.amount ?? args.base_amount_in ?? 0n),
        minSolOut: isBuy ? 0n : (args.min_sol_output ?? args.min_quote_amount_out ?? 0n),
      };
  return {
    venue,
    instruction: layout.name,
    kind: layout.kind,
    mint: at(a.mint),
    user: at(a.user),
    associatedUser: at(a.associatedUser),
    tokenProgram: at(a.tokenProgram),
    market: at(a.market),
    quoteMint: a.quoteMint >= 0 ? at(a.quoteMint) : undefined,
    quoteUser: a.quoteUser >= 0 ? at(a.quoteUser) : undefined,
    quoteTokenProgram: a.quoteTokenProgram >= 0 ? at(a.quoteTokenProgram) : undefined,
    ...amounts,
    shareFeeRate: args.share_fee_rate,
  };
}

/** The address a wallet's token account for `mint` must have under `tokenProgram`. */
export function associatedTokenAddress(owner: string, tokenProgram: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0].toBase58();
}

/** A coin's bonding curve account address. */
export function bondingCurveAddress(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM_ID))[0].toBase58();
}
