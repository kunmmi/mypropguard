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
  /** Index of each account in the instruction's account list; -1 where the instruction has none. */
  accounts: { user: number; mint: number; bondingCurve: number; associatedUser: number; tokenProgram: number; quoteMint: number };
}

export const PUMP_INSTRUCTIONS: Readonly<Record<string, PumpInstructionLayout>> = {
  "66063d1201daebea": { name: "buy", kind: "buy", u64: ["amount", "max_sol_cost"], accounts: { user: 6, mint: 2, bondingCurve: 3, associatedUser: 5, tokenProgram: 8, quoteMint: -1 } },
  "38fc74089edfcd5f": { name: "buy_exact_sol_in", kind: "buy", u64: ["spendable_sol_in", "min_tokens_out"], accounts: { user: 6, mint: 2, bondingCurve: 3, associatedUser: 5, tokenProgram: 8, quoteMint: -1 } },
  b817ee6167c5d33d: { name: "buy_v2", kind: "buy", u64: ["amount", "max_sol_cost"], accounts: { user: 13, mint: 1, bondingCurve: 10, associatedUser: 14, tokenProgram: 3, quoteMint: 2 } },
  "07051dc4f5176550": { name: "buy_v3", kind: "buy", u64: ["amount", "max_sol_cost"], accounts: { user: 8, mint: 1, bondingCurve: 5, associatedUser: 9, tokenProgram: 3, quoteMint: 2 } },
  c2ab1c46684d5b2f: { name: "buy_exact_quote_in_v2", kind: "buy", u64: ["spendable_quote_in", "min_tokens_out"], accounts: { user: 13, mint: 1, bondingCurve: 10, associatedUser: 14, tokenProgram: 3, quoteMint: 2 } },
  e1f7501ed5b38488: { name: "buy_exact_quote_in_v3", kind: "buy", u64: ["spendable_quote_in", "min_tokens_out"], accounts: { user: 8, mint: 1, bondingCurve: 5, associatedUser: 9, tokenProgram: 3, quoteMint: 2 } },
  "33e685a4017f83ad": { name: "sell", kind: "sell", u64: ["amount", "min_sol_output"], accounts: { user: 6, mint: 2, bondingCurve: 3, associatedUser: 5, tokenProgram: 9, quoteMint: -1 } },
  "5df6823ce7e940b2": { name: "sell_v2", kind: "sell", u64: ["amount", "min_sol_output"], accounts: { user: 13, mint: 1, bondingCurve: 10, associatedUser: 14, tokenProgram: 3, quoteMint: 2 } },
  "1c92de7726c469d5": { name: "sell_v3", kind: "sell", u64: ["amount", "min_sol_output"], accounts: { user: 8, mint: 1, bondingCurve: 5, associatedUser: 9, tokenProgram: 3, quoteMint: 2 } },
};

export interface PumpTrade {
  /** Which pump.fun instruction it is, e.g. "buy_v2". */
  instruction: string;
  kind: "buy" | "sell";
  mint: string;
  /** The account that signs and pays: must be the wallet. */
  user: string;
  /** Where the tokens go (buy) or come from (sell). */
  associatedUser: string;
  tokenProgram: string;
  bondingCurve: string;
  /** The coin's quote asset, when the instruction names one (undefined on the older instructions). */
  quoteMint?: string;
  /** For a buy: the most SOL (lamports) it may cost, or the SOL it will spend. Zero for a sell. */
  spendLamports: bigint;
  /** For a buy: the tokens it asks for or at least expects. For a sell: the tokens it gives up. */
  tokenAmount: bigint;
  /** For a sell: the least SOL (lamports) it will accept. */
  minSolOut: bigint;
}

const u64At = (data: Buffer, offset: number): bigint => data.readBigUInt64LE(offset);

/** Reads a pump.fun buy or sell. Returns undefined for any other pump.fun instruction, and throws if it is malformed. */
export function decodePumpTrade(ix: InspectedInstruction): PumpTrade | undefined {
  if (ix.programId !== PUMP_PROGRAM_ID) return undefined;
  const layout = PUMP_INSTRUCTIONS[ix.discriminator];
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
  return {
    instruction: layout.name,
    kind: layout.kind,
    mint: at(a.mint),
    user: at(a.user),
    associatedUser: at(a.associatedUser),
    tokenProgram: at(a.tokenProgram),
    bondingCurve: at(a.bondingCurve),
    quoteMint: a.quoteMint >= 0 ? at(a.quoteMint) : undefined,
    spendLamports: isBuy ? (args.max_sol_cost ?? args.spendable_quote_in ?? args.spendable_sol_in ?? 0n) : 0n,
    tokenAmount: isBuy ? (args.amount ?? args.min_tokens_out ?? 0n) : (args.amount ?? 0n),
    minSolOut: isBuy ? 0n : (args.min_sol_output ?? 0n),
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
