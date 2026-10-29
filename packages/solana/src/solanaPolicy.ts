import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { InspectedInstruction, InspectedTransaction } from "./txInspect.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  associatedTokenAddress,
  decodePumpTrade,
  type PumpTrade,
} from "./pumpfun.js";
import { PUMPSWAP_PROGRAM_ID, decodePumpSwapTrade } from "./pumpswap.js";

/**
 * What the owner has allowed, in lamports (1 SOL = 1,000,000,000). The amounts are worked out from the wallet's balance
 * just before each trade, so they follow deposits and withdrawals.
 */
export interface SolanaLimits {
  maxBuyLamports: bigint;
  maxBuysPerDay: number;
  dailySpendLamports: bigint;
  cooldownSec: number;
  frozen: boolean;
}

/** What the day looks like so far, from the trade log. */
export interface SolanaState {
  buysToday: number;
  spentTodayLamports: bigint;
  /** Unix seconds of the last buy that was signed, or null. */
  lastBuyAtSec: number | null;
  balanceLamports: bigint;
  nowSec: number;
}

export interface SolanaPolicyConfig {
  /** The wallet itself: the only account that may pay, sign, or receive tokens. */
  wallet: string;
  /** SOL always kept back for fees and account rent, so a buy can never leave the wallet unable to sell. */
  gasReserveLamports: bigint;
  /** The most a transaction may pay as a priority fee. */
  maxPriorityFeeLamports: bigint;
}

export const DEFAULT_SOLANA_GAS_RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL
export const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n; // 0.01 SOL

export type SolanaRefusalCode =
  | "NOT_WALLET_PAYER"
  | "EXTRA_SIGNER"
  | "UNKNOWN_PROGRAM"
  | "UNKNOWN_INSTRUCTION"
  | "BAD_ACCOUNT"
  | "HIDDEN_ACCOUNT"
  | "PRIORITY_FEE"
  | "UNSUPPORTED_COIN"
  | "NO_TRADE"
  | "MULTIPLE_TRADES"
  | "FROZEN"
  | "MAX_BUY"
  | "MAX_BUYS_PER_DAY"
  | "DAILY_SPEND"
  | "COOLDOWN"
  | "INSUFFICIENT_SOL"
  | "LOSS_LIMIT"
  | "DRAWDOWN_LIMIT"
  | "POSITION_LIMIT"
  | "EXPOSURE_LIMIT"
  | "VALUE_UNAVAILABLE"
  | "WOULD_FAIL"
  | "TRADING_NOT_ENABLED";

export type SolanaDecision =
  | {
      ok: true;
      kind: "buy" | "sell";
      mint: string;
      /** SOL (lamports) the buy may cost at most. Zero for a sell. */
      spendLamports: bigint;
      /** Tokens a buy asks for / a sell gives up. */
      tokenAmount: bigint;
      minSolOut: bigint;
      summary: string;
    }
  | { ok: false; code: SolanaRefusalCode; message: string };

const sol = (lamports: bigint): string => `${(Number(lamports) / LAMPORTS_PER_SOL).toLocaleString(undefined, { maximumFractionDigits: 6 })} SOL`;
const refuse = (code: SolanaRefusalCode, message: string): SolanaDecision => ({ ok: false, code, message });
const short = (key: string): string => `${key.slice(0, 4)}…${key.slice(-4)}`;

/** The priority fee a Compute Budget instruction sets: price (micro-lamports per unit) times the unit limit. */
function priorityFeeLamports(instructions: readonly InspectedInstruction[]): bigint {
  let units: bigint | undefined;
  let microLamports = 0n;
  for (const ix of instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) continue;
    const data = Buffer.from(ix.dataHex, "hex");
    if (data[0] === 2 && data.length >= 5) units = BigInt(data.readUInt32LE(1));
    if (data[0] === 3 && data.length >= 9) microLamports = data.readBigUInt64LE(1);
  }
  if (microLamports === 0n) return 0n;
  // With no limit set a transaction may use up to the network maximum.
  return (microLamports * (units ?? 1_400_000n)) / 1_000_000n;
}

