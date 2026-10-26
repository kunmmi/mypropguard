import { describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther, stringToHex, type Address, type Hash, type Hex } from "viem";
import { FOUR_MEME_BSC, FloatExecutor, TOKEN_MANAGER_V2_ABI, type FloatWalletSigner } from "@mypropguard/evm";
import { FloatRequestHandler } from "../src/float/floatRequestHandler.js";
import type { FloatTradeRecord, FloatWalletRow } from "../src/float/floatStore.js";
import { OneClickRequestHandler } from "../src/oneClick/oneClickRequestHandler.js";
import type { LinkedSession } from "../src/oneClick/oneClickStore.js";

const FLOAT = "0x1111111111111111111111111111111111111111" as Address;
const SAFE = "0x7777777777777777777777777777777777777777" as Address;
const MEME = "0x2222222222222222222222222222222222222222" as Address;
const V2 = FOUR_MEME_BSC.tokenManagerV2;

const session = (over: Partial<LinkedSession> = {}): LinkedSession => ({
  topic: "topic-1",
  accountId: "acct_1",
  kind: "float",
  dappName: "four.meme",
  dappUrl: "https://four.meme",
  createdAt: new Date(),
  expiresAt: null,
  ...over,
});

function rig(over: { wallet?: Partial<FloatWalletRow> | null; balance?: bigint; estimate?: bigint | Error; now?: () => number } = {}) {
  const trades: FloatTradeRecord[] = [];
  const signed: string[] = [];
  const sent: Array<{ to: Address; value: bigint }> = [];
  const wallet: FloatWalletRow | undefined =
    over.wallet === null
      ? undefined
      : {
          accountId: "acct_1",
          walletId: "privy-1",
          address: FLOAT,
          chainId: 56,
          status: "active",
          floatWei: parseEther("1"),
          createdAt: new Date(),
          limits: { maxBuyWei: parseEther("0.25"), maxBuysPerDay: 3, dailySpendWei: parseEther("0.5"), cooldownSec: 0, frozen: false },
          ...over.wallet,
        };
  const store = {
    get: async () => wallet,
    // The day's counters, derived from what was recorded: exactly how the real store does it.
    usageToday: async () => {
      const buys = trades.filter((t) => t.kind === "buy" && t.result === "SENT");
      return { buysToday: buys.length, spentTodayWei: buys.reduce((s, t) => s + (t.valueWei ?? 0n), 0n), lastBuyAtSec: null };
    },
    recordTrade: async (t: FloatTradeRecord) => void trades.push(t),
  };
  const signer: FloatWalletSigner = {
    async sendTransaction(_id, tx) {
      await new Promise((r) => setTimeout(r, 10));
      sent.push({ to: tx.to, value: tx.value });
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hash;
    },
    async personalSign(_id, message) {
      signed.push(message);
      return `0x${"cd".repeat(65)}` as Hex;
    },
  };
  const publicClient = {
    getBalance: async () => over.balance ?? parseEther("1"),
    estimateGas: async () => {
      if (over.estimate instanceof Error) throw over.estimate;
      return over.estimate ?? 150_000n;
    },
  };
  const executor = new FloatExecutor({ publicClient: publicClient as never, signer });
  const logs: string[] = [];
  const handler = new FloatRequestHandler({ store, executor, signer, now: over.now, log: (m) => logs.push(m) });
  return { handler, trades, signed, sent, logs };
}

const buyTx = (bnb: string, extra: Record<string, unknown> = {}) => ({
  from: FLOAT,
  to: V2,
  value: `0x${parseEther(bnb).toString(16)}`,
  data: encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [MEME, parseEther(bnb), 1n] }),
  ...extra,
});
const send = (h: FloatRequestHandler, tx: Record<string, unknown>, chain = "eip155:56", s = session()) =>
  h.handle(s, chain, { method: "eth_sendTransaction", params: [tx] });
const err = (r: any) => r.error as { code: number; message: string };

