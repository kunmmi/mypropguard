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
 * Only values the Safe's native-token balance plus whatever ERC-20s are passed in as
 * `trackedTokens` (see EvmEquityQuery's NatSpec for why - there is no general way to enumerate
 * every token an address holds purely on-chain). A tracked token with no PancakeSwap pair against
 * either the stablecoin or wrapped-native token directly is valued at $0 rather than throwing, so
 * one illiquid/untradeable token can't break the whole equity read.
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

    const nativeBalanceWei = await this.publicClient.getBalance({ address: safeAddress });
    let total = await this.valueAmount(this.wrappedNativeAddress, NATIVE_TOKEN_DECIMALS, nativeBalanceWei);

    const seen = new Set<string>([ZERO_ADDRESS]);
    for (const rawToken of query.trackedTokens) {
      const token = rawToken.toLowerCase();
      if (seen.has(token)) continue; // native sentinel already counted above; skip duplicates
      seen.add(token);

      const tokenAddress = rawToken as Address;
      const [decimals, balance] = await Promise.all([
        this.readDecimals(tokenAddress),
        this.publicClient.readContract({
          address: tokenAddress,
          abi: erc20ReadAbi,
          functionName: "balanceOf",
          args: [safeAddress],
        }),
      ]);
      if (balance === 0n) continue;
      total = total.add(await this.valueAmount(tokenAddress, decimals, balance));
    }

    return total;
  }

  private async valueAmount(token: Address, decimals: number, rawAmount: bigint): Promise<Decimal> {
    if (rawAmount === 0n) return new Decimal(0);
    const amount = new Decimal(rawAmount.toString()).div(new Decimal(10).pow(decimals));

    if (token.toLowerCase() === this.stablecoinAddress.toLowerCase()) {
      return amount; // assumed ~$1 peg
    }

    const stableDecimals = await this.readStablecoinDecimals();

    const directPrice = await this.spotPriceInBase(token, decimals, this.stablecoinAddress, stableDecimals);
    if (directPrice) return amount.mul(directPrice);

    if (token.toLowerCase() === this.wrappedNativeAddress.toLowerCase()) {
      return new Decimal(0); // wrapped-native has no direct stablecoin pair and nothing further to route through
    }

    const priceInNative = await this.spotPriceInBase(token, decimals, this.wrappedNativeAddress, NATIVE_TOKEN_DECIMALS);
    const nativeInStable = await this.spotPriceInBase(this.wrappedNativeAddress, NATIVE_TOKEN_DECIMALS, this.stablecoinAddress, stableDecimals);
    if (priceInNative && nativeInStable) return amount.mul(priceInNative).mul(nativeInStable);

    return new Decimal(0);
  }

  /** Price of 1 unit of `token` expressed in units of `base`, read from their PancakeSwap pool reserves - null if no such pool exists. */
  private async spotPriceInBase(token: Address, tokenDecimals: number, base: Address, baseDecimals: number): Promise<Decimal | null> {
    const pairAddress = await this.publicClient.readContract({
      address: this.factoryAddress,
      abi: pancakeFactoryAbi,
      functionName: "getPair",
      args: [token, base],
    });
    if (pairAddress.toLowerCase() === ZERO_ADDRESS) return null;

    const [reserves, token0] = await Promise.all([
      this.publicClient.readContract({ address: pairAddress, abi: pancakePairAbi, functionName: "getReserves" }),
      this.publicClient.readContract({ address: pairAddress, abi: pancakePairAbi, functionName: "token0" }),
    ]);

    const [reserve0, reserve1] = reserves;
    const [reserveToken, reserveBase] = token0.toLowerCase() === token.toLowerCase() ? [reserve0, reserve1] : [reserve1, reserve0];
    if (reserveToken === 0n) return null;

    const tokenAmount = new Decimal(reserveToken.toString()).div(new Decimal(10).pow(tokenDecimals));
    const baseAmount = new Decimal(reserveBase.toString()).div(new Decimal(10).pow(baseDecimals));
    return baseAmount.div(tokenAmount);
  }

  private async readDecimals(token: Address): Promise<number> {
    const decimals = await this.publicClient.readContract({ address: token, abi: erc20ReadAbi, functionName: "decimals" });
    return Number(decimals);
  }

  private async readStablecoinDecimals(): Promise<number> {
    if (this.stablecoinDecimals === undefined) {
      this.stablecoinDecimals = await this.readDecimals(this.stablecoinAddress);
    }
    return this.stablecoinDecimals;
  }
}
