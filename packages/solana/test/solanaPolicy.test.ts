import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_INSTRUCTIONS,
  PUMP_PROGRAM_ID,
  PUMPSWAP_INSTRUCTIONS,
  PUMPSWAP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  associatedTokenAddress,
  checkSolanaTransaction,
  decodePumpSwapTrade,
  decodePumpTrade,
  inspectTransaction,
  type SolanaLimits,
  type SolanaPolicyConfig,
  type SolanaState,
} from "../src/index.js";

const SOL = 1_000_000_000n;
const wallet = Keypair.generate();
const W = wallet.publicKey.toBase58();
const mint = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

const ata = (owner = W, program = TOKEN_2022_PROGRAM_ID) => new PublicKey(associatedTokenAddress(owner, program, mint.toBase58()));
const ACCOUNT_COUNT: Record<string, number> = { buy: 16, buy_exact_sol_in: 16, buy_v2: 27, buy_v3: 17, buy_exact_quote_in_v2: 27, buy_exact_quote_in_v3: 17, sell: 14, sell_v2: 26, sell_v3: 17 };

/** A pump.fun trade built to the real instruction layout (account positions from the IDL). */
type TradeOver = { user?: PublicKey; associatedUser?: PublicKey; tokenProgram?: string; quoteMint?: string; quoteUser?: PublicKey; quoteTokenProgram?: string; u64?: bigint[]; mint?: PublicKey };

function pumpIx(name: string, over: TradeOver = {}): TransactionInstruction {
  return tradeIx(PUMP_PROGRAM_ID, PUMP_INSTRUCTIONS, ACCOUNT_COUNT, name, over);
}

const wsolAta = (owner = W) => new PublicKey(associatedTokenAddress(owner, TOKEN_PROGRAM_ID, WSOL_MINT));

/** A trade on either of pump.fun's programs, built to that program's real instruction layout. */
function tradeIx(programId: string, table: typeof PUMP_INSTRUCTIONS, counts: Record<string, number>, name: string, over: TradeOver = {}): TransactionInstruction {
  const entry = Object.entries(table).find(([, l]) => l.name === name)!;
  const [disc, layout] = entry;
  const keys = Array.from({ length: counts[name]! }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  const set = (index: number, pubkey: PublicKey, isSigner = false) => {
    if (index >= 0) keys[index] = { pubkey, isSigner, isWritable: true };
  };
  const user = over.user ?? wallet.publicKey;
  const tokenProgram = over.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const theMint = over.mint ?? mint;
  set(layout.accounts.user, user, true);
  set(layout.accounts.mint, theMint);
  set(layout.accounts.tokenProgram, new PublicKey(tokenProgram));
  set(layout.accounts.associatedUser, over.associatedUser ?? new PublicKey(associatedTokenAddress(user.toBase58(), tokenProgram, theMint.toBase58())));
  if (layout.accounts.quoteMint >= 0) set(layout.accounts.quoteMint, new PublicKey(over.quoteMint ?? WSOL_MINT));
  set(layout.accounts.quoteTokenProgram, new PublicKey(over.quoteTokenProgram ?? TOKEN_PROGRAM_ID));
  set(layout.accounts.quoteUser, over.quoteUser ?? wsolAta(user.toBase58()));
  const args = over.u64 ?? (layout.kind === "buy" ? [1_000_000n, SOL / 10n] : [1_000_000n, 0n]);
  const data = Buffer.alloc(8 + 8 * args.length + 2);
  Buffer.from(disc, "hex").copy(data);
  args.forEach((v, i) => data.writeBigUInt64LE(v, 8 + 8 * i));
  return new TransactionInstruction({ programId: new PublicKey(programId), keys, data });
}

const createAta = (owner = wallet.publicKey, payer = wallet.publicKey, account = ata(), program = TOKEN_2022_PROGRAM_ID, theMint = mint) =>
  new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: theMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(program), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

const tx = (instructions: TransactionInstruction[], payer = wallet.publicKey) =>
  inspectTransaction(Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message()).serialize()).toString("base64"));

