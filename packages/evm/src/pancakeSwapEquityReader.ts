import type { Address, PublicClient } from "viem";
import { Decimal } from "decimal.js";
import type { EvmEquityQuery, EvmSafeEquityReader } from "@mypropguard/domain";
import { erc20ReadAbi, pancakeFactoryAbi, pancakePairAbi } from "./abis.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const NATIVE_TOKEN_DECIMALS = 18;

/**
 * Prices an EVM Safe's holdings in USD using PancakeSwap's own pool reserves as the price source -
 * no external oracle. This is a deliberate choice, not a shortcut: this product's whole premise is
 * on-chain enforcement for PancakeSwap trading, and pool-reserve pricing covers the long-tail
 * tokens traders on this platform actually hold, which a Chainlink-style feed (major assets only)
 * never would. The tradeoff: a pool's spot price can be briefly skewed by a large trade or, in the
 * worst case, deliberately manipulated (e.g. a flash loan) within the same block a reconciliation
 * reads it. That's an acceptable risk here because this number only drives a risk-monitoring
 * freeze decision, not a fund-moving settlement - the worst case of a bad read is a wrongly
 * frozen/unfrozen account, not a theft. Revisit this if max-daily-loss enforcement is ever used to
 * gate something with a higher cost of being wrong (e.g. an on-chain payout).
 *
 * Values the Safe's native-token balance plus the ERC-20s passed in as `trackedTokens` (see
 * EvmEquityQuery's NatSpec for why only those). A token is valued by what selling the WHOLE balance
 * into its PancakeSwap pools would actually return (constant-product maths with the 0.25% fee), not
 * by the pool's marginal price: that caps a token's value at what the pool can really pay out, so a
 * worthless token with a fake pool cannot inflate the Safe's equity. A token with no V2 pair against
 * the stablecoin or the wrapped-native token is valued at $0 rather than throwing, so one
 * illiquid token can't break the whole equity read.
 */
export class PancakeSwapEquityReader implements EvmSafeEquityReader {
  private stablecoinDecimals: number | undefined;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly factoryAddress: Address,
    /** PancakeSwap's wrapped native token (WBNB on BSC, WETH on Ethereum/Uniswap). */
    private readonly wrappedNativeAddress: Address,
    /** A liquid USD stablecoin most tokens of interest are directly paired against (e.g. USDT on BSC). */
    private readonly stablecoinAddress: Address,
  ) {}

  async getEquityUsd(query: EvmEquityQuery): Promise<Decimal> {
    const safeAddress = query.safeAddress as Address;
    const blockNumber = query.blockNumber === undefined ? undefined : BigInt(query.blockNumber);

    const nativeBalanceWei = await this.publicClient.getBalance({ address: safeAddress, blockNumber });
    let total = await this.valueAmount(ZERO_ADDRESS, nativeBalanceWei, blockNumber);

    const seen = new Set<string>([ZERO_ADDRESS]);
    for (const rawToken of query.trackedTokens) {
      const token = rawToken.toLowerCase();
      if (seen.has(token)) continue; // native sentinel already counted above; skip duplicates
      seen.add(token);

      const tokenAddress = rawToken as Address;
      const balance = await this.publicClient.readContract({
        address: tokenAddress,
        abi: erc20ReadAbi,
        functionName: "balanceOf",
        args: [safeAddress],
        blockNumber,
      });
      if (balance === 0n) continue;
      total = total.add(await this.valueAmount(tokenAddress, balance, blockNumber));
    }

    return total;
  }

  async getTokenValueUsd(token: string, rawAmount: bigint, blockNumber?: number): Promise<Decimal> {
    return this.valueAmount(token as Address, rawAmount, blockNumber === undefined ? undefined : BigInt(blockNumber));
  }

  /** The zero address means the native coin, valued as its wrapped form. */
  private async valueAmount(rawToken: Address, rawAmount: bigint, blockNumber: bigint | undefined): Promise<Decimal> {
    if (rawAmount === 0n) return new Decimal(0);
    const isNative = rawToken.toLowerCase() === ZERO_ADDRESS;
    const token = isNative ? this.wrappedNativeAddress : rawToken;
    const decimals = isNative ? NATIVE_TOKEN_DECIMALS : await this.readDecimals(token, blockNumber);
    const stableDecimals = await this.readStablecoinDecimals(blockNumber);

    if (token.toLowerCase() === this.stablecoinAddress.toLowerCase()) {
      return new Decimal(rawAmount.toString()).div(new Decimal(10).pow(decimals)); // assumed ~$1 peg
    }

    const directOut = await this.quote(token, this.stablecoinAddress, rawAmount, blockNumber);
    if (directOut !== null) return this.toUsd(directOut, stableDecimals);

    if (token.toLowerCase() === this.wrappedNativeAddress.toLowerCase()) {
      return new Decimal(0); // no direct stablecoin pair and nothing further to route through
    }

    const nativeOut = await this.quote(token, this.wrappedNativeAddress, rawAmount, blockNumber);
    if (nativeOut === null) return new Decimal(0);
    const stableOut = await this.quote(this.wrappedNativeAddress, this.stablecoinAddress, nativeOut, blockNumber);
    return stableOut === null ? new Decimal(0) : this.toUsd(stableOut, stableDecimals);
  }

  private toUsd(rawStable: bigint, stableDecimals: number): Decimal {
    return new Decimal(rawStable.toString()).div(new Decimal(10).pow(stableDecimals));
  }

  /**
   * What swapping `amountIn` of `tokenIn` for `tokenOut` in their direct PancakeSwap V2 pool would
   * return, in `tokenOut` base units - null if there is no pool. Constant product with the 0.25% fee.
   */
  private async quote(tokenIn: Address, tokenOut: Address, amountIn: bigint, blockNumber: bigint | undefined): Promise<bigint | null> {
    const pairAddress = await this.publicClient.readContract({
      address: this.factoryAddress,
      abi: pancakeFactoryAbi,
      functionName: "getPair",
      args: [tokenIn, tokenOut],
      blockNumber,
    });
    if (pairAddress.toLowerCase() === ZERO_ADDRESS) return null;

    const [reserves, token0] = await Promise.all([
      this.publicClient.readContract({ address: pairAddress, abi: pancakePairAbi, functionName: "getReserves", blockNumber }),
      this.publicClient.readContract({ address: pairAddress, abi: pancakePairAbi, functionName: "token0", blockNumber }),
    ]);

    const [reserve0, reserve1] = reserves;
    const [reserveIn, reserveOut] = token0.toLowerCase() === tokenIn.toLowerCase() ? [reserve0, reserve1] : [reserve1, reserve0];
    if (reserveIn === 0n || reserveOut === 0n) return null;

    const amountInWithFee = amountIn * 9975n;
    return (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);
  }

  private async readDecimals(token: Address, blockNumber: bigint | undefined): Promise<number> {
    const decimals = await this.publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "decimals", blockNumber });
    return Number(decimals);
  }

  private async readStablecoinDecimals(blockNumber: bigint | undefined): Promise<number> {
    if (this.stablecoinDecimals === undefined) {
      this.stablecoinDecimals = await this.readDecimals(this.stablecoinAddress, blockNumber);
    }
    return this.stablecoinDecimals;
  }
}
