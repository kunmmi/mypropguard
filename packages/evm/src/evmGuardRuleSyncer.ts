import type { Address, PublicClient } from "viem";
import { Decimal } from "decimal.js";
import { RuleType, type EvmGuardRuleSyncer as EvmGuardRuleSyncerPort, type EvmRuleSyncInput } from "@mypropguard/domain";
import { SpotGuardClient } from "./spotGuardClient.js";

const erc20DecimalsAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
const NATIVE_TOKEN_DECIMALS = 18;

/**
 * Pushes MAX_POSITION_SIZE/MAX_TRADE_FREQUENCY rule changes to a deployed PancakeSwapLimitGuard or
 * UniswapLimitGuard (packages/evm-guard, identical ABI - `guardClient` is already pointed at the
 * right deployed address for its chain). Resolves each ERC-20's decimals live via `publicClient`
 * rather than storing them on the rule - decimals are a property of the token, not something a
 * trader's dollar-denominated rule param should need to carry around.
 */
export class EvmChainGuardRuleSyncer implements EvmGuardRuleSyncerPort {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly guardClient: SpotGuardClient,
  ) {}

  async syncRule(input: EvmRuleSyncInput): Promise<void> {
    if (input.ruleType === RuleType.MAX_POSITION_SIZE) {
      if (!input.tokenAddress) {
        throw new Error("MAX_POSITION_SIZE rule sync requires tokenAddress");
      }
      const token = input.tokenAddress as Address;
      const decimals = token.toLowerCase() === ZERO_ADDRESS ? NATIVE_TOKEN_DECIMALS : await this.readDecimals(token);
      const amount = BigInt(input.param.mul(new Decimal(10).pow(decimals)).toFixed(0));
      await this.guardClient.setTokenLimit(input.safeAddress as Address, token, amount);
      return;
    }

    if (input.ruleType === RuleType.MAX_TRADE_FREQUENCY) {
      const limit = BigInt(input.param.toFixed(0));
      await this.guardClient.setMaxTradesPerDay(input.safeAddress as Address, limit);
      return;
    }

    throw new Error(`EvmChainGuardRuleSyncer does not support rule type ${input.ruleType}`);
  }

  async freezeForToday(safeAddress: string): Promise<void> {
    await this.guardClient.recordDailyLossBreach(safeAddress as Address);
  }

  private async readDecimals(token: Address): Promise<number> {
    const decimals = await this.publicClient.readContract({
      address: token,
      abi: erc20DecimalsAbi,
      functionName: "decimals",
    });
    return Number(decimals);
  }
}
