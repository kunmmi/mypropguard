import { describe, expect, it, vi } from "vitest";
import { SafeStateReader } from "../src/safeStateReader.js";

const SAFE = "0x5afe00000000000000000000000000000000a001";
const GUARD = "0x00000000000000000000000000000000000fa4d0";
const USDT = "0x0000000000000000000000000000000000005d71";
const CAKE = "0x00000000000000000000000000000000000ca4e5";
const NATIVE = "0x0000000000000000000000000000000000000000";

function build(opts: { guard?: boolean; failBalanceFor?: string[]; failWithdrawn?: boolean } = {}) {
  const multicall = vi.fn(async ({ contracts }: any) =>
    contracts.map((c: any) => {
      if (c.functionName === "balanceOf") {
        if (opts.failBalanceFor?.includes(c.address.toLowerCase())) return { status: "failure", error: new Error("not a token") };
        return { status: "success", result: c.address.toLowerCase() === USDT ? 5n : 7n };
      }
      if (opts.failWithdrawn) return { status: "failure", error: new Error("no such function") };
      return { status: "success", result: c.args[1] === NATIVE ? 11n : 13n };
    }),
  );
  const client = {
    getBlockNumber: vi.fn(async () => 1000n),
    getBalance: vi.fn(async () => 99n),
    readContract: vi.fn(async () => 42n),
    multicall,
  };
  const reader = new SafeStateReader(client as any, { baseTokens: [USDT as any], guardAddress: opts.guard === false ? undefined : (GUARD as any) });
  return { reader, client, multicall };
}

describe("SafeStateReader", () => {
  it("treats the head minus a few confirmations as settled", async () => {
    const { reader } = build();
    expect(await reader.getSettledBlock()).toBe(997);
  });

  it("reads nonce, native and token balances and the Guard's withdrawal totals at one block", async () => {
    const { reader, client } = build();
    const snapshot = await reader.getSnapshot({ safeAddress: SAFE, extraAssets: [CAKE], blockNumber: 990 });

    expect(snapshot.blockNumber).toBe(990);
    expect(snapshot.nonce).toBe(42);
    expect(snapshot.balances).toEqual({ [NATIVE]: 99n, [USDT]: 5n, [CAKE]: 7n });
    expect(snapshot.withdrawn).toEqual({ [NATIVE]: 11n, [USDT]: 13n, [CAKE]: 13n });
    expect(client.getBalance).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 990n }));
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "nonce", blockNumber: 990n }));
  });

  it("always watches the base tokens even when no extra assets are given, without duplicates", async () => {
    const { reader, multicall } = build();
    const snapshot = await reader.getSnapshot({ safeAddress: SAFE, extraAssets: [USDT, NATIVE], blockNumber: 990 });
    expect(Object.keys(snapshot.balances).sort()).toEqual([NATIVE, USDT].sort());
    expect(multicall.mock.calls[0][0].contracts).toHaveLength(1);
  });

  it("reports zero withdrawals when the Safe's Guard has no withdrawalTotal (an older Guard)", async () => {
    const { reader } = build({ failWithdrawn: true });
    const snapshot = await reader.getSnapshot({ safeAddress: SAFE, extraAssets: [], blockNumber: 990 });
    expect(snapshot.withdrawn).toEqual({ [NATIVE]: 0n, [USDT]: 0n });
  });

  it("reports zero withdrawals when no Guard is configured, without calling one", async () => {
    const { reader, multicall } = build({ guard: false });
    const snapshot = await reader.getSnapshot({ safeAddress: SAFE, extraAssets: [], blockNumber: 990 });
    expect(snapshot.withdrawn).toEqual({ [NATIVE]: 0n, [USDT]: 0n });
    expect(multicall).toHaveBeenCalledTimes(1); // only the balances
  });

  it("leaves out a token whose balance cannot be read instead of failing the whole snapshot", async () => {
    const { reader } = build({ failBalanceFor: [CAKE] });
    const snapshot = await reader.getSnapshot({ safeAddress: SAFE, extraAssets: [CAKE], blockNumber: 990 });
    expect(snapshot.balances[CAKE]).toBeUndefined();
    expect(snapshot.balances[USDT]).toBe(5n);
  });
});