/** The wallet's own wrapped-SOL account. PumpSwap pays for a buy from it and pays a sale into it. */
const wrappedSolAccount = (wallet: string): string => associatedTokenAddress(wallet, TOKEN_PROGRAM_ID, WSOL_MINT);

/** Checks one non-trade instruction. Returns a refusal, or null if it is harmless and expected. */
function checkSupportingInstruction(ix: InspectedInstruction, wallet: string): SolanaDecision | null {
  const data = Buffer.from(ix.dataHex, "hex");
  const keys = ix.accounts.map((a) => a.pubkey);
  switch (ix.programId) {
    case SYSTEM_PROGRAM_ID: {
      // Only one move is allowed: wrapping SOL, i.e. a transfer (2) from the wallet into its own wrapped-SOL account.
      if (data.length !== 12 || data.readUInt32LE(0) !== 2) return refuse("UNKNOWN_INSTRUCTION", "That system instruction is not one this wallet allows.");
      const [from, to] = keys;
      if (!from || !to || from.startsWith("lookup:") || to.startsWith("lookup:")) return refuse("HIDDEN_ACCOUNT", "A transfer hides an account that must be checked.");
      if (from !== wallet || to !== wrappedSolAccount(wallet)) {
        return refuse("BAD_ACCOUNT", `This transaction would send SOL to ${short(to)}. This wallet only moves SOL into its own wrapped-SOL account.`);
      }
      return null;
    }
    case TOKEN_PROGRAM_ID:
    case TOKEN_2022_PROGRAM_ID: {
      if (keys.some((k) => k.startsWith("lookup:"))) return refuse("HIDDEN_ACCOUNT", "A token instruction hides an account that must be checked.");
      // Sync native (17): counts SOL just moved into the wrapped-SOL account. Harmless, but only on the wallet's own.
      if (data.length === 1 && data[0] === 17 && ix.programId === TOKEN_PROGRAM_ID) {
        return keys[0] === wrappedSolAccount(wallet) ? null : refuse("BAD_ACCOUNT", "That wrapped-SOL step is on an account that is not this wallet's own.");
      }
      // Close account (9): [account, destination, owner]. Unwraps SOL, or returns an empty account's rent. Whatever the
      // account held goes to the destination, so that must be the wallet; the owner signing must be the wallet too.
      if (data.length === 1 && data[0] === 9) {
        const [account, destination, owner] = keys;
        if (!account || !destination || !owner) return refuse("UNKNOWN_INSTRUCTION", "That close-account step is missing accounts.");
        if (destination !== wallet || owner !== wallet) return refuse("BAD_ACCOUNT", `Closing that token account would pay what it holds to ${short(destination)}, not this wallet.`);
        return null;
      }
      return refuse("UNKNOWN_INSTRUCTION", "That token instruction is not one this wallet allows. It does not move tokens anywhere outside a trade.");
    }
    case COMPUTE_BUDGET_PROGRAM_ID:
      // 1 request heap frame, 2 set unit limit, 3 set unit price, 4 set loaded accounts size limit.
      return data[0] !== undefined && [1, 2, 3, 4].includes(data[0]) ? null : refuse("UNKNOWN_INSTRUCTION", "That compute-budget instruction is not one this wallet allows.");
    case MEMO_PROGRAM_ID:
      return data.length <= 566 ? null : refuse("UNKNOWN_INSTRUCTION", "That memo is too long to be expected.");
    case ASSOCIATED_TOKEN_PROGRAM_ID: {
      // create (no data, or 0) / create idempotent (1): [payer, token account, owner, mint, system program, token program].
      if (data.length > 1 || (data.length === 1 && data[0] !== 0 && data[0] !== 1)) {
        return refuse("UNKNOWN_INSTRUCTION", "That token-account instruction is not one this wallet allows.");
      }
      const [payer, account, owner, mint, , tokenProgram] = ix.accounts.map((a) => a.pubkey);
      if (!payer || !account || !owner || !mint || !tokenProgram || [payer, account, owner, mint, tokenProgram].some((k) => k.startsWith("lookup:"))) {
        return refuse("HIDDEN_ACCOUNT", "A token-account instruction hides an account that must be checked.");
      }
      if (payer !== wallet || owner !== wallet) return refuse("BAD_ACCOUNT", "A token account would be created for someone other than this wallet.");
      if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(tokenProgram)) return refuse("BAD_ACCOUNT", "A token account would be created under an unexpected token program.");
      if (account !== associatedTokenAddress(wallet, tokenProgram, mint)) return refuse("BAD_ACCOUNT", "A token account would be created at an address that is not this wallet's own.");
      return null;
    }
    default:
      return refuse("UNKNOWN_PROGRAM", `This wallet only trades on pump.fun and PumpSwap. It does not sign steps that call ${short(ix.programId)}${ix.programName ? ` (${ix.programName})` : ""}.`);
  }
}