describe("what the site sees", () => {
  it("the account is the TRADING wallet, on the right chain", async () => {
    const { handler } = rig();
    expect(await handler.handle(session(), "eip155:56", { method: "eth_accounts" })).toEqual({ result: [FLOAT] });
    expect(await handler.handle(session(), "eip155:56", { method: "eth_requestAccounts" })).toEqual({ result: [FLOAT] });
    expect(await handler.handle(session(), "eip155:56", { method: "eth_chainId" })).toEqual({ result: "0x38" });
  });

  it("switching to the same chain is fine, to another is refused", async () => {
    const { handler } = rig();
    expect(await handler.handle(session(), "eip155:56", { method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] })).toEqual({ result: null });
    expect(err(await handler.handle(session(), "eip155:56", { method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] })).code).toBe(4902);
  });

  it("unknown methods are not supported", async () => {
    expect(err(await rig().handler.handle(session(), "eip155:56", { method: "wallet_addEthereumChain" })).code).toBe(-32601);
  });
});

describe("logging in (personal_sign)", () => {
  const login = (nonce = "484138") => stringToHex(`You are sign in Meme ${nonce}`);

  it("signs four.meme's login for four.meme, and records it", async () => {
    const { handler, signed, trades } = rig();
    const r: any = await handler.handle(session(), "eip155:56", { method: "personal_sign", params: [login(), FLOAT] });
    expect(r.result).toMatch(/^0x[0-9a-f]{130}$/);
    expect(signed).toEqual(["You are sign in Meme 484138"]);
    expect(trades.at(-1)).toMatchObject({ kind: "login", result: "SENT" });
  });

  it("accepts the older [address, message] argument order", async () => {
    const { handler, signed } = rig();
    const r: any = await handler.handle(session(), "eip155:56", { method: "personal_sign", params: [FLOAT, login()] });
    expect(r.result).toBeDefined();
    expect(signed).toHaveLength(1);
  });

  it("does NOT sign it for any other site", async () => {
    const { handler, signed, trades } = rig();
    const r = await handler.handle(session({ dappName: "evil", dappUrl: "https://evil.example" }), "eip155:56", { method: "personal_sign", params: [login(), FLOAT] });
    expect(err(r).code).toBe(4200);
    expect(err(r).message).toMatch(/evil\.example/);
    expect(signed).toHaveLength(0);
    expect(trades.at(-1)).toMatchObject({ kind: "login", result: "REFUSED", code: "LOGIN_REFUSED" });
  });

  it("does not sign anything that is not a login, or a signature requested for another address", async () => {
    const { handler, signed } = rig();
    for (const message of [stringToHex("Approve all my tokens"), `0x${"ab".repeat(32)}`]) {
      expect(err(await handler.handle(session(), "eip155:56", { method: "personal_sign", params: [message, FLOAT] })).code).toBe(4200);
    }
    const other = await handler.handle(session(), "eip155:56", { method: "personal_sign", params: [login(), SAFE] });
    expect(err(other).code).toBe(-32602);
    expect(signed).toHaveLength(0);
  });

  it("NEVER signs typed data or raw eth_sign, whatever they contain", async () => {
    const { handler, signed, trades } = rig();
    for (const method of ["eth_signTypedData", "eth_signTypedData_v3", "eth_signTypedData_v4", "eth_sign"]) {
      const r = await handler.handle(session(), "eip155:56", { method, params: [FLOAT, "{}"] });
      expect(err(r).code, method).toBe(4200);
      expect(err(r).message).toMatch(/permits/);
    }
    expect(signed).toHaveLength(0);
    expect(trades.every((t) => t.result === "REFUSED")).toBe(true);
  });

  it("reports a signer failure as an error, not a crash", async () => {
    const { handler, trades } = rig();
    (handler as any).deps.signer = { personalSign: async () => { throw new Error("privy down"); } };
    const r = await handler.handle(session(), "eip155:56", { method: "personal_sign", params: [login(), FLOAT] });
    expect(err(r).message).toMatch(/privy down/);
    expect(trades.at(-1)).toMatchObject({ result: "ERROR" });
  });
});

