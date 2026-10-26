import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { PUMP_INSTRUCTIONS, SOLANA_MAINNET_CAIP2, SolanaExecutor, TOKEN_2022_PROGRAM_ID, WSOL_MINT, associatedTokenAddress } from "@mypropguard/solana";
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
    over.wallet === null ? undefined : { accountId: "acct_1", walletId: "privy-sol-1", address: WALLET, status: "active", maxBuyPct: 25, dailySpendPct: 50, maxBuysPerDay: 10, cooldownSec: 0, frozen: false, withdrawalAddress: null, createdAt: new Date(), ...over.wallet };
  const handler = new SolanaRequestHandler({
    store: { get: async () => wallet, recordRequest: async (r: SolanaRequestRecord) => void records.push(r), usageToday: async () => ({ buysToday: 0, spentTodayLamports: 0n, lastBuyAtSec: null }) },
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

// ---- Trading: the real executor and rules, with the network and Privy stood in for ----------------------------------------

const SOL = 1_000_000_000n;
const MINT = Keypair.generate().publicKey;
const ata = associatedTokenAddress(WALLET, TOKEN_2022_PROGRAM_ID, MINT.toBase58());

function tradeTx(name: "buy_v3" | "sell_v3", args: bigint[]): string {
  const [disc, layout] = Object.entries(PUMP_INSTRUCTIONS).find(([, l]) => l.name === name)!;
  const keys = Array.from({ length: 17 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  const put = (i: number, pubkey: PublicKey, isSigner = false) => void (keys[i] = { pubkey, isSigner, isWritable: true });
  put(layout.accounts.user, keypair.publicKey, true);
  put(layout.accounts.mint, MINT);
  put(layout.accounts.tokenProgram, new PublicKey(TOKEN_2022_PROGRAM_ID));
  put(layout.accounts.associatedUser, new PublicKey(ata));
  put(layout.accounts.quoteMint, new PublicKey(WSOL_MINT));
  const data = Buffer.alloc(8 + 8 * args.length + 2);
  Buffer.from(disc, "hex").copy(data);
  args.forEach((v, i) => data.writeBigUInt64LE(v, 8 + 8 * i));
  const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k", instructions: [new TransactionInstruction({ programId: PUMP, keys, data })] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function tradeRig(over: { balance?: bigint; wallet?: Partial<SolanaWalletRow>; trading?: boolean; rules?: any; guard?: any; simulate?: any } = {}) {
  const records: SolanaRequestRecord[] = [];
  const signedTx: string[] = [];
  const sent: string[] = [];
  const wallet: SolanaWalletRow = { accountId: "acct_1", walletId: "privy-sol-1", address: WALLET, status: "active", maxBuyPct: 25, dailySpendPct: 50, maxBuysPerDay: 3, cooldownSec: 0, frozen: false, withdrawalAddress: null, createdAt: new Date(), ...over.wallet };
  const store = {
    get: async () => wallet,
    recordRequest: async (r: SolanaRequestRecord) => void records.push(r),
    // The day's counters, derived from what was recorded: exactly how the real store does it.
    usageToday: async () => {
      const buys = records.filter((r) => r.tradeKind === "buy" && r.result === "SIGNED");
      return { buysToday: buys.length, spentTodayLamports: buys.reduce((a, r) => a + (r.lamports ?? 0n), 0n), lastBuyAtSec: null };
    },
  };
  const executor = new SolanaExecutor({
    rpc: {
      getBalance: async () => over.balance ?? SOL,
      simulate: async () => over.simulate ?? { err: null, logs: [] },
      sendRaw: async (tx) => (sent.push(tx), "NETSIG111111111111111111111111111111111111111111111111111111111111111111111111"),
    },
    signer: { signTransaction: async (_id, tx) => (signedTx.push(tx), tx) },
  });
  const handler = new SolanaRequestHandler({
    store,
    signer: { signMessage: async () => Buffer.from("S".repeat(64)).toString("base64") },
    executor,
    tradingEnabled: over.trading ?? true,
    accountRules: over.rules,
    riskGuard: over.guard,
  });
  return { handler, records, signedTx, sent };
}

describe("trading (with the switch on)", () => {
  it("signs an allowed buy, returns the signed transaction for the site to send, and records it", async () => {
    const { handler, records, signedTx, sent } = tradeRig();
    const tx = tradeTx("buy_v3", [1n, SOL / 10n]);
    const r: any = await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tx } });
    expect(r.result.transaction).toBe(tx);
    expect(r.result.signature).toBeDefined();
    expect(signedTx).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ kind: "transaction", result: "SIGNED", tradeKind: "buy", mint: MINT.toBase58(), lamports: SOL / 10n, dappName: "pump.fun" });
    expect(records.at(-1)!.timings).toMatchObject({ totalMs: expect.any(Number) });
  });

  it("for signAndSend it sends the transaction itself and answers with the network's signature", async () => {
    const { handler, sent } = tradeRig();
    const r: any = await handler.handle(session(), CHAIN, { method: "solana_signAndSendTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 10n]) } });
    expect(r.result).toEqual({ signature: expect.stringMatching(/^NETSIG/) });
    expect(sent).toHaveLength(1);
  });

  it("refuses a buy over the wallet's limit, with the reason, recorded, and signs nothing", async () => {
    const { handler, records, signedTx } = tradeRig();
    const r = await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 2n]) } });
    expect(err(r).code).toBe(-32000);
    expect(err(r).message).toMatch(/up to 0\.5 SOL.*0\.25 SOL/);
    expect(signedTx).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ kind: "transaction", result: "REFUSED", code: "MAX_BUY" });
  });

  it("counts earlier buys: three a day", async () => {
    const { handler } = tradeRig();
    for (let i = 0; i < 3; i++) expect(((await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 20n]) } })) as any).result).toBeDefined();
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 20n]) } })).message).toMatch(/all 3 buys/);
  });

  it("a sell always goes through, even with buying paused and no SOL", async () => {
    const { handler } = tradeRig({ balance: 0n, wallet: { frozen: true } });
    const r: any = await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("sell_v3", [1000n, 0n]) } });
    expect(r.result.signature).toBeDefined();
  });

  it("a trade the network says would fail is not signed", async () => {
    const { handler, signedTx, records } = tradeRig({ simulate: { err: { InstructionError: [0, "Custom"] }, logs: ["Program log: Error: slippage exceeded"] } });
    const r = await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 10n]) } });
    expect(err(r).message).toMatch(/no fee was spent/);
    expect(signedTx).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ result: "REFUSED", code: "WOULD_FAIL" });
  });

  it("the account's own trade-frequency rule is applied when it is tighter", async () => {
    const { handler } = tradeRig({ rules: async () => ({ maxTradesPerDay: 1, value: {} }) });
    expect(((await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 20n]) } })) as any).result).toBeDefined();
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 20n]) } })).message).toMatch(/all 1 buys/);
  });

  it("if the account's rules cannot be read, buying pauses but selling still works", async () => {
    const { handler } = tradeRig({ rules: async () => { throw new Error("db down"); } });
    expect(err(await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 20n]) } })).message).toMatch(/paused/i);
    expect(((await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("sell_v3", [10n, 0n]) } })) as any).result).toBeDefined();
  });

  it("a buy the value-rules guard refuses is recorded with its code and never signed", async () => {
    const { handler, signedTx, records } = tradeRig({
      rules: async () => ({ value: { maxDailyLossUsd: 10 } }),
      guard: { checkBuy: async () => ({ code: "LOSS_LIMIT", message: "You are down too much today." }), valueSell: async () => null },
    });
    const r = await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 20n]) } });
    expect(err(r).message).toBe("You are down too much today.");
    expect(signedTx).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ result: "REFUSED", code: "LOSS_LIMIT" });
  });

  it("a sale is recorded with what it should return", async () => {
    const { handler, records } = tradeRig({ guard: { checkBuy: async () => null, valueSell: async () => 123n } });
    await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("sell_v3", [10n, 0n]) } });
    expect(records.at(-1)).toMatchObject({ tradeKind: "sell", result: "SIGNED", proceedsLamports: 123n });
  });

  it("signs a batch of one, and refuses a batch of several", async () => {
    const { handler, records } = tradeRig();
    const one: any = await handler.handle(session(), CHAIN, { method: "solana_signAllTransactions", params: { transactions: [tradeTx("buy_v3", [1n, SOL / 20n])] } });
    expect(one.result.transactions).toHaveLength(1);
    const many = await handler.handle(session(), CHAIN, { method: "solana_signAllTransactions", params: { transactions: [tradeTx("buy_v3", [1n, SOL / 20n]), tradeTx("buy_v3", [1n, SOL / 20n])] } });
    expect(err(many).message).toMatch(/one trade at a time/);
    expect(records.at(-1)).toMatchObject({ result: "REFUSED", code: "BATCH_REFUSED" });
  });

  it("with the switch OFF, even an allowed trade is only recorded and refused", async () => {
    const { handler, signedTx, records } = tradeRig({ trading: false });
    const r = await handler.handle(session(), CHAIN, { method: "solana_signTransaction", params: { transaction: tradeTx("buy_v3", [1n, SOL / 20n]) } });
    expect(err(r).message).toMatch(/does not sign trades yet/);
    expect(signedTx).toHaveLength(0);
    expect(records.at(-1)).toMatchObject({ result: "REFUSED", code: "TRADING_NOT_ENABLED" });
  });
});
