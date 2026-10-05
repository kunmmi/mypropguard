import type { Address, PublicClient } from "viem";
import type { EvmSafeSnapshot, EvmSafeStateReader } from "@mypropguard/domain";
import { erc20ReadAbi } from "./abis.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const safeNonceAbi = [
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

const guardWithdrawnAbi = [
  {
    type: "function",
    name: "withdrawnTotal",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "asset", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface SafeStateReaderOptions {
  /** The chain's SpotRiskGuard, whose `withdrawnTotal` is read. Omit for a chain without one. */
  guardAddress?: Address;
  /** Tokens always watched even if token discovery has not found them: the wrapped native coin and stablecoins. */
  baseTokens: readonly Address[];
  /** Blocks behind the head that are treated as final. */
  confirmations?: number;
}

/**
 * Reads a Safe's state at one block with plain state calls: native balance, ERC-20 balances and the
 * Safe's transaction count (all in one multicall), plus the Guard's running withdrawal totals. No
 * event logs - the free public BNB Chain nodes refuse to serve them, while state reads work
 * everywhere. A Safe on an older Guard that has no `withdrawnTotal` simply reports zero withdrawals.
 */
export class SafeStateReader implements EvmSafeStateReader {
  private readonly confirmations: number;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly options: SafeStateReaderOptions,
  ) {
    this.confirmations = options.confirmations ?? 3;
  }

  async getSettledBlock(): Promise<number> {
    const head = Number(await this.publicClient.getBlockNumber());
    return Math.max(0, head - this.confirmations);
  }

  async getSnapshot(input: { safeAddress: string; extraAssets: readonly string[]; blockNumber: number }): Promise<EvmSafeSnapshot> {
    const safe = input.safeAddress as Address;
    const blockNumber = BigInt(input.blockNumber);

    const tokens = [...new Set([...this.options.baseTokens, ...input.extraAssets].map((t) => t.toLowerCase()))].filter(
      (t) => t !== ZERO_ADDRESS,
    ) as Address[];
    const assets: Address[] = [ZERO_ADDRESS, ...tokens];

    const [nativeBalance, nonce, balanceResults, withdrawnResults] = await Promise.all([
      this.publicClient.getBalance({ address: safe, blockNumber }),
      this.publicClient.readContract({ address: safe, abi: safeNonceAbi, functionName: "nonce", blockNumber }),
      tokens.length === 0
        ? Promise.resolve([])
        : this.publicClient.multicall({
            contracts: tokens.map((token) => ({ address: token, abi: erc20ReadAbi, functionName: "balanceOf", args: [safe] }) as const),
            allowFailure: true,
            blockNumber,
          }),
      this.options.guardAddress
        ? this.publicClient.multicall({
            contracts: assets.map(
              (asset) => ({ address: this.options.guardAddress!, abi: guardWithdrawnAbi, functionName: "withdrawnTotal", args: [safe, asset] }) as const,
            ),
            allowFailure: true,
            blockNumber,
          })
        : Promise.resolve([]),
    ]);

    const balances: Record<string, bigint> = { [ZERO_ADDRESS]: nativeBalance };
    tokens.forEach((token, i) => {
      const result = balanceResults[i];
      if (result && result.status === "success") balances[token] = result.result as bigint;
    });

    const withdrawn: Record<string, bigint> = {};
    assets.forEach((asset, i) => {
      const result = withdrawnResults[i];
      withdrawn[asset] = result && result.status === "success" ? (result.result as bigint) : 0n;
    });

    return { blockNumber: input.blockNumber, nonce: Number(nonce), balances, withdrawn };
  }
}