describe("trading (eth_sendTransaction)", () => {
  it("sends an allowed buy and records it with the token, amount, hash and timings", async () => {
    const { handler, trades, sent, logs } = rig();
    const r: any = await send(handler, buyTx("0.1"));
    expect(r.result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent).toEqual([{ to: V2, value: parseEther("0.1") }]);
    expect(trades.at(-1)).toMatchObject({ kind: "buy", result: "SENT", tokenAddress: MEME, valueWei: parseEther("0.1"), txHash: r.result, dappName: "four.meme" });
    expect(trades.at(-1)!.timings).toMatchObject({ checkMs: expect.any(Number), estimateMs: expect.any(Number), sendMs: expect.any(Number), totalMs: expect.any(Number) });
    expect(logs.at(-1)).toMatch(/float buy for acct_1: total \d+ ms \(check \d+, dry-run \d+, sign\+send \d+\)/);
  });

  it("counts earlier buys: the limit is three buys a day", async () => {
    const { handler, sent } = rig();
    for (let i = 0; i < 3; i++) expect((await send(handler, buyTx("0.05")) as any).result).toBeDefined();
    const r = await send(handler, buyTx("0.05"));
    expect(err(r).message).toMatch(/all 3 buys/);
    expect(sent).toHaveLength(3);
  });

  it("a refusal says which limit and what to do, and is recorded without a transaction", async () => {
    const { handler, trades, sent } = rig();
    const r = await send(handler, buyTx("0.4"));
    expect(err(r).code).toBe(-32000);
    expect(err(r).message).toMatch(/0\.4 BNB.*0\.25 BNB/);
    expect(sent).toHaveLength(0);
    expect(trades.at(-1)).toMatchObject({ kind: "buy", result: "REFUSED", code: "MAX_BUY", txHash: null });
  });

  it("buys fired together cannot both pass the daily limit", async () => {
    const { handler, sent } = rig({ wallet: { limits: { maxBuyWei: parseEther("0.3"), maxBuysPerDay: 9, dailySpendWei: parseEther("0.5"), cooldownSec: 0, frozen: false } } });
    const results = await Promise.all([send(handler, buyTx("0.3")), send(handler, buyTx("0.3"))]);
    expect(results.filter((r: any) => r.result).length).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("a frozen wallet still sells, and its buys are refused", async () => {
    const { handler, sent } = rig({ wallet: { limits: { maxBuyWei: parseEther("1"), maxBuysPerDay: 9, dailySpendWei: parseEther("1"), cooldownSec: 0, frozen: true } }, balance: 0n });
    const sell = { from: FLOAT, to: V2, value: "0x0", data: encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [MEME, 5n] }) };
    expect((await send(handler, sell) as any).result).toBeDefined();
    expect(err(await send(handler, buyTx("0.05"))).message).toMatch(/frozen/);
    expect(sent).toHaveLength(1);
  });

  it("a trade four.meme would reject is stopped before any fee is spent", async () => {
    const { handler, sent, trades } = rig({ estimate: new Error("execution reverted: slippage") });
    const r = await send(handler, buyTx("0.1"));
    expect(err(r).message).toMatch(/no fee was spent/);
    expect(sent).toHaveLength(0);
    expect(trades.at(-1)).toMatchObject({ result: "REFUSED", code: "WOULD_FAIL" });
  });

  it("a transaction from another address, on another chain, or with bad fields is refused", async () => {
    const { handler, sent } = rig();
    expect(err(await send(handler, buyTx("0.1", { from: SAFE }))).code).toBe(-32602);
    expect(err(await send(handler, buyTx("0.1"), "eip155:1")).code).toBe(4901);
    expect(err(await send(handler, buyTx("0.1", { to: undefined }))).message).toMatch(/Deploying/);
    expect(err(await send(handler, buyTx("0.1", { data: "nope" }))).code).toBe(-32602);
    expect(err(await send(handler, buyTx("0.1", { value: "banana" }))).code).toBe(-32602);
    expect(err(await handler.handle(session(), "eip155:56", { method: "eth_sendTransaction", params: [] })).code).toBe(-32602);
    expect(sent).toHaveLength(0);
  });

  it("a plain send of BNB to anyone is refused", async () => {
    const { handler, sent } = rig();
    const r = await send(handler, { from: FLOAT, to: "0x9999999999999999999999999999999999999999", value: `0x${parseEther("0.5").toString(16)}`, data: "0x" });
    expect(err(r).message).toMatch(/only trades/);
    expect(sent).toHaveLength(0);
  });

  it("reports a send failure as an error and records it, without crashing", async () => {
    const { handler, trades } = rig();
    (handler as any).deps.executor = { execute: async () => { throw new Error("nonce too low\nextra detail"); } };
    const r = await send(handler, buyTx("0.1"));
    expect(err(r).message).toBe("MyPropGuard could not send this trade: nonce too low");
    expect(trades.at(-1)).toMatchObject({ result: "ERROR" });
  });
});

