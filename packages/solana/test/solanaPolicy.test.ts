import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_INSTRUCTIONS,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  associatedTokenAddress,
  checkSolanaTransaction,
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
function pumpIx(
  name: string,
  over: { user?: PublicKey; associatedUser?: PublicKey; tokenProgram?: string; quoteMint?: string; u64?: bigint[]; mint?: PublicKey } = {},
): TransactionInstruction {
  const entry = Object.entries(PUMP_INSTRUCTIONS).find(([, l]) => l.name === name)!;
  const [disc, layout] = entry;
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
  set(layout.accounts.associatedUser, over.associatedUser ?? new PublicKey(associatedTokenAddress(user.toBase58(), tokenProgram, theMint.toBase58())));
  if (layout.accounts.quoteMint >= 0) set(layout.accounts.quoteMint, new PublicKey(over.quoteMint ?? WSOL_MINT));
  const args = over.u64 ?? (layout.kind === "buy" ? [1_000_000n, SOL / 10n] : [1_000_000n, 0n]);
  const data = Buffer.alloc(8 + 8 * args.length + 2);
  Buffer.from(disc, "hex").copy(data);
  args.forEach((v, i) => data.writeBigUInt64LE(v, 8 + 8 * i));
  return new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM_ID), keys, data });
}

const createAta = (owner = wallet.publicKey, payer = wallet.publicKey, account = ata(), program = TOKEN_2022_PROGRAM_ID) =>
  new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
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
    expect(code(tx([send, pumpIx("buy_v3")]))).toBe("UNKNOWN_PROGRAM");
    expect(code(tx([send]))).toBe("UNKNOWN_PROGRAM");
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
