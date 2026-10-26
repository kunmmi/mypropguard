import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { PUMP_INSTRUCTIONS, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, associatedTokenAddress } from "../src/index.js";

export const SOL = 1_000_000_000n;
export const wallet = Keypair.generate();
export const W = wallet.publicKey.toBase58();
export const mint = Keypair.generate().publicKey;
export const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

const ACCOUNT_COUNT: Record<string, number> = { buy: 16, buy_exact_sol_in: 16, buy_v2: 27, buy_v3: 17, buy_exact_quote_in_v2: 27, buy_exact_quote_in_v3: 17, sell: 14, sell_v2: 26, sell_v3: 17 };

/** A pump.fun trade built to the real instruction layout (account positions from the IDL). */
export function pumpIx(name: string, over: { user?: PublicKey; tokenProgram?: string; u64?: bigint[]; mint?: PublicKey } = {}): TransactionInstruction {
  const [disc, layout] = Object.entries(PUMP_INSTRUCTIONS).find(([, l]) => l.name === name)!;
  const keys = Array.from({ length: ACCOUNT_COUNT[name]! }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  const set = (index: number, pubkey: PublicKey, isSigner = false) => {
    if (index >= 0) keys[index] = { pubkey, isSigner, isWritable: true };
  };
  const user = over.user ?? wallet.publicKey;
  const tokenProgram = over.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const theMint = over.mint ?? mint;
  set(layout.accounts.user, user, true);
  set(layout.accounts.mint, theMint);
  set(layout.accounts.tokenProgram, new PublicKey(tokenProgram));
  set(layout.accounts.associatedUser, new PublicKey(associatedTokenAddress(user.toBase58(), tokenProgram, theMint.toBase58())));
  if (layout.accounts.quoteMint >= 0) set(layout.accounts.quoteMint, new PublicKey(WSOL_MINT));
  const args = over.u64 ?? (layout.kind === "buy" ? [1_000_000n, SOL / 10n] : [1_000_000n, 0n]);
  const data = Buffer.alloc(8 + 8 * args.length + 2);
  Buffer.from(disc, "hex").copy(data);
  args.forEach((v, i) => data.writeBigUInt64LE(v, 8 + 8 * i));
  return new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM_ID), keys, data });
}

/** A transaction as a site would send it: base64, version 0, signed by nobody yet. */
export const txBase64 = (instructions: TransactionInstruction[], payer = wallet.publicKey): string =>
  Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message()).serialize()).toString("base64");
