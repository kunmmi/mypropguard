import { describe, expect, it, vi } from "vitest";
import { PancakeSwapEquityReader } from "../src/pancakeSwapEquityReader.js";

const SAFE_ADDRESS = "0x1111111111111111111111111111111111111111";
const FACTORY = "0xFACT000000000000000000000000000000000000";
const WBNB = "0xB0B0000000000000000000000000000000000000";
const USDT = "0xU5D7000000000000000000000000000000000000";
const TOKEN_A = "0xA0000000000000000000000000000000000000AA"; // directly paired with USDT
const TOKEN_B = "0xB0000000000000000000000000000000000000BB"; // only paired with WBNB
const TOKEN_C = "0xC0000000000000000000000000000000000000CC"; // no pair at all
const PAIR_A_USDT = "0xPA1R000000000000000000000000000000000A01";
const PAIR_B_WBNB = "0xPA1R000000000000000000000000000000000B01";
const PAIR_WBNB_USDT = "0xPA1R0000000000000000000000000000000000NB";

function buildReader() {
  const getBalance = vi.fn();
  const readContract = vi.fn();
  const publicClient = { getBalance, readContract } as any;
  const reader = new PancakeSwapEquityReader(publicClient, FACTORY as any, WBNB as any, USDT as any);
  return { reader, getBalance, readContract };
}

/** Routes readContract calls by (address, functionName) the same way the real client would dispatch them. */
function mockRouter(handlers: Record<string, (args: any) => unknown>) {
  return vi.fn(({ address, functionName, args }: any) => {
    const key = `${address}:${functionName}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unmocked call: ${key}`);
    return Promise.resolve(handler(args));
  });
}

