import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, erc20Abi, type Address, type PublicClient } from "viem";
import { FOUR_MEME_BSC, HELPER3_VIEW_ABI, PANCAKE_ROUTER_ABI, PANCAKE_V2_ROUTER, WBNB } from "./fourMeme.js";

export interface FloatPosition {
  token: Address;
  balance: bigint;
  /** What selling all of it would return in BNB, after fees. 0 when the token cannot be sold right now. */
  valueWei: bigint;
}

export interface FloatHoldings {
  bnbWei: bigint;
  positions: FloatPosition[];
  /** Total value of the positions in BNB. */
  positionsWei: bigint;
  /** BNB in the wallet plus the positions. */
  equityWei: bigint;
}

/** True for "the contract answered, and said no": a reverting quote means "no price", not "could not ask". */
function isNoPrice(error: unknown): boolean {
  return error instanceof BaseError && !!error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError);
}

/**
 * Prices what the wallet holds in BNB, using what the market would pay right now: four.meme's own sell quote while a
 * token is still on its bonding curve, PancakeSwap once it has moved there.
 *
 * A token with no price (no liquidity, a quote that reverts) is worth 0, which is the safe reading for a loss limit.
 * A failure to ask at all (the node is unreachable) throws, so a caller never mistakes "could not check" for "fine".
 */
export class FloatValuer {
  constructor(private readonly publicClient: Pick<PublicClient, "readContract" | "getBalance">) {}

  /** BNB returned by selling `amount` of `token` now. */
  async quoteSell(token: Address, amount: bigint): Promise<bigint> {
    if (amount === 0n) return 0n;
    try {
      const info = (await this.publicClient.readContract({ address: FOUR_MEME_BSC.helper3, abi: HELPER3_VIEW_ABI, functionName: "getTokenInfo", args: [token] })) as readonly unknown[];
      const quote = info[2] as Address;
      const graduated = info[11] as boolean;
      if (!graduated && quote === "0x0000000000000000000000000000000000000000") {
        const sell = (await this.publicClient.readContract({ address: FOUR_MEME_BSC.helper3, abi: HELPER3_VIEW_ABI, functionName: "trySell", args: [token, amount] })) as readonly unknown[];
        return sell[2] as bigint;
      }
    } catch (error) {
      if (!isNoPrice(error)) throw error;
    }
    try {
      const out = (await this.publicClient.readContract({ address: PANCAKE_V2_ROUTER, abi: PANCAKE_ROUTER_ABI, functionName: "getAmountsOut", args: [amount, [token, WBNB]] })) as readonly bigint[];
      return out[out.length - 1] ?? 0n;
    } catch (error) {
      if (isNoPrice(error)) return 0n;
      throw error;
    }
  }

  /** Tokens that `fundsWei` of BNB would buy on four.meme now (0 when it cannot be quoted). */
  async quoteBuy(token: Address, fundsWei: bigint): Promise<bigint> {
    try {
      const buy = (await this.publicClient.readContract({ address: FOUR_MEME_BSC.helper3, abi: HELPER3_VIEW_ABI, functionName: "tryBuy", args: [token, 0n, fundsWei] })) as readonly unknown[];
      return buy[2] as bigint;
    } catch (error) {
      if (isNoPrice(error)) return 0n;
      throw error;
    }
  }

  async balanceOf(token: Address, holder: Address): Promise<bigint> {
    return (await this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] })) as bigint;
  }

  async decimals(token: Address): Promise<number> {
    return Number(await this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
  }

  /** Everything the wallet holds, valued. Only the tokens named are counted: unsolicited airdrops cannot inflate it. */
  async holdings(wallet: Address, tokens: readonly Address[]): Promise<FloatHoldings> {
    const [bnbWei, positions] = await Promise.all([
      this.publicClient.getBalance({ address: wallet }),
      Promise.all(
        tokens.map(async (token): Promise<FloatPosition> => {
          const balance = await this.balanceOf(token, wallet);
          return { token, balance, valueWei: balance === 0n ? 0n : await this.quoteSell(token, balance) };
        }),
      ),
    ]);
    const positionsWei = positions.reduce((sum, p) => sum + p.valueWei, 0n);
    return { bnbWei, positions, positionsWei, equityWei: bnbWei + positionsWei };
  }
}
