import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther, type Address, type Hex } from "viem";
import { FOUR_MEME_BSC, HELPER3_ABI, TOKEN_MANAGER_V1_ABI, TOKEN_MANAGER_V2_ABI } from "../src/fourMeme.js";
import { checkFloatTransaction, type FloatLimits, type FloatPolicyConfig, type FloatState } from "../src/floatPolicy.js";

const FLOAT = "0x1111111111111111111111111111111111111111" as Address;
const STRANGER = "0x9999999999999999999999999999999999999999" as Address;
const MEME = "0x2222222222222222222222222222222222222222" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const V2 = FOUR_MEME_BSC.tokenManagerV2;

const config: FloatPolicyConfig = { floatAddress: FLOAT, gasReserveWei: parseEther("0.002") };
const limits = (over: Partial<FloatLimits> = {}): FloatLimits => ({
  maxBuyWei: parseEther("0.25"),
  maxBuysPerDay: 5,
  dailySpendWei: parseEther("0.5"),
  cooldownSec: 0,
  frozen: false,
  ...over,
});
const state = (over: Partial<FloatState> = {}): FloatState => ({
  buysToday: 0,
  spentTodayWei: 0n,
  lastBuyAtSec: null,
  balanceWei: parseEther("1"),
  nowSec: 1_800_000_000,
  ...over,
});

const buyAmap = (funds = parseEther("0.1")): Hex =>
  encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [MEME, funds, 1n] });
const sell = (amount = 1_000n): Hex => encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [MEME, amount] });
const approve = (spender: Address, amount = 10n ** 30n): Hex =>
  encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [spender, amount] });

const buyTx = (value = parseEther("0.1"), data: Hex = buyAmap(value)) => ({ to: V2, value, data });

describe("a buy on four.meme", () => {
  it("is allowed inside every limit, and says what it is and what token", () => {
    const d = checkFloatTransaction(buyTx(), limits(), state(), config);
    expect(d).toMatchObject({ ok: true, kind: "buy", spendWei: parseEther("0.1"), token: MEME });
    expect(d.ok && d.summary).toMatch(/buy 0\.1 BNB on four\.meme/);
  });

  it("counts the BNB actually sent, not whatever the call says it wants to spend", () => {
    const d = checkFloatTransaction(buyTx(parseEther("0.05"), buyAmap(parseEther("999"))), limits(), state(), config);
    expect(d).toMatchObject({ ok: true, spendWei: parseEther("0.05") });
  });

  it("works on every buy overload and on V1 and the router", () => {
    const calls: Array<[Address, Hex]> = [
      [V2, encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyToken", args: [MEME, 5n, parseEther("0.1")] })],
      [V2, encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [0n, MEME, FLOAT, parseEther("0.1"), 1n] })],
      [FOUR_MEME_BSC.tokenManagerV1, encodeFunctionData({ abi: TOKEN_MANAGER_V1_ABI, functionName: "purchaseTokenAMAP", args: [MEME, parseEther("0.1"), 1n] })],
      [FOUR_MEME_BSC.helper3, encodeFunctionData({ abi: HELPER3_ABI, functionName: "buyWithEth", args: [0n, MEME, ZERO, parseEther("0.1"), 1n] })],
    ];
    for (const [to, data] of calls) {
      expect(checkFloatTransaction({ to, value: parseEther("0.1"), data }, limits(), state(), config)).toMatchObject({ ok: true, kind: "buy" });
    }
  });

  it("is refused above the per-buy limit, and the message says the limit", () => {
    const d = checkFloatTransaction(buyTx(parseEther("0.3")), limits(), state(), config);
    expect(d).toMatchObject({ ok: false, code: "MAX_BUY" });
    expect(!d.ok && d.message).toMatch(/0\.3 BNB.*0\.25 BNB/);
  });

  it("is allowed exactly AT the per-buy limit", () => {
    expect(checkFloatTransaction(buyTx(parseEther("0.25")), limits({ dailySpendWei: parseEther("1") }), state(), config).ok).toBe(true);
  });

  it("is refused once the buys-per-day count is used up", () => {
    expect(checkFloatTransaction(buyTx(), limits(), state({ buysToday: 5 }), config)).toMatchObject({ ok: false, code: "MAX_BUYS_PER_DAY" });
    expect(checkFloatTransaction(buyTx(), limits(), state({ buysToday: 4 }), config).ok).toBe(true);
  });

  it("is refused when it would pass the daily spend limit, and says what is left", () => {
    const d = checkFloatTransaction(buyTx(parseEther("0.2")), limits(), state({ spentTodayWei: parseEther("0.4") }), config);
    expect(d).toMatchObject({ ok: false, code: "DAILY_SPEND" });
    expect(!d.ok && d.message).toMatch(/0\.1 BNB left/);
  });

  it("is allowed when it uses the daily limit up exactly", () => {
    expect(checkFloatTransaction(buyTx(parseEther("0.1")), limits(), state({ spentTodayWei: parseEther("0.4") }), config).ok).toBe(true);
  });

  it("respects the cooldown, and tells you how long to wait", () => {
    const l = limits({ cooldownSec: 30 });
    const d = checkFloatTransaction(buyTx(), l, state({ lastBuyAtSec: 1_800_000_000 - 10 }), config);
    expect(d).toMatchObject({ ok: false, code: "COOLDOWN" });
    expect(!d.ok && d.message).toMatch(/20s/);
    expect(checkFloatTransaction(buyTx(), l, state({ lastBuyAtSec: 1_800_000_000 - 30 }), config).ok).toBe(true);
    expect(checkFloatTransaction(buyTx(), l, state({ lastBuyAtSec: null }), config).ok).toBe(true);
  });

  it("is refused while frozen", () => {
    expect(checkFloatTransaction(buyTx(), limits({ frozen: true }), state(), config)).toMatchObject({ ok: false, code: "FROZEN" });
  });

  it("can never spend the BNB kept back for fees", () => {
    const d = checkFloatTransaction(buyTx(parseEther("0.2")), limits(), state({ balanceWei: parseEther("0.2") }), config);
    expect(d).toMatchObject({ ok: false, code: "INSUFFICIENT_FLOAT" });
    expect(checkFloatTransaction(buyTx(parseEther("0.1")), limits(), state({ balanceWei: parseEther("0.102") }), config).ok).toBe(true);
    expect(checkFloatTransaction(buyTx(parseEther("0.1")), limits(), state({ balanceWei: parseEther("0.1019") }), config).ok).toBe(false);
  });

  it("names the FIRST limit it hits, in a fixed order", () => {
    const d = checkFloatTransaction(buyTx(parseEther("0.3")), limits({ frozen: true }), state({ buysToday: 99 }), config);
    expect(d).toMatchObject({ code: "FROZEN" });
    const e = checkFloatTransaction(buyTx(parseEther("0.3")), limits(), state({ buysToday: 99 }), config);
    expect(e).toMatchObject({ code: "MAX_BUY" });
  });

  it("cannot route the tokens to anyone but the trading wallet", () => {
    const toStranger = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [MEME, STRANGER, parseEther("0.1"), 1n] });
    expect(checkFloatTransaction(buyTx(parseEther("0.1"), toStranger), limits(), state(), config)).toMatchObject({ ok: false, code: "BAD_RECIPIENT" });
    const toSelf = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [MEME, FLOAT, parseEther("0.1"), 1n] });
    expect(checkFloatTransaction(buyTx(parseEther("0.1"), toSelf), limits(), state(), config).ok).toBe(true);
    const viaHelper = encodeFunctionData({ abi: HELPER3_ABI, functionName: "buyWithEth", args: [0n, MEME, STRANGER, parseEther("0.1"), 1n] });
    expect(checkFloatTransaction({ to: FOUR_MEME_BSC.helper3, value: parseEther("0.1"), data: viaHelper }, limits(), state(), config)).toMatchObject({ code: "BAD_RECIPIENT" });
  });

  it("matches the wallet address regardless of letter case", () => {
    const lower = FLOAT.toLowerCase() as Address;
    const data = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [MEME, lower, parseEther("0.1"), 1n] });
    expect(checkFloatTransaction(buyTx(parseEther("0.1"), data), limits(), state(), config).ok).toBe(true);
  });
});

