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
    expect(equity.toNumber()).toBeCloseTo(1200, 6); // 2 BNB * 600 USD
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
    expect(equity.toNumber()).toBeCloseTo(50, 6); // 10 tokens * $5
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
    expect(equity.toNumber()).toBeCloseTo(24, 6); // 4 tokens * 0.01 WBNB/token * 600 USD/WBNB = $24
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
});
