import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  BASE_FEE_LAMPORTS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  associatedTokenAddress,
  buildSolTransfer,
  buildTokenTransfer,
  buildUnwrapSol,
  inspectTransaction,
  sweepSolanaWallet,
} from "../src/index.js";
import { BLOCKHASH, SOL, W } from "./helpers.js";

const OWNER = Keypair.generate().publicKey.toBase58(); // the owner's withdrawal address
const MINT_A = Keypair.generate().publicKey.toBase58();
const MINT_B = Keypair.generate().publicKey.toBase58();
const MINT_DEAD = Keypair.generate().publicKey.toBase58();

describe("building the withdrawal transactions", () => {
  it("a SOL transfer pays from the wallet to the owner and nothing else", () => {
    const t = inspectTransaction(buildSolTransfer(W, OWNER, 5n * SOL, BLOCKHASH));
    expect(t.feePayer).toBe(W);
    expect(t.requiredSigners).toEqual([W]);
    expect(t.instructions).toHaveLength(1);
    expect(t.instructions[0]!.programName).toBe("System");
    expect(t.instructions[0]!.accounts.map((a) => a.pubkey)).toEqual([W, OWNER]);
  });

  it("a coin transfer creates the owner's token account then moves the coin there, signed by the wallet alone", () => {
    const t = inspectTransaction(buildTokenTransfer({ wallet: W, to: OWNER, mint: MINT_A, amount: 1234n, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID, blockhash: BLOCKHASH }));
    expect(t.requiredSigners).toEqual([W]);
    expect(t.instructions.map((i) => i.programName)).toEqual(["Associated token account", "Token-2022"]);
    const [create, transfer] = t.instructions;
    const ownerAta = associatedTokenAddress(OWNER, TOKEN_2022_PROGRAM_ID, MINT_A);
    const walletAta = associatedTokenAddress(W, TOKEN_2022_PROGRAM_ID, MINT_A);
    expect(create!.accounts[1]!.pubkey).toBe(ownerAta);
    expect(create!.accounts[2]!.pubkey).toBe(OWNER);
    // TransferChecked: [source, mint, destination, authority]
    expect(transfer!.accounts.map((a) => a.pubkey)).toEqual([walletAta, MINT_A, ownerAta, W]);
    const data = Buffer.from(transfer!.dataHex, "hex");
    expect(data[0]).toBe(12);
    expect(data.readBigUInt64LE(1)).toBe(1234n);
    expect(data[9]).toBe(6);
  });
});

describe("unwrapping SOL left by a PumpSwap trade", () => {
  it("closes the wallet's own wrapped-SOL account into the wallet, and touches nothing else", () => {
    const t = inspectTransaction(buildUnwrapSol(W, BLOCKHASH));
    expect(t.requiredSigners).toEqual([W]);
    expect(t.instructions).toHaveLength(1);
    expect(t.instructions[0]!.programName).toBe("Token");
    expect(t.instructions[0]!.dataHex).toBe("09");
    // CloseAccount: [account, destination, owner]
    expect(t.instructions[0]!.accounts.map((a) => a.pubkey)).toEqual([associatedTokenAddress(W, TOKEN_PROGRAM_ID, WSOL_MINT), W, W]);
  });
});

