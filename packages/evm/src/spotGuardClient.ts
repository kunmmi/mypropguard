import type { Address, Chain, Hash, PublicClient, WalletClient, Account } from "viem";
import { spotGuardAdminAbi } from "./abis.js";

/**
 * Admin-only on-chain rule configuration for SpotRiskGuard (packages/evm-guard/src), and for the
 * older PancakeSwapLimitGuard/UniswapLimitGuard, which share the limit/freeze functions used here.
 */
export class SpotGuardClient {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly adminAccount: Account,
    private readonly chain: Chain,
    private readonly guardAddress: Address,
  ) {}

  /** @param token Use the zero address for the chain's native token (ETH/BNB) - matches the Guard's own NATIVE_ETH/NATIVE_BNB sentinel. */
  async setTokenLimit(account: Address, token: Address, amount: bigint): Promise<Hash> {
    const txHash = await this.walletClient.writeContract({
      address: this.guardAddress,
      abi: spotGuardAdminAbi,
      functionName: "setTokenLimit",
      args: [account, token, amount],
      account: this.adminAccount,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  async setMaxTradesPerDay(account: Address, limit: bigint): Promise<Hash> {
    const txHash = await this.walletClient.writeContract({
      address: this.guardAddress,
      abi: spotGuardAdminAbi,
      functionName: "setMaxTradesPerDay",
      args: [account, limit],
      account: this.adminAccount,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /**
   * Records that an account has breached its max-daily-loss rule today, freezing it through the
   * end of the current UTC day - called after computing off-chain (see packages/risk-ledger's
   * checkAndEnforceDailyLossFreeze) that a breach occurred. One-directional: there is no
   * corresponding "unfreeze" call, by design - see the contract's own NatSpec for the trust
   * tradeoff this represents and the guarantee it makes (no one, including the admin, can lift a
   * freeze before the day rolls over on its own).
   */
  async recordDailyLossBreach(account: Address): Promise<Hash> {
    const txHash = await this.walletClient.writeContract({
      address: this.guardAddress,
      abi: spotGuardAdminAbi,
      functionName: "recordDailyLossBreach",
      args: [account],
      account: this.adminAccount,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** Allows or disallows a router/contract as a spender traders may approve base assets to. */
  async setAllowedSpender(spender: Address, allowed: boolean): Promise<Hash> {
    const txHash = await this.walletClient.writeContract({
      address: this.guardAddress,
      abi: spotGuardAdminAbi,
      functionName: "setAllowedSpender",
      args: [spender, allowed],
      account: this.adminAccount,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
}
