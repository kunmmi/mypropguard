import { decodeFunctionData, formatEther, getAddress, isAddressEqual, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from "viem";
import { FOUR_MEME_BSC, HELPER3_ABI, MAX_ROUTER_FEE_RATE, TOKEN_MANAGER_V1_ABI, TOKEN_MANAGER_V2_ABI } from "./fourMeme.js";

/**
 * THE RULES OF THE TRADING WALLET ("float" wallet).
 *
 * A plain wallet has no on-chain rules, so for a site that logs in with a signature (four.meme) the protection runs
 * HERE, in the server, in front of the signature: every transaction the site proposes is judged by this function
 * before anything is signed. It is pure (no network, no clock of its own) so every rule can be tested exhaustively.
 *
 * What the rules guarantee, and what they do not:
 *  - the site can spend BNB only inside the owner's limits, and only through four.meme's own contracts;
 *  - nothing a site proposes can send BNB or tokens to a stranger, or approve anyone but four.meme's contracts;
 *  - SELLS ARE NEVER BLOCKED, so the trader can always get out;
 *  - they do NOT stop a compromised server. The float is the ceiling on what that could cost, which is why the owner
 *    chooses it and keeps the rest in their Safe.
 */

export interface FloatLimits {
  /** The most one buy may spend, in wei of BNB. */
  maxBuyWei: bigint;
  /** The most buys allowed in one UTC day. */
  maxBuysPerDay: number;
  /** The most BNB all buys together may spend in one UTC day. */
  dailySpendWei: bigint;
  /** Minimum seconds between two buys (0 = none). */
  cooldownSec: number;
  /** When true no buy is allowed (selling still is). Set by the owner, or when the daily budget runs out. */
  frozen: boolean;
}

/** What the day looks like so far. Computed from the trade log, so it survives a restart. */
export interface FloatState {
  buysToday: number;
  spentTodayWei: bigint;
  /** Unix seconds of the last sent buy, or null. */
  lastBuyAtSec: number | null;
  /** The wallet's BNB right now. */
  balanceWei: bigint;
  nowSec: number;
}

export interface FloatPolicyConfig {
  /** The trading wallet itself: tokens may only ever be routed to it. */
  floatAddress: Address;
  /** BNB always kept back to pay gas, so a buy can never leave the wallet unable to sell. */
  gasReserveWei: bigint;
  /** Contracts the wallet may call, and which ABI decodes each. Defaults to four.meme on BNB Chain. */
  venues?: ReadonlyMap<string, { name: string; abi: Abi }>;
  /** Spenders an approval may name. Defaults to four.meme's managers. */
  approvalSpenders?: readonly Address[];
}

export interface FloatTx {
  to: Address;
  value: bigint;
  data: Hex;
}

export type FloatRefusalCode =
  | "FROZEN"
  | "MAX_BUY"
  | "MAX_BUYS_PER_DAY"
  | "DAILY_SPEND"
  | "COOLDOWN"
  | "INSUFFICIENT_FLOAT"
  | "UNKNOWN_DESTINATION"
  | "UNKNOWN_CALL"
  | "PLAIN_SEND"
  | "BAD_RECIPIENT"
  | "BAD_APPROVAL"
  | "BAD_FEE"
  | "SELL_WITH_VALUE";

export type FloatDecision =
  | {
      ok: true;
      kind: "buy" | "sell" | "approve";
      /** BNB this transaction spends (0 for sells and approvals). */
      spendWei: bigint;
      /** The meme token being bought, sold or approved, when the call names one. */
      token?: Address;
      /** A short description for the trader and the log. */
      summary: string;
    }
  | { ok: false; code: FloatRefusalCode; message: string };

const ZERO = "0x0000000000000000000000000000000000000000" as const;

function defaultVenues(): ReadonlyMap<string, { name: string; abi: Abi }> {
  return new Map([
    [FOUR_MEME_BSC.tokenManagerV2.toLowerCase(), { name: "four.meme", abi: TOKEN_MANAGER_V2_ABI as Abi }],
    [FOUR_MEME_BSC.tokenManagerV1.toLowerCase(), { name: "four.meme (older tokens)", abi: TOKEN_MANAGER_V1_ABI as Abi }],
    [FOUR_MEME_BSC.helper3.toLowerCase(), { name: "four.meme router", abi: HELPER3_ABI as Abi }],
  ]);
}

function defaultSpenders(): readonly Address[] {
  return [FOUR_MEME_BSC.tokenManagerV2, FOUR_MEME_BSC.tokenManagerV1, FOUR_MEME_BSC.helper3];
}

/** ERC-20 approve(address,uint256) and increaseAllowance(address,uint256). */
const APPROVE_SELECTORS = new Set(["0x095ea7b3", "0x39509351"]);

const bnb = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 })} BNB`;
const refuse = (code: FloatRefusalCode, message: string): FloatDecision => ({ ok: false, code, message });

/** True when `value` is an address argument that is either unset (the zero address) or the trading wallet itself. */
function isOwnOrUnset(value: unknown, floatAddress: Address): boolean {
  if (typeof value !== "string") return false;
  return value === ZERO || isAddressEqual(value as Address, floatAddress);
}

/** The first address argument named `token`, by position in the decoded call (every function here takes it). */
function tokenArg(args: readonly unknown[] | undefined, inputs: readonly { name?: string; type: string }[]): Address | undefined {
  if (!args) return undefined;
  const index = inputs.findIndex((input) => input.name === "token");
  const value = index >= 0 ? args[index] : undefined;
  return typeof value === "string" ? getAddress(value) : undefined;
}

function argByName(args: readonly unknown[] | undefined, inputs: readonly { name?: string }[], name: string): unknown {
  const index = inputs.findIndex((input) => input.name === name);
  return index >= 0 ? args?.[index] : undefined;
}

export function checkFloatTransaction(tx: FloatTx, limits: FloatLimits, state: FloatState, config: FloatPolicyConfig): FloatDecision {
  const venues = config.venues ?? defaultVenues();
  const spenders = config.approvalSpenders ?? defaultSpenders();
  const selector = tx.data.length >= 10 ? tx.data.slice(0, 10).toLowerCase() : "0x";

  // 1. Money can never leave to an arbitrary address because a site asked: no plain sends, no token transfers.
  if (tx.data === "0x" || tx.data.length < 10) {
    return refuse("PLAIN_SEND", "This wallet only trades. It will not send BNB to an address because a site asked.");
  }

  // 2. Approvals: to four.meme's own contracts only, sent to the token being approved.
  if (APPROVE_SELECTORS.has(selector)) {
    if (tx.value !== 0n) return refuse("BAD_APPROVAL", "An approval should not carry BNB. Refused.");
    const spender = tx.data.length >= 74 ? (`0x${tx.data.slice(34, 74)}` as Address) : undefined;
    if (!spender || !spenders.some((s) => isAddressEqual(s, spender))) {
      return refuse("BAD_APPROVAL", `This wallet only approves four.meme's own contracts, not ${spender ?? "an unknown address"}.`);
    }
    return { ok: true, kind: "approve", spendWei: 0n, token: getAddress(tx.to), summary: `approve four.meme to sell ${tx.to}` };
  }

  // 3. Everything else must be a known call on a known venue.
  const venue = venues.get(tx.to.toLowerCase());
  if (!venue) {
    return refuse("UNKNOWN_DESTINATION", `This wallet only trades on four.meme. ${tx.to} is not a contract it uses.`);
  }
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: venue.abi, data: tx.data });
  } catch {
    return refuse("UNKNOWN_CALL", `That call to ${venue.name} is not a buy or sell this wallet understands, so it was not signed.`);
  }
  // Overloads share a name (and sometimes an argument count), so the exact one is found by SELECTOR. Matching on name and
  // length picked the wrong overload for sellToken, and the recipient checks then read the wrong fields.
  const fn = (venue.abi as readonly AbiFunction[]).find((item) => item.type === "function" && toFunctionSelector(item) === selector);
  if (!fn) return refuse("UNKNOWN_CALL", `That call to ${venue.name} is not a buy or sell this wallet understands, so it was not signed.`);
  const inputs = fn.inputs;
  const isBuy = /^(buy|purchase)/i.test(decoded.functionName);
  const token = tokenArg(decoded.args, inputs);

  // 4. Tokens (and sale proceeds) may only ever go to this wallet.
  for (const field of ["to", "from"]) {
    const given = argByName(decoded.args, inputs, field);
    if (given !== undefined && !isOwnOrUnset(given, config.floatAddress)) {
      return refuse("BAD_RECIPIENT", `${field === "to" ? "Tokens or proceeds" : "The seller"} would be ${given}, not this wallet. Refused.`);
    }
  }

  if (!isBuy) {
    // SELL. Never blocked by a limit or a freeze: getting out must always be possible.
    if (tx.value !== 0n) return refuse("SELL_WITH_VALUE", "A sale should not carry BNB. Refused.");
    const feeRate = argByName(decoded.args, inputs, "feeRate");
    if (typeof feeRate === "bigint" && feeRate > BigInt(MAX_ROUTER_FEE_RATE)) {
      return refuse("BAD_FEE", `That sale takes a ${Number(feeRate) / 100}% cut for a third party. The limit is ${MAX_ROUTER_FEE_RATE / 100}%.`);
    }
    return { ok: true, kind: "sell", spendWei: 0n, token, summary: `sell on ${venue.name}` };
  }

  // 5. BUY. BNB sent is what is spent. Limits apply in a fixed order so the message names the first one hit.
  const spend = tx.value;
  if (limits.frozen) {
    return refuse("FROZEN", "Buying is switched off for this wallet (frozen). Selling still works.");
  }
  if (spend > limits.maxBuyWei) {
    return refuse("MAX_BUY", `That buy is ${bnb(spend)}. Your limit per buy is ${bnb(limits.maxBuyWei)}. Lower the amount.`);
  }
  if (state.buysToday >= limits.maxBuysPerDay) {
    return refuse("MAX_BUYS_PER_DAY", `You have used all ${limits.maxBuysPerDay} buys allowed today. Selling still works.`);
  }
  if (state.spentTodayWei + spend > limits.dailySpendWei) {
    const left = limits.dailySpendWei > state.spentTodayWei ? limits.dailySpendWei - state.spentTodayWei : 0n;
    return refuse("DAILY_SPEND", `That would pass your daily limit of ${bnb(limits.dailySpendWei)}. You have ${bnb(left)} left today.`);
  }
  if (limits.cooldownSec > 0 && state.lastBuyAtSec !== null && state.nowSec - state.lastBuyAtSec < limits.cooldownSec) {
    const wait = limits.cooldownSec - (state.nowSec - state.lastBuyAtSec);
    return refuse("COOLDOWN", `Cooldown: wait ${wait}s before the next buy.`);
  }
  if (spend + config.gasReserveWei > state.balanceWei) {
    return refuse(
      "INSUFFICIENT_FLOAT",
      `The wallet has ${bnb(state.balanceWei)}. A buy of ${bnb(spend)} would leave less than the ${bnb(config.gasReserveWei)} kept for fees. Add to your float.`,
    );
  }
  return { ok: true, kind: "buy", spendWei: spend, token, summary: `buy ${bnb(spend)} on ${venue.name}` };
}

/** The limits a new wallet starts with, derived from the float the owner chose. All of them can be changed. */
export function defaultLimitsForFloat(floatWei: bigint): Omit<FloatLimits, "frozen"> {
  return {
    maxBuyWei: floatWei / 4n, // no single buy may spend more than a quarter of the float
    maxBuysPerDay: 10,
    dailySpendWei: floatWei / 2n, // half the float per day at most
    cooldownSec: 0,
  };
}