describe("PancakeSwapEquityReader", () => {
  it("values native balance via the WBNB/USDT pair", async () => {
    const { reader, getBalance, readContract } = buildReader();
    getBalance.mockResolvedValue(2_000_000_000_000_000_000n); // 2 BNB

    (reader as any).publicClient.readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${FACTORY}:getPair`]: ({ 0: a, 1: b }: any) =>
        [a, b].map((x) => x.toLowerCase()).sort().join() === [WBNB, USDT].map((x) => x.toLowerCase()).sort().join()
          ? PAIR_WBNB_USDT
          : "0x0000000000000000000000000000000000000000",
      [`${PAIR_WBNB_USDT}:getReserves`]: () => [500n * 10n ** 18n, 300_000n * 10n ** 18n, 0], // 500 WBNB : 300,000 USDT => 1 BNB = 600 USDT
      [`${PAIR_WBNB_USDT}:token0`]: () => WBNB,
    });

    const equity = await reader.getEquityUsd({ safeAddress: SAFE_ADDRESS, trackedTokens: [] });
    // Valued by what selling the 2 BNB into the pool returns (0.25% fee + price impact), not the spot price.
    expect(equity.toNumber()).toBeCloseTo((2 * 0.9975 * 300_000) / (500 + 2 * 0.9975), 4);
    void readContract;
  });

  it("values a tracked token with a direct USDT pair", async () => {
    const { reader, getBalance } = buildReader();
    getBalance.mockResolvedValue(0n);

    (reader as any).publicClient.readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${TOKEN_A}:decimals`]: () => 18,
      [`${TOKEN_A}:balanceOf`]: () => 10n * 10n ** 18n, // 10 tokens
      [`${FACTORY}:getPair`]: ({ 0: a, 1: b }: any) => {
        const pair = [a.toLowerCase(), b.toLowerCase()].sort().join();
        if (pair === [TOKEN_A, USDT].map((x) => x.toLowerCase()).sort().join()) return PAIR_A_USDT;
        return "0x0000000000000000000000000000000000000000";
      },
      [`${PAIR_A_USDT}:getReserves`]: () => [1_000n * 10n ** 18n, 5_000n * 10n ** 18n, 0], // 1000 A : 5000 USDT => 1 A = 5 USDT
      [`${PAIR_A_USDT}:token0`]: () => TOKEN_A,
    });

    const equity = await reader.getEquityUsd({ safeAddress: SAFE_ADDRESS, trackedTokens: [TOKEN_A] });
    expect(equity.toNumber()).toBeCloseTo((10 * 0.9975 * 5_000) / (1_000 + 10 * 0.9975), 4);
  });

  it("falls back to routing through WBNB when there is no direct stablecoin pair", async () => {
    const { reader, getBalance } = buildReader();
    getBalance.mockResolvedValue(0n);

    (reader as any).publicClient.readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${TOKEN_B}:decimals`]: () => 18,
      [`${TOKEN_B}:balanceOf`]: () => 4n * 10n ** 18n, // 4 tokens
      [`${FACTORY}:getPair`]: ({ 0: a, 1: b }: any) => {
        const pair = [a.toLowerCase(), b.toLowerCase()].sort().join();
        if (pair === [TOKEN_B, USDT].map((x) => x.toLowerCase()).sort().join()) return "0x0000000000000000000000000000000000000000";
        if (pair === [TOKEN_B, WBNB].map((x) => x.toLowerCase()).sort().join()) return PAIR_B_WBNB;
        if (pair === [WBNB, USDT].map((x) => x.toLowerCase()).sort().join()) return PAIR_WBNB_USDT;
        return "0x0000000000000000000000000000000000000000";
      },
      [`${PAIR_B_WBNB}:getReserves`]: () => [100n * 10n ** 18n, 1n * 10n ** 18n, 0], // 100 B : 1 WBNB => 1 B = 0.01 WBNB
      [`${PAIR_B_WBNB}:token0`]: () => TOKEN_B,
      [`${PAIR_WBNB_USDT}:getReserves`]: () => [1n * 10n ** 18n, 600n * 10n ** 18n, 0], // 1 WBNB = 600 USDT
      [`${PAIR_WBNB_USDT}:token0`]: () => WBNB,
    });

    const equity = await reader.getEquityUsd({ safeAddress: SAFE_ADDRESS, trackedTokens: [TOKEN_B] });
    const wbnbOut = (4 * 0.9975 * 1) / (100 + 4 * 0.9975);
    expect(equity.toNumber()).toBeCloseTo((wbnbOut * 0.9975 * 600) / (1 + wbnbOut * 0.9975), 4);
  });

  it("values a token with no pair at all as $0 rather than throwing", async () => {
    const { reader, getBalance } = buildReader();
    getBalance.mockResolvedValue(0n);

    (reader as any).publicClient.readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${TOKEN_C}:decimals`]: () => 18,
      [`${TOKEN_C}:balanceOf`]: () => 999n * 10n ** 18n,
      [`${FACTORY}:getPair`]: () => "0x0000000000000000000000000000000000000000",
    });

    const equity = await reader.getEquityUsd({ safeAddress: SAFE_ADDRESS, trackedTokens: [TOKEN_C] });
    expect(equity.toNumber()).toBe(0);
  });

  it("treats the stablecoin itself as ~$1 without needing a pair lookup", async () => {
    const { reader, getBalance } = buildReader();
    getBalance.mockResolvedValue(0n);

    (reader as any).publicClient.readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${USDT}:balanceOf`]: () => 42n * 10n ** 18n,
    });

    const equity = await reader.getEquityUsd({ safeAddress: SAFE_ADDRESS, trackedTokens: [USDT] });
    expect(equity.toNumber()).toBeCloseTo(42, 6);
  });

  it("ignores the native-token zero-address sentinel in trackedTokens (already counted via native balance)", async () => {
    const { reader, getBalance } = buildReader();
    getBalance.mockResolvedValue(0n);
    const readContract = vi.fn().mockResolvedValue(0n);
    (reader as any).publicClient.readContract = readContract;

    const equity = await reader.getEquityUsd({
      safeAddress: SAFE_ADDRESS,
      trackedTokens: ["0x0000000000000000000000000000000000000000"],
    });

    expect(equity.toNumber()).toBe(0);
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: "balanceOf" }));
  });

  it("caps a token's value at what its pool can actually pay, so a fake pool cannot inflate equity", async () => {
    const { reader, getBalance } = buildReader();
    getBalance.mockResolvedValue(0n);

    (reader as any).publicClient.readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${TOKEN_A}:decimals`]: () => 18,
      [`${TOKEN_A}:balanceOf`]: () => 1_000_000_000n * 10n ** 18n, // a billion worthless tokens
      [`${FACTORY}:getPair`]: ({ 0: a, 1: b }: any) =>
        [a, b].map((x) => x.toLowerCase()).sort().join() === [TOKEN_A, USDT].map((x) => x.toLowerCase()).sort().join()
          ? PAIR_A_USDT
          : "0x0000000000000000000000000000000000000000",
      // A pool seeded with 1 token and $1: the marginal price is $1/token, so a spot valuation of a
      // billion tokens would be $1,000,000,000 - but the pool can only ever pay out less than $1.
      [`${PAIR_A_USDT}:getReserves`]: () => [1n * 10n ** 18n, 1n * 10n ** 18n, 0],
      [`${PAIR_A_USDT}:token0`]: () => TOKEN_A,
    });

    const equity = await reader.getEquityUsd({ safeAddress: SAFE_ADDRESS, trackedTokens: [TOKEN_A] });
    expect(equity.toNumber()).toBeLessThan(1);
  });

  it("reads balances and prices at the requested block", async () => {
    const { reader, getBalance } = buildReader();
    getBalance.mockResolvedValue(0n);
    const readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${USDT}:balanceOf`]: () => 5n * 10n ** 18n,
    });
    (reader as any).publicClient.readContract = readContract;

    await reader.getEquityUsd({ safeAddress: SAFE_ADDRESS, trackedTokens: [USDT], blockNumber: 12345 });

    expect(getBalance).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 12345n }));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "balanceOf", blockNumber: 12345n }));
  });

  it("values a flow's tokens the same way, including the native coin", async () => {
    const { reader } = buildReader();
    (reader as any).publicClient.readContract = mockRouter({
      [`${USDT}:decimals`]: () => 18,
      [`${FACTORY}:getPair`]: ({ 0: a, 1: b }: any) =>
        [a, b].map((x) => x.toLowerCase()).sort().join() === [WBNB, USDT].map((x) => x.toLowerCase()).sort().join()
          ? PAIR_WBNB_USDT
          : "0x0000000000000000000000000000000000000000",
      [`${PAIR_WBNB_USDT}:getReserves`]: () => [500n * 10n ** 18n, 300_000n * 10n ** 18n, 0],
      [`${PAIR_WBNB_USDT}:token0`]: () => WBNB,
    });
    const usd = await reader.getTokenValueUsd("0x0000000000000000000000000000000000000000", 10n ** 18n);
    expect(usd.toNumber()).toBeCloseTo((1 * 0.9975 * 300_000) / (500 + 0.9975), 4);
  });
});
