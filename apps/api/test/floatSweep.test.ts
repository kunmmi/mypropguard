import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, parseEther, type Address, type Hash } from "viem";
import { sweepFloat } from "../src/float/sweep.js";

const FLOAT = "0x1111111111111111111111111111111111111111" as Address;
const SAFE = "0x7777777777777777777777777777777777777777" as Address;
const T1 = "0x2222222222222222222222222222222222222222" as Address;
const T2 = "0x3333333333333333333333333333333333333333" as Address;

function rig(balances: Record<string, bigint>, bnb: bigint, failing: string[] = []) {
  const sent: Array<{ to: Address; value: bigint; data: string }> = [];
  const publicClient = {
    readContract: async ({ address }: { address: Address }) => balances[address] ?? 0n,
    getBalance: async () => bnb,
    getGasPrice: async () => 3_000_000_000n,
    waitForTransactionReceipt: async () => ({}) as never,
  };
  const signer = {
    sendTransaction: async (_id: string, tx: { to: Address; value: bigint; data: string }) => {
      if (failing.includes(tx.to)) throw new Error("boom\nmore");
      sent.push(tx);
      return `0x${sent.length.toString(16).padStart(64, "0")}` as Hash;
    },
  };
  return { sent, run: () => sweepFloat({ walletId: "w", walletAddress: FLOAT, to: SAFE, tokens: [T1, T2], publicClient: publicClient as never, signer }) };
}

describe("sweeping the trading wallet back to the Safe", () => {
  it("sends each held token, then the BNB left after its own fee, all to the Safe", async () => {
    const { run, sent } = rig({ [T1]: 500n, [T2]: 9n }, parseEther("0.4"));
    const items = await run();
    expect(items.map((i) => i.asset)).toEqual([T1, T2, "BNB"]);
    for (const tx of sent.slice(0, 2)) {
      const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
      expect(call.functionName).toBe("transfer");
      expect((call.args as unknown[])[0]).toBe(SAFE);
    }
    expect(sent[2]).toMatchObject({ to: SAFE, data: "0x" });
    expect(sent[2]!.value).toBe(parseEther("0.4") - 21_000n * 3_000_000_000n * 2n);
    expect(items.every((i) => i.error === null)).toBe(true);
  });

  it("skips tokens with nothing in them and sends no BNB when it would not cover its fee", async () => {
    const { run, sent } = rig({ [T1]: 0n }, 1000n);
    expect(await run()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("one token failing does not stop the rest, and says which", async () => {
    const { run, sent } = rig({ [T1]: 5n, [T2]: 6n }, parseEther("0.1"), [T1]);
    const items = await run();
    expect(items[0]).toMatchObject({ asset: T1, txHash: null, error: "boom" });
    expect(items[1]).toMatchObject({ asset: T2, error: null });
    expect(items[2]).toMatchObject({ asset: "BNB", error: null });
    expect(sent).toHaveLength(2);
  });
});