describe("a sell on four.meme", () => {
  const sellTx = (data: Hex = sell()) => ({ to: V2, value: 0n, data });

  it("is allowed", () => {
    expect(checkFloatTransaction(sellTx(), limits(), state(), config)).toMatchObject({ ok: true, kind: "sell", spendWei: 0n, token: MEME });
  });

  it("is NEVER blocked: not by a freeze, the day's limits, an empty budget or no BNB for the buy-side reserve", () => {
    const worst = limits({ frozen: true, maxBuyWei: 0n, maxBuysPerDay: 0, dailySpendWei: 0n, cooldownSec: 9999 });
    const exhausted = state({ buysToday: 999, spentTodayWei: parseEther("99"), lastBuyAtSec: 1_800_000_000, balanceWei: 0n });
    expect(checkFloatTransaction(sellTx(), worst, exhausted, config).ok).toBe(true);
  });

  it("works on every sell overload, including V1 and the router", () => {
    const calls: Array<[Address, Hex]> = [
      [V2, encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [MEME, 5n, 1n] })],
      [V2, encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [0n, MEME, 5n, 1n, 100n, STRANGER] })],
      [FOUR_MEME_BSC.tokenManagerV1, encodeFunctionData({ abi: TOKEN_MANAGER_V1_ABI, functionName: "saleToken", args: [MEME, 5n] })],
      [FOUR_MEME_BSC.helper3, encodeFunctionData({ abi: HELPER3_ABI, functionName: "sellForEth", args: [0n, MEME, 5n, 1n, 0n, ZERO] })],
    ];
    for (const [to, data] of calls) expect(checkFloatTransaction({ to, value: 0n, data }, limits(), state(), config)).toMatchObject({ ok: true, kind: "sell" });
  });

  it("refuses to pay a third party more than the 5% router cut", () => {
    const greedy = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [0n, MEME, 5n, 1n, 501n, STRANGER] });
    expect(checkFloatTransaction(sellTx(greedy), limits(), state(), config)).toMatchObject({ ok: false, code: "BAD_FEE" });
    const capped = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [0n, MEME, 5n, 1n, 500n, STRANGER] });
    expect(checkFloatTransaction(sellTx(capped), limits(), state(), config).ok).toBe(true);
  });

  it("will not send the sale proceeds anywhere but the wallet", () => {
    const away = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [0n, MEME, FLOAT, STRANGER, 5n, 1n] });
    expect(checkFloatTransaction(sellTx(away), limits(), state(), config)).toMatchObject({ ok: false, code: "BAD_RECIPIENT" });
  });

  it("refuses a 'sale' that carries BNB", () => {
    expect(checkFloatTransaction({ to: V2, value: 1n, data: sell() }, limits(), state(), config)).toMatchObject({ ok: false, code: "SELL_WITH_VALUE" });
  });
});

