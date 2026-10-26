import { describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError, parseEther, type Address } from "viem";
import { FloatValuer } from "../src/floatValuer.js";

const WALLET = "0x1111111111111111111111111111111111111111" as Address;
const CURVE = "0x2222222222222222222222222222222222222222" as Address; // still on the bonding curve
const GRAD = "0x3333333333333333333333333333333333333333" as Address; // moved to PancakeSwap
const DEAD = "0x4444444444444444444444444444444444444444" as Address; // no price anywhere

const zero = "0x0000000000000000000000000000000000000000";
const revert = () => new BaseError("no", { cause: new ContractFunctionRevertedError({ abi: [], functionName: "f", message: "no" } as never) });

function client(opts: { down?: boolean } = {}) {
  const calls: string[] = [];
  const balances: Record<string, bigint> = { [CURVE]: 1000n, [GRAD]: 500n, [DEAD]: 70n };
  return {
    calls,
    publicClient: {
      getBalance: async () => parseEther("0.5"),
      readContract: async ({ functionName, args, address }: any) => {
        calls.push(functionName);
        if (opts.down) throw new Error("fetch failed");
        if (functionName === "balanceOf") return balances[address] ?? 0n;
        if (functionName === "getTokenInfo") {
          const token = args[0];
          if (token === DEAD) throw revert();
          return [2n, "0xm", zero, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, token === GRAD];
        }
        if (functionName === "trySell") return ["0xm", zero, args[1] * 2n, 0n];
        if (functionName === "tryBuy") return ["0xm", zero, args[2] * 10n, 0n, 0n, 0n, 0n, 0n];
        if (functionName === "getAmountsOut") {
          if (args[1][0] === DEAD) throw revert();
          return [args[0], args[0] * 3n];
        }
        throw new Error("unexpected " + functionName);
      },
    } as never,
  };
}

describe("valuing the wallet's holdings", () => {
  it("prices a token on the bonding curve with four.meme's own sell quote", async () => {
    const { publicClient, calls } = client();
    expect(await new FloatValuer(publicClient).quoteSell(CURVE, 1000n)).toBe(2000n);
    expect(calls).toContain("trySell");
  });

  it("prices a graduated token on PancakeSwap", async () => {
    expect(await new FloatValuer(client().publicClient).quoteSell(GRAD, 500n)).toBe(1500n);
  });

  it("a token with no price anywhere is worth zero, not an error", async () => {
    expect(await new FloatValuer(client().publicClient).quoteSell(DEAD, 70n)).toBe(0n);
  });

  it("an unreachable node is an error, never a silent zero", async () => {
    await expect(new FloatValuer(client({ down: true }).publicClient).quoteSell(CURVE, 1n)).rejects.toThrow(/fetch failed/);
  });

  it("totals the BNB and every named position", async () => {
    const h = await new FloatValuer(client().publicClient).holdings(WALLET, [CURVE, GRAD, DEAD]);
    expect(h.bnbWei).toBe(parseEther("0.5"));
    expect(h.positions.map((p) => p.valueWei)).toEqual([2000n, 1500n, 0n]);
    expect(h.positionsWei).toBe(3500n);
    expect(h.equityWei).toBe(parseEther("0.5") + 3500n);
  });

  it("an empty position costs no price lookup", async () => {
    const { publicClient, calls } = client();
    expect(await new FloatValuer(publicClient).quoteSell(CURVE, 0n)).toBe(0n);
    expect(calls).toEqual([]);
  });

  it("estimates the tokens a buy would bring", async () => {
    expect(await new FloatValuer(client().publicClient).quoteBuy(CURVE, 7n)).toBe(70n);
  });
});