describe("a wallet that is off, or missing", () => {
  it("answers nothing while switched off — every method, including the harmless ones", async () => {
    const { handler, sent, signed } = rig({ wallet: { status: "off" } });
    for (const method of ["eth_accounts", "eth_chainId", "personal_sign", "eth_sendTransaction"]) {
      expect(err(await handler.handle(session(), "eip155:56", { method, params: [] })).code, method).toBe(4100);
    }
    expect(sent).toHaveLength(0);
    expect(signed).toHaveLength(0);
  });

  it("says so when the account has no trading wallet at all", async () => {
    expect(err(await rig({ wallet: null }).handler.handle(session(), "eip155:56", { method: "eth_accounts" })).code).toBe(4100);
  });
});

describe("routing between the Safe and the trading wallet", () => {
  function router(opts: { withFloat: boolean }) {
    const { handler: floatHandler } = rig();
    const safeCalls: string[] = [];
    const sessions: Record<string, LinkedSession> = { s: session({ topic: "s", kind: "safe", dappName: "PancakeSwap", dappUrl: "https://pancakeswap.finance" }), f: session({ topic: "f", kind: "float" }) };
    const oneClick = new OneClickRequestHandler({
      store: {
        get: async () => ({ accountId: "acct_1", sessionWalletId: "w", sessionWalletAddress: FLOAT, status: "enabled", createdAt: new Date(), enabledAt: new Date() }),
        getSession: async (topic: string) => sessions[topic],
        recordTrade: async () => void safeCalls.push("audit"),
      } as never,
      findAccount: async () => ({ evmSafeAddress: SAFE, evmChainId: 56 }),
      executors: { 56: { execute: async () => { safeCalls.push("safe-exec"); return `0x${"11".repeat(32)}` as Hash; } } },
      float: opts.withFloat ? floatHandler : undefined,
    });
    return { oneClick, safeCalls };
  }

  it("a link to the Safe still answers with the Safe's address (existing behaviour is untouched)", async () => {
    const { oneClick } = router({ withFloat: true });
    expect(await oneClick.handle("s", "eip155:56", { method: "eth_accounts" })).toEqual({ result: [SAFE] });
  });

  it("a link to the trading wallet answers with the trading wallet's address", async () => {
    const { oneClick } = router({ withFloat: true });
    expect(await oneClick.handle("f", "eip155:56", { method: "eth_accounts" })).toEqual({ result: [FLOAT] });
  });

  it("a Safe link still refuses signatures; a trading-wallet link signs a login", async () => {
    const { oneClick } = router({ withFloat: true });
    const msg = stringToHex("You are sign in Meme 1");
    expect(err(await oneClick.handle("s", "eip155:56", { method: "personal_sign", params: [msg, SAFE] })).message).toMatch(/cannot sign messages/);
    expect((await oneClick.handle("f", "eip155:56", { method: "personal_sign", params: [msg, FLOAT] }) as any).result).toBeDefined();
  });

  it("trading-wallet trades never touch the Safe's executor", async () => {
    const { oneClick, safeCalls } = router({ withFloat: true });
    await oneClick.handle("f", "eip155:56", { method: "eth_sendTransaction", params: [buyTx("0.1")] });
    expect(safeCalls).toEqual([]);
  });

  it("without trading wallets configured, a trading-wallet link is refused rather than mistaken for a Safe link", async () => {
    const { oneClick, safeCalls } = router({ withFloat: false });
    expect(err(await oneClick.handle("f", "eip155:56", { method: "eth_accounts" })).code).toBe(4100);
    expect(safeCalls).toEqual([]);
  });
});