describe("approvals", () => {
  const approveTx = (spender: Address, token: Address = MEME) => ({ to: token, value: 0n, data: approve(spender) });

  it("are allowed for four.meme's own contracts, so a sell can happen", () => {
    for (const spender of [FOUR_MEME_BSC.tokenManagerV2, FOUR_MEME_BSC.tokenManagerV1, FOUR_MEME_BSC.helper3]) {
      expect(checkFloatTransaction(approveTx(spender), limits(), state(), config)).toMatchObject({ ok: true, kind: "approve", token: MEME });
    }
  });

  it("are refused for anyone else — an allowance lets a contract pull tokens with no further signature", () => {
    expect(checkFloatTransaction(approveTx(STRANGER), limits(), state(), config)).toMatchObject({ ok: false, code: "BAD_APPROVAL" });
  });

  it("work even when frozen or out of budget (they are how you sell)", () => {
    expect(checkFloatTransaction(approveTx(V2), limits({ frozen: true }), state({ balanceWei: 0n }), config).ok).toBe(true);
  });

  it("refuse an approval that carries BNB", () => {
    expect(checkFloatTransaction({ ...approveTx(V2), value: 1n }, limits(), state(), config)).toMatchObject({ ok: false, code: "BAD_APPROVAL" });
  });

  it("treat increaseAllowance the same way", () => {
    const data = encodeFunctionData({ abi: [{ type: "function", name: "increaseAllowance", stateMutability: "nonpayable", inputs: [{ type: "address", name: "s" }, { type: "uint256", name: "a" }], outputs: [{ type: "bool" }] }], functionName: "increaseAllowance", args: [STRANGER, 1n] });
    expect(checkFloatTransaction({ to: MEME, value: 0n, data }, limits(), state(), config)).toMatchObject({ code: "BAD_APPROVAL" });
  });
});

describe("everything else is refused", () => {
  it("a plain BNB send, to anyone", () => {
    expect(checkFloatTransaction({ to: STRANGER, value: parseEther("0.1"), data: "0x" }, limits(), state(), config)).toMatchObject({ ok: false, code: "PLAIN_SEND" });
    expect(checkFloatTransaction({ to: V2, value: 1n, data: "0x" }, limits(), state(), config)).toMatchObject({ code: "PLAIN_SEND" });
  });

  it("a token transfer or transferFrom", () => {
    const transfer = encodeFunctionData({ abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "v" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [STRANGER, 1n] });
    expect(checkFloatTransaction({ to: MEME, value: 0n, data: transfer }, limits(), state(), config)).toMatchObject({ ok: false, code: "UNKNOWN_DESTINATION" });
  });

  it("a call to a contract that is not four.meme", () => {
    expect(checkFloatTransaction({ to: STRANGER, value: parseEther("0.1"), data: buyAmap() }, limits(), state(), config)).toMatchObject({ ok: false, code: "UNKNOWN_DESTINATION" });
  });

  it("an unrecognised call on four.meme itself (such as launching a token)", () => {
    expect(checkFloatTransaction({ to: V2, value: parseEther("0.1"), data: "0xdeadbeef00" }, limits(), state(), config)).toMatchObject({ ok: false, code: "UNKNOWN_CALL" });
  });

  it("truncated or malformed calldata, without throwing", () => {
    for (const data of ["0xa9059c", "0x12345678", `${buyAmap().slice(0, 60)}`] as Hex[]) {
      expect(() => checkFloatTransaction({ to: V2, value: 1n, data }, limits(), state(), config)).not.toThrow();
      expect(checkFloatTransaction({ to: V2, value: 1n, data }, limits(), state(), config).ok).toBe(false);
    }
  });

  it("a venue list can be supplied (so other platforms can be added without touching the rules)", () => {
    const venues = new Map([[STRANGER.toLowerCase(), { name: "test venue", abi: TOKEN_MANAGER_V2_ABI as never }]]);
    expect(checkFloatTransaction({ to: STRANGER, value: parseEther("0.1"), data: buyAmap() }, limits(), state(), { ...config, venues })).toMatchObject({ ok: true, kind: "buy" });
  });
});