/** Reads a trade from either of pump.fun's programs, or returns undefined for any other instruction. */
function decodeAnyTrade(ix: InspectedInstruction): PumpTrade | undefined {
  return ix.programId === PUMP_PROGRAM_ID ? decodePumpTrade(ix) : decodePumpSwapTrade(ix);
}

/**
 * Judges one transaction a Solana site asked the wallet to sign, BEFORE anything is signed.
 *
 * Passes only a transaction that: is paid for and signed by the wallet alone; contains exactly one buy or sell of a
 * SOL-paired coin, on pump.fun's bonding curve or (once the coin has graduated) on PumpSwap, whose tokens go to (or come
 * from) the wallet's own token account and whose SOL comes from (or goes to) the wallet itself; and whose other steps are
 * only compute-budget settings, creating the wallet's own token account, wrapping and unwrapping SOL in the wallet's own
 * wrapped-SOL account, and memos. Anything else, including any transfer of SOL or tokens to another address, is refused.
 *
 * A sell is never blocked by a limit or a freeze: getting out must always be possible.
 */
export function checkSolanaTransaction(tx: InspectedTransaction, limits: SolanaLimits, state: SolanaState, config: SolanaPolicyConfig): SolanaDecision {
  if (tx.feePayer !== config.wallet) return refuse("NOT_WALLET_PAYER", `This transaction is paid for by ${short(tx.feePayer)}, not by this wallet.`);
  const others = tx.requiredSigners.filter((s) => s !== config.wallet);
  if (others.length > 0) return refuse("EXTRA_SIGNER", `This transaction also needs ${short(others[0]!)} to sign, which this wallet will not take part in.`);

  let trade: PumpTrade | undefined;
  for (const ix of tx.instructions) {
    if (ix.programId === PUMP_PROGRAM_ID || ix.programId === PUMPSWAP_PROGRAM_ID) {
      const venue = ix.programId === PUMP_PROGRAM_ID ? "pump.fun" : "PumpSwap";
      let decoded: PumpTrade | undefined;
      try {
        decoded = decodeAnyTrade(ix);
      } catch (error) {
        return refuse("HIDDEN_ACCOUNT", error instanceof Error ? error.message : `A ${venue} step could not be read.`);
      }
      if (!decoded) return refuse("UNKNOWN_INSTRUCTION", `That ${venue} call is not a buy or a sell, so it was not signed.`);
      if (trade) return refuse("MULTIPLE_TRADES", "This transaction holds more than one trade. Send them one at a time.");
      trade = decoded;
      continue;
    }
    const problem = checkSupportingInstruction(ix, config.wallet);
    if (problem) return problem;
  }
  if (!trade) return refuse("NO_TRADE", "This transaction does not contain a pump.fun or PumpSwap buy or sell, so it was not signed.");

  if (trade.user !== config.wallet) return refuse("BAD_ACCOUNT", "The trade would be made by an account that is not this wallet.");
  if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(trade.tokenProgram)) return refuse("BAD_ACCOUNT", "The coin uses a token program this wallet does not recognise.");
  if (trade.associatedUser !== associatedTokenAddress(config.wallet, trade.tokenProgram, trade.mint)) {
    return refuse("BAD_ACCOUNT", `The tokens would ${trade.kind === "buy" ? "go to" : "come from"} an account that is not this wallet's own.`);
  }
  // Newer instructions name the coin's quote asset: only SOL-paired coins are traded (the zero key means SOL on older
  // pump.fun coins; a PumpSwap pool always names a real mint). A pool whose base is SOL is the wrong way round: its "buy"
  // would spend the coin to get SOL.
  const solQuote = trade.quoteMint === WSOL_MINT || (trade.venue === "pump.fun" && trade.quoteMint === SYSTEM_PROGRAM_ID);
  if ((trade.quoteMint !== undefined && !solQuote) || trade.mint === WSOL_MINT) {
    return refuse("UNSUPPORTED_COIN", "This coin is paired with something other than SOL, which this wallet does not trade.");
  }
  // When the quote is wrapped SOL, the instruction names the token account the SOL comes from (buy) or goes to (sell):
  // it must be the wallet's own, or a sale could pay a stranger.
  if (trade.quoteMint === WSOL_MINT) {
    if (trade.quoteTokenProgram !== TOKEN_PROGRAM_ID || trade.quoteUser !== wrappedSolAccount(config.wallet)) {
      return refuse("BAD_ACCOUNT", `The SOL would ${trade.kind === "buy" ? "be paid from" : "be paid to"} an account that is not this wallet's own.`);
    }
  }

  const fee = priorityFeeLamports(tx.instructions);
  if (fee > config.maxPriorityFeeLamports) {
    return refuse("PRIORITY_FEE", `This transaction would pay a priority fee of ${sol(fee)}, more than the ${sol(config.maxPriorityFeeLamports)} this wallet allows.`);
  }

  if (trade.kind === "sell") {
    return { ok: true, kind: "sell", mint: trade.mint, spendLamports: 0n, tokenAmount: trade.tokenAmount, minSolOut: trade.minSolOut, summary: `sell ${short(trade.mint)} on ${trade.venue}` };
  }

  // BUY. Limits apply in a fixed order so the message names the first one hit. The spend counts the priority fee too.
  const spend = trade.spendLamports + fee;
  if (limits.frozen) return refuse("FROZEN", "Buying is paused for this wallet. Selling still works.");
  if (spend > limits.maxBuyLamports) {
    return refuse("MAX_BUY", `That buy can cost up to ${sol(spend)}. Your limit per buy is ${sol(limits.maxBuyLamports)}. Lower the amount.`);
  }
  if (state.buysToday >= limits.maxBuysPerDay) {
    return refuse("MAX_BUYS_PER_DAY", `You have used all ${limits.maxBuysPerDay} buys allowed today. Selling still works.`);
  }
  if (state.spentTodayLamports + spend > limits.dailySpendLamports) {
    const left = limits.dailySpendLamports > state.spentTodayLamports ? limits.dailySpendLamports - state.spentTodayLamports : 0n;
    return refuse("DAILY_SPEND", `That would pass your daily limit of ${sol(limits.dailySpendLamports)}. You have ${sol(left)} left today.`);
  }
  if (limits.cooldownSec > 0 && state.lastBuyAtSec !== null && state.nowSec - state.lastBuyAtSec < limits.cooldownSec) {
    const wait = limits.cooldownSec - (state.nowSec - state.lastBuyAtSec);
    return refuse("COOLDOWN", `Cooldown: wait ${wait}s before the next buy.`);
  }
  if (state.balanceLamports < spend + config.gasReserveLamports) {
    return refuse("INSUFFICIENT_SOL", `That buy needs ${sol(spend)} plus ${sol(config.gasReserveLamports)} kept for fees, and the wallet holds ${sol(state.balanceLamports)}.`);
  }
  return { ok: true, kind: "buy", mint: trade.mint, spendLamports: spend, tokenAmount: trade.tokenAmount, minSolOut: 0n, summary: `buy ${short(trade.mint)} on ${trade.venue}` };
}
