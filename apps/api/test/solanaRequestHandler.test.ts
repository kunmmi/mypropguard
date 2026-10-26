import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SOLANA_MAINNET_CAIP2 } from "@mypropguard/solana";
import { SolanaRequestHandler } from "../src/solana/solanaRequestHandler.js";
import type { SolanaRequestRecord, SolanaWalletRow } from "../src/solana/solanaStore.js";
import { OneClickRequestHandler } from "../src/oneClick/oneClickRequestHandler.js";
import type { LinkedSession } from "../src/oneClick/oneClickStore.js";

const keypair = Keypair.generate();
const WALLET = keypair.publicKey.toBase58();
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const CHAIN = SOLANA_MAINNET_CAIP2;

const session = (over: Partial<LinkedSession> = {}): LinkedSession => ({
  topic: "t1",
  accountId: "acct_1",
  kind: "solana",
  dappName: "pump.fun",
  dappUrl: "https://pump.fun",
  createdAt: new Date(),
  expiresAt: null,
  ...over,
});

function rig(over: { wallet?: Partial<SolanaWalletRow> | null; signFails?: boolean } = {}) {
  const records: SolanaRequestRecord[] = [];
  const signed: string[] = [];
  const wallet: SolanaWalletRow | undefined =
    over.wallet === null ? undefined : { accountId: "acct_1", walletId: "privy-sol-1", address: WALLET, status: "active", createdAt: new Date(), ...over.wallet };
  const handler = new SolanaRequestHandler({
    store: { get: async () => wallet, recordRequest: async (r: SolanaRequestRecord) => void records.push(r) },
    signer: {
      signMessage: async (_id, messageBase64) => {
        if (over.signFails) throw new Error("privy down\nmore");
        signed.push(Buffer.from(messageBase64, "base64").toString("utf8"));
        return Buffer.from("S".repeat(64)).toString("base64");
      },
    },
  });
  return { handler, records, signed };
}

const err = (r: any) => r.error as { code: number; message: string };
const msg = (text: string) => bs58.encode(new TextEncoder().encode(text));
const pumpTx = (): string => {
  const ix = new TransactionInstruction({ programId: PUMP, keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }], data: Buffer.from("66063d1201daebea0a00000000000000", "hex") });
  const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ix] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
};

describe("what a Solana site sees", () => {
  it("is told the wallet's address, either way it asks", async () => {
    const { handler } = rig();
    for (const method of ["solana_getAccounts", "solana_requestAccounts"]) {
      expect(await handler.handle(session(), CHAIN, { method })).toEqual({ result: [{ pubkey: WALLET }] });
    }
  });

  it("works on Solana mainnet only", async () => {
    expect(err(await rig().handler.handle(session(), "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", { method: "solana_getAccounts" })).code).toBe(4901);
  });

  it("does not support other methods", async () => {
    expect(err(await rig().handler.handle(session(), CHAIN, { method: "solana_somethingElse" })).code).toBe(-32601);
  });
});

describe("logging in (signMessage)", () => {
  it("signs a readable login for pump.fun, answers in base58, and records the text", async () => {
    const { handler, signed, records } = rig();
    const r: any = await handler.handle(session(), CHAIN, { method: "solana_signMessage", params: { message: msg("Sign in to pump.fun\nnonce 42"), pubkey: WALLET } });
    expect(bs58.decode(r.result.signature)).toHaveLength(64);
    expect(signed).toEqual(["Sign in to pump.fun\nnonce 42"]);
    expect(records.at(-1)).toMatchObject({ kind: "login", result: "SIGNED", dappName: "pump.fun", detail: { text: "Sign in to pump.fun\nnonce 42" } });
  });

  it("does not sign for another site, and records what it asked", async () => {
    const { handler, signed, records } = rig();
    const r = await handler.handle(session({ dappName: "evil", dappUrl: "https://evil.example" }), CHAIN, { method: "solana_signMessage", params: { message: msg("Approve everything"), pubkey: WALLET } });
    expect(err(r).code).toBe(4200);
    expect(signed).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ kind: "login", result: "REFUSED", code: "LOGIN_REFUSED", detail: { text: "Approve everything" } });
  });

  it("does not sign a transaction presented as a message", async () => {
    const { handler, signed } = rig();
    const r = await handler.handle(session(), CHAIN, { method: "solana_signMessage", params: { message: bs58.encode(Buffer.from(pumpTx(), "base64")), pubkey: WALLET } });
    expect(err(r).message).toMatch(/transaction in disguise/);
    expect(signed).toHaveLength(0);
  });

  it("does not sign for another address, and rejects a malformed request", async () => {
    const { handler, signed } = rig();
    const other = Keypair.generate().publicKey.toBase58();
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signMessage", params: { message: msg("hi"), pubkey: other } })).code).toBe(-32602);
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signMessage", params: { pubkey: WALLET } })).code).toBe(-32602);
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signMessage", params: { message: "0OIl-not-base58", pubkey: WALLET } })).code).toBe(-32602);
    expect(signed).toHaveLength(0);
  });

  it("reports a signing failure as an error, not a crash", async () => {
    const { handler, records } = rig({ signFails: true });
    const r = await handler.handle(session(), CHAIN, { method: "solana_signMessage", params: { message: msg("Sign in"), pubkey: WALLET } });
    expect(err(r).message).toBe("MyPropGuard could not sign the login: privy down");
    expect(records.at(-1)).toMatchObject({ result: "ERROR" });
  });
});