function rig(over: { sol?: bigint; fail?: string[]; wrapped?: bigint; unwrapFails?: boolean } = {}) {
  const sent: string[] = [];
  const signed: string[] = [];
  const balances: Record<string, bigint> = { [MINT_A]: 500n, [MINT_B]: 9n, [MINT_DEAD]: 70n, [WSOL_MINT]: over.wrapped ?? 0n };
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  const rpc = {
    getBalance: async () => over.sol ?? SOL,
    getTokenBalance: async (_o: string, mint: string) => balances[mint] ?? 0n,
    getAccountData: async () => mintData,
    getAccountOwner: async () => TOKEN_2022_PROGRAM_ID,
    getLatestBlockhash: async () => BLOCKHASH,
    sendRaw: async (tx: string) => {
      sent.push(tx);
      return `SIG${sent.length}`;
    },
    confirm: async () => undefined,
  };
  const signer = {
    signTransaction: async (_id: string, tx: string) => {
      const t = inspectTransaction(tx);
      if (over.unwrapFails && t.instructions[0]?.dataHex === "09") throw new Error("privy down");
      if (over.fail?.some((m) => t.instructions.some((i) => i.accounts.some((a) => a.pubkey === associatedTokenAddress(OWNER, TOKEN_2022_PROGRAM_ID, m))))) throw new Error("privy down\nmore");
      signed.push(tx);
      return tx;
    },
  };
  const valuer = { quoteSell: async (mint: string, amount: bigint) => (mint === MINT_DEAD ? 0n : amount * 3n) };
  return { sent, signed, run: () => sweepSolanaWallet({ walletId: "w", wallet: W, to: OWNER, mints: [MINT_A, MINT_B, MINT_DEAD], rpc, signer, valuer }) };
}

describe("withdrawing everything to the owner's address", () => {
  it("sends each coin that has a value, then the SOL left after the fee, all to the owner", async () => {
    const { run, sent, signed } = rig();
    const items = await run();
    expect(items.map((i) => i.asset)).toEqual([MINT_A, MINT_B, MINT_DEAD, "SOL"]);
    expect(items[0]).toMatchObject({ amount: 500n, proceedsLamports: 1500n, signature: "SIG1", error: null });
    expect(items[1]).toMatchObject({ amount: 9n, proceedsLamports: 27n, signature: "SIG2" });
    expect(items[2]).toMatchObject({ amount: 70n, signature: null, skipped: expect.stringMatching(/no market value/) });
    expect(items[3]).toMatchObject({ asset: "SOL", amount: SOL - BASE_FEE_LAMPORTS, signature: "SIG3" });
    expect(sent).toHaveLength(3);
    // Every signed transaction is signed by the wallet alone, and the only recipient anywhere is the owner.
    for (const tx of signed) {
      const t = inspectTransaction(tx);
      expect(t.requiredSigners).toEqual([W]);
      const touched = t.instructions.flatMap((i) => i.accounts.map((a) => a.pubkey));
      expect(touched).toSatisfy((keys: string[]) => keys.some((k) => k === OWNER || k === associatedTokenAddress(OWNER, TOKEN_2022_PROGRAM_ID, MINT_A) || k === associatedTokenAddress(OWNER, TOKEN_2022_PROGRAM_ID, MINT_B)));
    }
  });

  it("sends no SOL when it would not cover its own fee", async () => {
    const { run } = rig({ sol: 4_000n });
    const items = await run();
    expect(items.find((i) => i.asset === "SOL")).toBeUndefined();
  });

  it("unwraps SOL left wrapped by a PumpSwap trade before sending the SOL, so it goes out too", async () => {
    const { run, sent } = rig({ wrapped: SOL / 4n });
    const items = await run();
    expect(sent).toHaveLength(4);
    expect(inspectTransaction(sent[2]!).instructions[0]!.dataHex).toBe("09");
    expect(inspectTransaction(sent[3]!).instructions[0]!.programName).toBe("System");
    expect(items.map((i) => i.asset)).toEqual([MINT_A, MINT_B, MINT_DEAD, "SOL"]);
  });

  it("still sends the SOL when unwrapping fails, and says so", async () => {
    const { run } = rig({ wrapped: SOL / 4n, unwrapFails: true });
    const items = await run();
    expect(items.find((i) => i.asset === WSOL_MINT)).toMatchObject({ signature: null, error: expect.stringMatching(/could not unwrap.*privy down/) });
    expect(items.at(-1)).toMatchObject({ asset: "SOL", error: null });
  });

  it("one coin failing does not stop the rest, and says which", async () => {
    const { run } = rig({ fail: [MINT_A] });
    const items = await run();
    expect(items[0]).toMatchObject({ asset: MINT_A, signature: null, error: "privy down" });
    expect(items[1]).toMatchObject({ asset: MINT_B, error: null });
    expect(items.at(-1)).toMatchObject({ asset: "SOL", error: null });
  });
});