const limits = (over: Partial<SolanaLimits> = {}): SolanaLimits => ({ maxBuyLamports: SOL / 4n, maxBuysPerDay: 5, dailySpendLamports: SOL / 2n, cooldownSec: 0, frozen: false, ...over });
const state = (over: Partial<SolanaState> = {}): SolanaState => ({ buysToday: 0, spentTodayLamports: 0n, lastBuyAtSec: null, balanceLamports: SOL, nowSec: 1_000_000, ...over });
const config: SolanaPolicyConfig = { wallet: W, gasReserveLamports: SOL / 100n, maxPriorityFeeLamports: SOL / 100n };
const check = (t: ReturnType<typeof tx>, l = limits(), s = state()) => checkSolanaTransaction(t, l, s, config);

describe("reading pump.fun trades from their real layouts", () => {
  it.each(Object.values(PUMP_INSTRUCTIONS).map((l) => l.name))("decodes %s: mint, user, token account, amounts", (name) => {
    const t = tx([pumpIx(name, { u64: [111n, 222n] })]);
    const trade = decodePumpTrade(t.instructions[0]!)!;
    expect(trade).toMatchObject({ instruction: name, mint: mint.toBase58(), user: W, associatedUser: ata().toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID });
    if (trade.kind === "buy") {
      expect(trade.tokenAmount).toBe(name.includes("exact") ? 222n : 111n);
      expect(trade.spendLamports).toBe(name.includes("exact") ? 111n : 222n);
    } else {
      expect(trade).toMatchObject({ tokenAmount: 111n, minSolOut: 222n, spendLamports: 0n });
    }
  });

  it("returns nothing for a pump.fun call that is not a trade, and for other programs", () => {
    const other = new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM_ID), keys: [], data: Buffer.from("0102030405060708", "hex") });
    expect(decodePumpTrade(tx([other]).instructions[0]!)).toBeUndefined();
    expect(decodePumpTrade(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 5 })]).instructions[0]!)).toBeUndefined();
  });
});

describe("a transaction that is allowed", () => {
  it.each(["buy", "buy_v2", "buy_v3", "buy_exact_quote_in_v2", "buy_exact_sol_in"])("passes a %s inside the limits", (name) => {
    const d = check(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), createAta(), pumpIx(name, { u64: [5n, SOL / 10n] })]));
    expect(d).toMatchObject({ ok: true, kind: "buy", mint: mint.toBase58() });
  });

  it("counts the priority fee in what a buy spends", () => {
    const d = check(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000_000 }), pumpIx("buy_v2", { u64: [5n, SOL / 10n] })]));
    expect(d).toMatchObject({ ok: true, spendLamports: SOL / 10n + 2_000_000n });
  });

  it("passes a sell, even when buying is paused and the wallet has no SOL", () => {
    const d = check(tx([pumpIx("sell_v2", { u64: [1000n, 0n] })]), limits({ frozen: true }), state({ balanceLamports: 0n, buysToday: 99, spentTodayLamports: 99n * SOL }));
    expect(d).toMatchObject({ ok: true, kind: "sell", spendLamports: 0n, tokenAmount: 1000n });
  });

  it("passes the older token program as well as Token-2022", () => {
    expect(check(tx([pumpIx("buy", { tokenProgram: TOKEN_PROGRAM_ID })])).ok).toBe(true);
  });

  it("allows a memo", () => {
    const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("hi") });
    expect(check(tx([memo, pumpIx("buy_v3")])).ok).toBe(true);
  });
});