describe("transactions: read, recorded, refused", () => {
  it("records what a transaction does and signs nothing", async () => {
    const { handler, records, signed } = rig();
    for (const method of ["solana_signTransaction", "solana_signAndSendTransaction"]) {
      const r = await handler.handle(session(), CHAIN, { method, params: { transaction: pumpTx() } });
      expect(err(r).message).toMatch(/does not sign trades yet.*Nothing was signed/);
    }
    expect(signed).toHaveLength(0);
    const last = records.at(-1)!;
    expect(last).toMatchObject({ kind: "transaction", result: "REFUSED", code: "TRADING_NOT_ENABLED" });
    expect(last.message).toBe("2 steps: Compute budget, pump.fun 66063d12");
    const detail = last.detail as { transactions: Array<{ feePayer: string; programIds: string[] }> };
    expect(detail.transactions[0]!.feePayer).toBe(WALLET);
    expect(detail.transactions[0]!.programIds).toContain(PUMP.toBase58());
  });

  it("reads every transaction in a batch", async () => {
    const { handler, records } = rig();
    await handler.handle(session(), CHAIN, { method: "solana_signAllTransactions", params: { transactions: [pumpTx(), pumpTx()] } });
    expect((records.at(-1)!.detail as { transactions: unknown[] }).transactions).toHaveLength(2);
  });

  it("records an unreadable transaction as such, and still refuses", async () => {
    const { handler, records } = rig();
    const r = await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: Buffer.from("not a tx at all, sorry").toString("base64") } });
    expect(err(r).code).toBe(4200);
    expect(records.at(-1)!.message).toMatch(/could not read the transaction/);
  });

  it("rejects a request with no transaction", async () => {
    const { handler } = rig();
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: {} })).code).toBe(-32602);
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signAllTransactions", params: { transactions: [] } })).code).toBe(-32602);
  });
});

describe("a wallet that is off, or missing", () => {
  it("answers nothing while switched off, including the harmless requests", async () => {
    const { handler, signed } = rig({ wallet: { status: "off" } });
    for (const method of ["solana_getAccounts", "solana_signMessage", "solana_signTransaction"]) {
      expect(err(await handler.handle(session(), CHAIN, { method, params: {} })).code, method).toBe(4100);
    }
    expect(signed).toHaveLength(0);
  });

  it("says so when there is no Solana wallet at all", async () => {
    expect(err(await rig({ wallet: null }).handler.handle(session(), CHAIN, { method: "solana_getAccounts" })).code).toBe(4100);
  });
});

describe("routing between Safe, BNB wallet and Solana wallet links", () => {
  function router(opts: { withSolana: boolean }) {
    const { handler } = rig();
    const sessions: Record<string, LinkedSession> = { s: session({ topic: "s", kind: "safe", dappName: "PancakeSwap", dappUrl: "https://pancakeswap.finance" }), n: session({ topic: "n", kind: "solana" }) };
    const safeCalls: string[] = [];
    const oneClick = new OneClickRequestHandler({
      store: {
        get: async () => ({ accountId: "acct_1", sessionWalletId: "w", sessionWalletAddress: "0x1", status: "enabled", createdAt: new Date(), enabledAt: new Date() }),
        getSession: async (t: string) => sessions[t],
        recordTrade: async () => void safeCalls.push("audit"),
      } as never,
      findAccount: async () => ({ evmSafeAddress: "0x7777777777777777777777777777777777777777", evmChainId: 56 }),
      executors: { 56: { execute: async () => (safeCalls.push("exec"), `0x${"11".repeat(32)}` as `0x${string}`) } },
      solana: opts.withSolana ? handler : undefined,
    });
    return { oneClick, safeCalls };
  }

  it("a Solana link is answered by the Solana wallet and never touches the Safe", async () => {
    const { oneClick, safeCalls } = router({ withSolana: true });
    expect(await oneClick.handle("n", CHAIN, { method: "solana_getAccounts" })).toEqual({ result: [{ pubkey: WALLET }] });
    expect(safeCalls).toEqual([]);
  });

  it("without Solana wallets configured, a Solana link is refused rather than mistaken for a Safe link", async () => {
    const { oneClick, safeCalls } = router({ withSolana: false });
    expect(err(await oneClick.handle("n", CHAIN, { method: "solana_getAccounts" })).code).toBe(4100);
    expect(safeCalls).toEqual([]);
  });

  it("a Safe link still behaves as before", async () => {
    const { oneClick } = router({ withSolana: true });
    expect(((await oneClick.handle("s", "eip155:56", { method: "eth_accounts" })) as any).result).toEqual(["0x7777777777777777777777777777777777777777"]);
  });
});
