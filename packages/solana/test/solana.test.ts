import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkSolanaLoginMessage, describeTransaction, hostOf, inspectTransaction, looksLikeTransaction } from "../src/index.js";

const wallet = Keypair.generate();
const other = Keypair.generate();
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

const pumpIx = new TransactionInstruction({
  programId: PUMP,
  keys: [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: other.publicKey, isSigner: false, isWritable: true },
  ],
  data: Buffer.from("66063d1201daebea0a00000000000000", "hex"),
});

const legacyBase64 = () => {
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: BLOCKHASH }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), pumpIx);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
};
const v0Base64 = (instructions = [pumpIx]) => {
  const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
};

describe("reading a transaction without trusting it", () => {
  it("reads a legacy transaction: payer, signers, programs, data", () => {
    const t = inspectTransaction(legacyBase64());
    expect(t.version).toBe("legacy");
    expect(t.feePayer).toBe(wallet.publicKey.toBase58());
    expect(t.requiredSigners).toEqual([wallet.publicKey.toBase58()]);
    expect(t.programIds).toEqual(["ComputeBudget111111111111111111111111111111", PUMP.toBase58()]);
    expect(t.instructions[1]).toMatchObject({ programName: "pump.fun", discriminator: "66063d1201daebea", dataHex: "66063d1201daebea0a00000000000000" });
    expect(t.instructions[1]!.accounts[0]).toEqual({ pubkey: wallet.publicKey.toBase58(), isSigner: true, isWritable: true });
    expect(t.instructions[1]!.accounts[1]).toMatchObject({ pubkey: other.publicKey.toBase58(), isSigner: false, isWritable: true });
  });

  it("reads a version 0 transaction", () => {
    const t = inspectTransaction(v0Base64());
    expect(t.version).toBe(0);
    expect(t.feePayer).toBe(wallet.publicKey.toBase58());
    expect(t.usesLookupTables).toBe(false);
    expect(t.programIds).toEqual([PUMP.toBase58()]);
  });

  it("sees a plain SOL transfer to someone else for what it is", () => {
    const t = inspectTransaction(v0Base64([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other.publicKey, lamports: 1_000_000_000 })]));
    expect(t.instructions[0]).toMatchObject({ programName: "System" });
    expect(t.instructions[0]!.accounts.map((a) => a.pubkey)).toEqual([wallet.publicKey.toBase58(), other.publicKey.toBase58()]);
  });

  it("shows every signer a transaction asks for, so an extra signer cannot hide", () => {
    const ix = new TransactionInstruction({ programId: PUMP, keys: [{ pubkey: other.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) });
    const t = inspectTransaction(v0Base64([pumpIx, ix]));
    expect(t.requiredSigners).toEqual([wallet.publicKey.toBase58(), other.publicKey.toBase58()]);
  });

  it("describes it in one line for the owner", () => {
    expect(describeTransaction(inspectTransaction(legacyBase64()))).toBe("2 steps: Compute budget, pump.fun 66063d12");
  });

  it("refuses bytes that are not a transaction", () => {
    expect(() => inspectTransaction("")).toThrow(/Not a Solana transaction/);
    expect(() => inspectTransaction(Buffer.from("hello world, this is not a transaction").toString("base64"))).toThrow(/Not a Solana transaction/);
  });
});

describe("telling a login message from a transaction in disguise", () => {
  it("knows a transaction's bytes, whichever way it is packaged", () => {
    expect(looksLikeTransaction(Buffer.from(legacyBase64(), "base64"))).toBe(true);
    expect(looksLikeTransaction(Buffer.from(v0Base64(), "base64"))).toBe(true);
    const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: BLOCKHASH, instructions: [pumpIx] }).compileToV0Message();
    expect(looksLikeTransaction(message.serialize())).toBe(true);
    expect(looksLikeTransaction(Buffer.from("Sign in to pump.fun"))).toBe(false);
  });
});

describe("signing a login", () => {
  const text = (s: string) => new TextEncoder().encode(s);
  const site = { url: "https://pump.fun/" };

  it("signs readable text for pump.fun, including its www host", () => {
    expect(checkSolanaLoginMessage(text("Sign in to pump.fun\nNonce: 12345"), site)).toEqual({ ok: true, text: "Sign in to pump.fun\nNonce: 12345" });
    expect(checkSolanaLoginMessage(text("hi"), { url: "https://www.pump.fun/board" }).ok).toBe(true);
  });

  it("signs for letsbonk.fun and Raydium (LaunchLab's sites), including their www hosts", () => {
    for (const url of ["https://letsbonk.fun/", "https://www.letsbonk.fun/token/x", "https://raydium.io/launchpad/", "https://www.raydium.io/"]) {
      expect(checkSolanaLoginMessage(text("Sign in"), { url }).ok).toBe(true);
    }
    expect(checkSolanaLoginMessage(text("Sign in"), { url: "https://letsbonk.fun.evil.example" }).ok).toBe(false);
    expect(checkSolanaLoginMessage(text("Sign in"), { url: "https://raydium.io.evil.example" }).ok).toBe(false);
  });

  it("does not sign for any other site, and says which", () => {
    const r = checkSolanaLoginMessage(text("Sign in"), { url: "https://evil.example" });
    expect(r).toMatchObject({ ok: false, preview: "Sign in" });
    expect(!r.ok && r.message).toMatch(/evil\.example/);
    expect(checkSolanaLoginMessage(text("Sign in"), { url: "https://pump.fun.evil.example" }).ok).toBe(false);
    expect(checkSolanaLoginMessage(text("Sign in"), { url: null }).ok).toBe(false);
  });

  it("does not sign a transaction presented as a message", () => {
    const r = checkSolanaLoginMessage(Buffer.from(v0Base64(), "base64"), site);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/transaction in disguise/);
    const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: BLOCKHASH, instructions: [pumpIx] }).compileToV0Message();
    expect(checkSolanaLoginMessage(message.serialize(), site).ok).toBe(false);
  });

  it("does not sign binary, hidden characters, empty or very long messages", () => {
    expect(checkSolanaLoginMessage(new Uint8Array([0xff, 0xfe, 0xfd, 0x00]), site).ok).toBe(false);
    expect(checkSolanaLoginMessage(text("hello\u0000world"), site).ok).toBe(false);
    expect(checkSolanaLoginMessage(new Uint8Array(), site).ok).toBe(false);
    expect(checkSolanaLoginMessage(text("a".repeat(1025)), site).ok).toBe(false);
  });

  it("keeps a safe preview of what was refused", () => {
    const r = checkSolanaLoginMessage(text("x".repeat(500)), { url: "https://evil.example" });
    expect(!r.ok && r.preview.length).toBeLessThanOrEqual(301);
  });

  it("reads a page address's host", () => {
    expect(hostOf("https://Pump.fun/x?y=1")).toBe("pump.fun");
    expect(hostOf("nonsense")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});