describe("a transaction that is refused", () => {
  const code = (t: ReturnType<typeof tx>, l?: SolanaLimits, s?: SolanaState) => {
    const d = check(t, l, s);
    return d.ok ? "OK" : d.code;
  };

  it("when someone else pays or must sign", () => {
    expect(code(tx([pumpIx("buy_v3", { user: stranger })], stranger))).toBe("NOT_WALLET_PAYER");
    const extra = new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM_ID), keys: [{ pubkey: stranger, isSigner: true, isWritable: false }], data: Buffer.alloc(8) });
    expect(code(tx([pumpIx("buy_v3"), extra]))).toBe("EXTRA_SIGNER");
  });

  it("when the tokens would go to, or come from, an account that is not the wallet's own", () => {
    expect(code(tx([pumpIx("buy_v2", { associatedUser: ata(stranger.toBase58()) })]))).toBe("BAD_ACCOUNT");
    expect(code(tx([pumpIx("sell_v3", { associatedUser: ata(stranger.toBase58()) })]))).toBe("BAD_ACCOUNT");
    // A trade made by someone else also needs that someone to sign, which is refused first.
    expect(code(tx([pumpIx("buy", { user: stranger })]))).toBe("EXTRA_SIGNER");
  });

  it("when any SOL or tokens would be sent to another address", () => {
    const send = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: stranger, lamports: 5n * SOL });
    expect(code(tx([send, pumpIx("buy_v3")]))).toBe("BAD_ACCOUNT");
    expect(code(tx([send]))).toBe("BAD_ACCOUNT");
  });

  it("when a pump.fun sale would pay its SOL into someone else's wrapped-SOL account", () => {
    expect(code(tx([pumpIx("sell_v2", { quoteUser: wsolAta(stranger.toBase58()) })]))).toBe("BAD_ACCOUNT");
    expect(code(tx([pumpIx("sell_v3", { quoteUser: stranger })]))).toBe("BAD_ACCOUNT");
    expect(code(tx([pumpIx("buy_v3", { quoteTokenProgram: TOKEN_2022_PROGRAM_ID })]))).toBe("BAD_ACCOUNT");
  });

  it("when it calls a program other than pump.fun's", () => {
    const evil = new TransactionInstruction({ programId: stranger, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(4) });
    expect(code(tx([pumpIx("buy_v3"), evil]))).toBe("UNKNOWN_PROGRAM");
  });

  it("when it creates a token account for someone else, or at the wrong address, or is paid for by someone else", () => {
    expect(code(tx([createAta(stranger), pumpIx("buy_v3")]))).toBe("BAD_ACCOUNT");
    expect(code(tx([createAta(wallet.publicKey, wallet.publicKey, ata(stranger.toBase58())), pumpIx("buy_v3")]))).toBe("BAD_ACCOUNT");
    expect(code(tx([createAta(wallet.publicKey, stranger), pumpIx("buy_v3")]))).toBe("EXTRA_SIGNER");
  });

  it("when it has no trade, or several", () => {
    expect(code(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]))).toBe("NO_TRADE");
    expect(code(tx([pumpIx("buy_v3"), pumpIx("buy_v3")]))).toBe("MULTIPLE_TRADES");
  });

  it("when it is a pump.fun call that is not a buy or a sell", () => {
    const other = new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM_ID), keys: [], data: Buffer.from("0102030405060708", "hex") });
    expect(code(tx([other, pumpIx("buy_v3")]))).toBe("UNKNOWN_INSTRUCTION");
  });

  it("when the coin is not paired with SOL", () => {
    expect(code(tx([pumpIx("buy_v2", { quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })]))).toBe("UNSUPPORTED_COIN");
  });

  it("when the priority fee is too high", () => {
    expect(code(tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }), pumpIx("buy_v3")]))).toBe("PRIORITY_FEE");
    // No unit limit set: the network maximum is assumed.
    expect(code(tx([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }), pumpIx("buy_v3")]))).toBe("PRIORITY_FEE");
  });

  it("when a buy passes a limit, naming the first one hit", () => {
    const buy = (spendSol: bigint) => tx([pumpIx("buy_v3", { u64: [1n, spendSol] })]);
    expect(code(buy(SOL / 10n), limits({ frozen: true }))).toBe("FROZEN");
    expect(code(buy(SOL / 2n))).toBe("MAX_BUY");
    expect(code(buy(SOL / 10n), limits(), state({ buysToday: 5 }))).toBe("MAX_BUYS_PER_DAY");
    expect(code(buy(SOL / 4n), limits(), state({ spentTodayLamports: SOL / 3n }))).toBe("DAILY_SPEND");
    expect(code(buy(SOL / 10n), limits({ cooldownSec: 60 }), state({ lastBuyAtSec: 999_990 }))).toBe("COOLDOWN");
    expect(code(buy(SOL / 10n), limits(), state({ balanceLamports: SOL / 10n }))).toBe("INSUFFICIENT_SOL");
  });

  it("with a message a trader can read", () => {
    const d = check(tx([pumpIx("buy_v3", { u64: [1n, SOL / 2n] })]));
    expect(!d.ok && d.message).toMatch(/up to 0\.5 SOL.*0\.25 SOL/);
  });

  it("when an account that must be checked is hidden in a lookup table", () => {
    const t = tx([pumpIx("buy_v3")]);
    t.instructions[0]!.accounts[8] = { pubkey: "lookup:0", isSigner: false, isWritable: true };
    expect(check(t)).toMatchObject({ ok: false, code: "HIDDEN_ACCOUNT" });
  });
});

