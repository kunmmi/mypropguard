import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, associatedTokenAddress } from "./pumpfun.js";
import type { SolanaRpc } from "./rpc.js";
import type { SolanaWalletSigner } from "./solanaExecutor.js";
import type { SolanaValuer } from "./solanaValuer.js";

export interface SolanaSweepItem {
  /** "SOL" or the coin's mint. */
  asset: string;
  /** Raw amount moved (lamports for SOL). */
  amount: bigint;
  /** For a coin: what it was worth in lamports when handed back (an estimate from the quote taken just before). */
  proceedsLamports: bigint | null;
  signature: string | null;
  error: string | null;
  /** Why a coin was left in the wallet instead. */
  skipped?: string;
}

/** The network's base fee for a one-signature transaction. */
export const BASE_FEE_LAMPORTS = 5_000n;

const b64 = (tx: VersionedTransaction): string => Buffer.from(tx.serialize()).toString("base64");

function compile(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
}

/** A plain SOL transfer from the wallet to `to`. Unsigned, base64. */
export function buildSolTransfer(wallet: string, to: string, lamports: bigint, blockhash: string): string {
  return b64(compile(new PublicKey(wallet), blockhash, [SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: new PublicKey(to), lamports })]));
}

/**
 * Hands a coin's whole balance to `to`: creates `to`'s token account for it if it does not exist yet (paid by the wallet),
 * then transfers with the decimals checked. Unsigned, base64.
 */
export function buildTokenTransfer(input: { wallet: string; to: string; mint: string; amount: bigint; decimals: number; tokenProgram: string; blockhash: string }): string {
  const wallet = new PublicKey(input.wallet);
  const mint = new PublicKey(input.mint);
  const program = new PublicKey(input.tokenProgram);
  const source = new PublicKey(associatedTokenAddress(input.wallet, input.tokenProgram, input.mint));
  const destination = new PublicKey(associatedTokenAddress(input.to, input.tokenProgram, input.mint));
  const createDestination = new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(input.to), isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // create idempotent: harmless when it already exists
  });
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(input.amount, 1);
  data[9] = input.decimals;
  const transfer = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: false },
    ],
    data,
  });
  return b64(compile(wallet, input.blockhash, [createDestination, transfer]));
}

/** Closes the wallet's wrapped-SOL account, which unwraps everything in it back into the wallet as SOL. Unsigned, base64. */
export function buildUnwrapSol(wallet: string, blockhash: string): string {
  const owner = new PublicKey(wallet);
  const close = new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(associatedTokenAddress(wallet, TOKEN_PROGRAM_ID, WSOL_MINT)), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]), // CloseAccount
  });
  return b64(compile(owner, blockhash, [close]));
}

type SweepRpc =Pick<SolanaRpc, "getBalance" | "getTokenBalance" | "getAccountData" | "getAccountOwner" | "getLatestBlockhash" | "sendRaw" | "confirm">;

/**
 * Moves everything the wallet holds to `to`: each coin that has a market value, then the SOL that is left after the network
 * fee. `to` is a parameter of THIS function only: no request from a linked site can reach it.
 *
 * Coins go first because they need SOL for fees (and for the new token account's rent); the SOL goes last. A failure on one
 * item never stops the others, and each is reported.
 */
export async function sweepSolanaWallet(input: {
  walletId: string;
  wallet: string;
  to: string;
  mints: readonly string[];
  rpc: SweepRpc;
  signer: SolanaWalletSigner;
  valuer: Pick<SolanaValuer, "quoteSell">;
}): Promise<SolanaSweepItem[]> {
  const { rpc, signer } = input;
  const out: SolanaSweepItem[] = [];
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!;

  for (const mint of input.mints) {
    let amount = 0n;
    try {
      amount = await rpc.getTokenBalance(input.wallet, mint);
      if (amount === 0n) continue;
      const value = await input.valuer.quoteSell(mint, amount);
      if (value === 0n) {
        out.push({ asset: mint, amount, proceedsLamports: 0n, signature: null, error: null, skipped: "no market value, so it was left in the wallet" });
        continue;
      }
      const [owner, mintData, blockhash] = await Promise.all([rpc.getAccountOwner(mint), rpc.getAccountData(mint), rpc.getLatestBlockhash()]);
      if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) throw new Error("the coin uses a token program this wallet does not recognise");
      if (!mintData || mintData.length < 45) throw new Error("could not read the coin");
      const unsigned = buildTokenTransfer({ wallet: input.wallet, to: input.to, mint, amount, decimals: mintData[44]!, tokenProgram: owner, blockhash });
      const signature = await rpc.sendRaw(await signer.signTransaction(input.walletId, unsigned));
      await rpc.confirm(signature);
      out.push({ asset: mint, amount, proceedsLamports: value, signature, error: null });
    } catch (error) {
      out.push({ asset: mint, amount, proceedsLamports: null, signature: null, error: reason(error) });
    }
  }

  // SOL left wrapped by a PumpSwap trade: unwrap it first so it goes out with the rest of the SOL.
  try {
    const wrapped = await rpc.getTokenBalance(input.wallet, WSOL_MINT);
    if (wrapped > 0n) {
      const unsigned = buildUnwrapSol(input.wallet, await rpc.getLatestBlockhash());
      await rpc.confirm(await rpc.sendRaw(await signer.signTransaction(input.walletId, unsigned)));
    }
  } catch (error) {
    out.push({ asset: WSOL_MINT, amount: 0n, proceedsLamports: null, signature: null, error: `could not unwrap the wrapped SOL: ${reason(error)}` });
  }

  try {
    const [balance, blockhash] = await Promise.all([rpc.getBalance(input.wallet), rpc.getLatestBlockhash()]);
    const lamports = balance - BASE_FEE_LAMPORTS;
    if (lamports > 0n) {
      const unsigned = buildSolTransfer(input.wallet, input.to, lamports, blockhash);
      const signature = await rpc.sendRaw(await signer.signTransaction(input.walletId, unsigned));
      out.push({ asset: "SOL", amount: lamports, proceedsLamports: null, signature, error: null });
    }
  } catch (error) {
    out.push({ asset: "SOL", amount: 0n, proceedsLamports: null, signature: null, error: reason(error) });
  }
  return out;
}
