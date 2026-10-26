import { PublicKey, Transaction, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { KNOWN_PROGRAMS } from "./constants.js";

export interface InspectedInstruction {
  programId: string;
  /** Friendly name for a program we recognise, else undefined. */
  programName?: string;
  /** The accounts the instruction touches. An account that lives in an address lookup table shows as "lookup:<n>". */
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  /** The instruction's data, hex. The first 8 bytes of an Anchor program's data say which function is called. */
  dataHex: string;
  /** The first 8 bytes of the data, hex ("" when shorter). */
  discriminator: string;
}

export interface InspectedTransaction {
  version: "legacy" | 0;
  feePayer: string;
  /** Every account that must sign for the transaction to be valid. */
  requiredSigners: string[];
  recentBlockhash: string;
  instructions: InspectedInstruction[];
  /** Unique program ids, in order of first use. */
  programIds: string[];
  usesLookupTables: boolean;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Reads a base64 serialized Solana transaction without trusting it: who pays, who must sign, which programs it calls and
 * with what data. Throws when the bytes are not a Solana transaction.
 */
export function inspectTransaction(base64: string): InspectedTransaction {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > 1232 * 8) throw new Error("Not a Solana transaction (wrong size).");

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    // Older wallets serialise a legacy Transaction without the version prefix: VersionedTransaction handles both, so a
    // failure here means the bytes really are not a transaction.
    throw new Error("Not a Solana transaction (could not be read).");
  }
  const message = tx.message;
  if (message.version !== 0 && message.version !== "legacy") throw new Error("Not a supported Solana transaction version.");
  const keys = message.staticAccountKeys;
  const header = message.header;
  const isSignerIndex = (i: number) => i < header.numRequiredSignatures;
  const isWritableIndex = (i: number) => {
    if (i < header.numRequiredSignatures) return i < header.numRequiredSignatures - header.numReadonlySignedAccounts;
    return i < keys.length - header.numReadonlyUnsignedAccounts;
  };

  const instructions: InspectedInstruction[] = message.compiledInstructions.map((ix) => {
    const programKey = keys[ix.programIdIndex];
    if (!programKey) throw new Error("Not a valid Solana transaction (program is not in the account list).");
    const programId = programKey.toBase58();
    return {
      programId,
      programName: KNOWN_PROGRAMS[programId],
      accounts: ix.accountKeyIndexes.map((i) => ({
        pubkey: keys[i]?.toBase58() ?? `lookup:${i - keys.length}`,
        isSigner: isSignerIndex(i),
        isWritable: i < keys.length ? isWritableIndex(i) : true,
      })),
      dataHex: hex(ix.data),
      discriminator: ix.data.length >= 8 ? hex(ix.data.slice(0, 8)) : "",
    };
  });

  const programIds: string[] = [];
  for (const ix of instructions) if (!programIds.includes(ix.programId)) programIds.push(ix.programId);
  const feePayer = keys[0];
  if (!feePayer) throw new Error("Not a valid Solana transaction (no fee payer).");

  return {
    version: message.version,
    feePayer: feePayer.toBase58(),
    requiredSigners: keys.slice(0, header.numRequiredSignatures).map((k) => k.toBase58()),
    recentBlockhash: message.recentBlockhash,
    instructions,
    programIds,
    usesLookupTables: message.version === 0 && (message.addressTableLookups?.length ?? 0) > 0,
  };
}

/** A one-line description for the owner and the log. */
export function describeTransaction(t: InspectedTransaction): string {
  const calls = t.instructions.map((ix) => `${ix.programName ?? ix.programId.slice(0, 6) + "…"}${ix.discriminator ? ` ${ix.discriminator.slice(0, 8)}` : ""}`);
  return `${t.instructions.length} step${t.instructions.length === 1 ? "" : "s"}: ${calls.join(", ")}`;
}

/** True when these bytes parse as a Solana transaction or transaction message, however it is packaged. */
export function looksLikeTransaction(bytes: Uint8Array): boolean {
  try {
    VersionedMessage.deserialize(bytes);
    return true;
  } catch {
    // not a message
  }
  try {
    VersionedTransaction.deserialize(bytes);
    return true;
  } catch {
    // not a transaction
  }
  try {
    Transaction.from(Buffer.from(bytes));
    return true;
  } catch {
    return false;
  }
}

export const isValidPublicKey = (value: string): boolean => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
};