// PumpSwap: where a coin trades once it has graduated from the curve. Account counts from idl/pump_amm.json.
const SWAP_ACCOUNT_COUNT: Record<string, number> = { buy: 23, buy_exact_quote_in: 23, buy_v2: 17, buy_exact_quote_in_v2: 17, sell: 21, sell_v2: 17 };
const swapIx = (name: string, over: TradeOver = {}) => tradeIx(PUMPSWAP_PROGRAM_ID, PUMPSWAP_INSTRUCTIONS, SWAP_ACCOUNT_COUNT, name, over);

/** The steps a site wraps a PumpSwap trade in: SOL moved into the wallet's wrapped-SOL account, counted, and unwrapped after. */
const wrapSol = (lamports: bigint, to = wsolAta()) => SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports });
const syncNative = (account = wsolAta()) =>
  new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM_ID), keys: [{ pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
const closeAccount = (account = wsolAta(), destination = wallet.publicKey, owner = wallet.publicKey, program = TOKEN_PROGRAM_ID) =>
  new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
const createWsolAta = () => createAta(wallet.publicKey, wallet.publicKey, wsolAta(), TOKEN_PROGRAM_ID, new PublicKey(WSOL_MINT));

describe("reading PumpSwap trades from their real layouts", () => {
  it.each(Object.values(PUMPSWAP_INSTRUCTIONS).map((l) => l.name))("decodes %s: coin, user, token accounts, amounts", (name) => {
    const t = tx([swapIx(name, { u64: [111n, 222n] })]);
    const trade = decodePumpSwapTrade(t.instructions[0]!)!;
    expect(trade).toMatchObject({ venue: "PumpSwap", instruction: name, mint: mint.toBase58(), user: W, associatedUser: ata().toBase58(), tokenProgram: TOKEN_2022_PROGRAM_ID });
    expect(trade).toMatchObject({ quoteMint: WSOL_MINT, quoteUser: wsolAta().toBase58(), quoteTokenProgram: TOKEN_PROGRAM_ID });
    if (trade.kind === "buy") {
      expect(trade.tokenAmount).toBe(name.includes("exact") ? 222n : 111n);
      expect(trade.spendLamports).toBe(name.includes("exact") ? 111n : 222n);
    } else {
      expect(trade).toMatchObject({ tokenAmount: 111n, minSolOut: 222n, spendLamports: 0n });
    }
  });

  it("is never read with pump.fun's table, although the two share discriminators", () => {
    expect(decodePumpTrade(tx([swapIx("buy")]).instructions[0]!)).toBeUndefined();
    expect(decodePumpSwapTrade(tx([pumpIx("buy")]).instructions[0]!)).toBeUndefined();
  });
});

describe("a PumpSwap transaction that is allowed", () => {
  it("passes a buy as a site sends it: wrap SOL, buy, unwrap what is left", () => {
    const d = check(
      tx([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        createAta(),
        createWsolAta(),
        wrapSol(SOL / 10n),
        syncNative(),
        swapIx("buy", { u64: [5n, SOL / 10n] }),
        closeAccount(),
      ]),
    );
    expect(d).toMatchObject({ ok: true, kind: "buy", mint: mint.toBase58(), spendLamports: SOL / 10n + 200n, summary: expect.stringMatching(/on PumpSwap$/) });
  });

  it.each(["buy", "buy_v2", "buy_exact_quote_in", "buy_exact_quote_in_v2"])("passes a %s inside the limits", (name) => {
    expect(check(tx([wrapSol(SOL / 10n), syncNative(), swapIx(name, { u64: [5n, SOL / 10n] }), closeAccount()]))).toMatchObject({ ok: true, kind: "buy" });
  });

  it.each(["sell", "sell_v2"])("passes a %s, even when buying is paused and the wallet has no SOL", (name) => {
    const d = check(tx([swapIx(name, { u64: [1000n, 0n] }), closeAccount()]), limits({ frozen: true }), state({ balanceLamports: 0n, buysToday: 99, spentTodayLamports: 99n * SOL }));
    expect(d).toMatchObject({ ok: true, kind: "sell", tokenAmount: 1000n, summary: expect.stringMatching(/on PumpSwap$/) });
  });

  it("lets a sale close the wallet's own emptied coin account, returning its rent to the wallet", () => {
    expect(check(tx([swapIx("sell_v2"), closeAccount(), closeAccount(ata(), wallet.publicKey, wallet.publicKey, TOKEN_2022_PROGRAM_ID)])).ok).toBe(true);
  });
});

describe("a PumpSwap transaction that is refused", () => {
  const code = (t: ReturnType<typeof tx>, l?: SolanaLimits, s?: SolanaState) => {
    const d = check(t, l, s);
    return d.ok ? "OK" : d.code;
  };

  it("when a buy passes a limit, the same limits as on the curve", () => {
    const buy = (spend: bigint) => tx([wrapSol(spend), syncNative(), swapIx("buy_v2", { u64: [1n, spend] })]);
    expect(code(buy(SOL / 10n), limits({ frozen: true }))).toBe("FROZEN");
    expect(code(buy(SOL / 2n))).toBe("MAX_BUY");
    expect(code(buy(SOL / 10n), limits(), state({ buysToday: 5 }))).toBe("MAX_BUYS_PER_DAY");
    expect(code(buy(SOL / 4n), limits(), state({ spentTodayLamports: SOL / 3n }))).toBe("DAILY_SPEND");
    expect(code(buy(SOL / 10n), limits({ cooldownSec: 60 }), state({ lastBuyAtSec: 999_990 }))).toBe("COOLDOWN");
    expect(code(buy(SOL / 10n), limits(), state({ balanceLamports: SOL / 10n }))).toBe("INSUFFICIENT_SOL");
  });

  it("when a sale would pay its SOL to someone else, or the coins would go to someone else", () => {
    expect(code(tx([swapIx("sell", { quoteUser: wsolAta(stranger.toBase58()) })]))).toBe("BAD_ACCOUNT");
    expect(code(tx([swapIx("sell_v2", { quoteUser: stranger })]))).toBe("BAD_ACCOUNT");
    expect(code(tx([swapIx("buy", { associatedUser: ata(stranger.toBase58()) })]))).toBe("BAD_ACCOUNT");
    expect(code(tx([swapIx("buy_v2", { quoteTokenProgram: TOKEN_2022_PROGRAM_ID })]))).toBe("BAD_ACCOUNT");
  });

  it("when the pool is not a coin against SOL, or is the wrong way round", () => {
    expect(code(tx([swapIx("buy", { quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })]))).toBe("UNSUPPORTED_COIN");
    // The zero key stands for SOL only on pump.fun's older curve instructions, never in a PumpSwap pool.
    expect(code(tx([swapIx("buy", { quoteMint: SystemProgram.programId.toBase58() })]))).toBe("UNSUPPORTED_COIN");
    expect(code(tx([swapIx("sell", { mint: new PublicKey(WSOL_MINT), tokenProgram: TOKEN_PROGRAM_ID })]))).toBe("UNSUPPORTED_COIN");
  });

  it("when it is a PumpSwap call that is not a plain buy or sell (a multi-hop route, a deposit, ...)", () => {
    const multiHop = new TransactionInstruction({ programId: new PublicKey(PUMPSWAP_PROGRAM_ID), keys: [], data: Buffer.from("2b644913e9f66f94" + "00".repeat(16), "hex") });
    expect(code(tx([multiHop]))).toBe("UNKNOWN_INSTRUCTION");
    // Two full trades with these test accounts would not fit in one transaction, so the second is added after reading.
    const twice = (first: TransactionInstruction, second: TransactionInstruction) => {
      const t = tx([first]);
      t.instructions.push(tx([second]).instructions[0]!);
      return t;
    };
    expect(code(twice(swapIx("buy"), swapIx("sell")))).toBe("MULTIPLE_TRADES");
    expect(code(twice(pumpIx("buy_v3"), swapIx("buy")))).toBe("MULTIPLE_TRADES");
  });

  it("when an account that must be checked is hidden in a lookup table", () => {
    const t = tx([swapIx("sell_v2")]);
    t.instructions[0]!.accounts[6] = { pubkey: "lookup:0", isSigner: false, isWritable: true };
    expect(check(t)).toMatchObject({ ok: false, code: "HIDDEN_ACCOUNT" });
  });
});

describe("wrapping and unwrapping SOL", () => {
  const code = (t: ReturnType<typeof tx>) => {
    const d = check(t);
    return d.ok ? "OK" : d.code;
  };

  it("only ever into the wallet's own wrapped-SOL account", () => {
    expect(code(tx([wrapSol(SOL / 10n, wsolAta(stranger.toBase58())), swapIx("buy")]))).toBe("BAD_ACCOUNT");
    // The wallet's own account for the coin is not its wrapped-SOL account: SOL sent there would be stuck.
    expect(code(tx([wrapSol(SOL / 10n, ata()), swapIx("buy")]))).toBe("BAD_ACCOUNT");
    expect(code(tx([syncNative(wsolAta(stranger.toBase58())), swapIx("buy")]))).toBe("BAD_ACCOUNT");
  });

  it("and an account is only ever closed into the wallet", () => {
    expect(code(tx([swapIx("sell"), closeAccount(wsolAta(), stranger)]))).toBe("BAD_ACCOUNT");
    // Closing on someone else's authority needs them to sign, which is refused first.
    expect(code(tx([swapIx("sell"), closeAccount(wsolAta(), wallet.publicKey, stranger)]))).toBe("EXTRA_SIGNER");
  });

  it("with no other system or token instruction allowed alongside", () => {
    const create = SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: wallet.publicKey, lamports: 1, space: 0, programId: stranger });
    expect(code(tx([create, swapIx("buy")]))).toBe("UNKNOWN_INSTRUCTION");
    const transferChecked = Buffer.alloc(10);
    transferChecked[0] = 12;
    const sendTokens = new TransactionInstruction({
      programId: new PublicKey(TOKEN_2022_PROGRAM_ID),
      keys: [ata(), mint, ata(stranger.toBase58()), wallet.publicKey].map((pubkey, i) => ({ pubkey, isSigner: i === 3, isWritable: i !== 1 && i !== 3 })),
      data: transferChecked,
    });
    expect(code(tx([swapIx("sell"), sendTokens]))).toBe("UNKNOWN_INSTRUCTION");
  });

  it("but a wrap alone is still not a trade", () => {
    expect(code(tx([wrapSol(SOL / 10n), syncNative()]))).toBe("NO_TRADE");
  });
});
