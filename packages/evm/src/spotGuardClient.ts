import type { Address, Chain, Hash, PublicClient, WalletClient, Account } from "viem";
import { spotGuardAdminAbi } from "./abis.js";

/** Mirrors PancakeSwapLimitGuard.sol / UniswapLimitGuard.sol's `RouterKind` enum exactly - order matters. */
export enum RouterKind {
  None = 0,
  V2 = 1,
  V3NoDeadline = 2,
  V3WithDeadline = 3,
}

/**
 * Admin-only on-chain rule configuration for PancakeSwapLimitGuard and UniswapLimitGuard
 * (packages/evm-guard/src) - identical ABI on both contracts, so one client class serves either,
 * parameterized by which deployed Guard address to call.
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
   * Freezes or unfreezes an account's ability to trade through any registered router - called
   * after computing off-chain (see packages/risk-ledger's checkAndEnforceDailyLossFreeze) that the
   * account has breached its max-daily-loss rule. See the contract's own NatSpec for the trust
   * tradeoff this represents.
   */
  async setFrozen(account: Address, isFrozen: boolean): Promise<Hash> {
    const txHash = await this.walletClient.writeContract({
      address: this.guardAddress,
      abi: spotGuardAdminAbi,
      functionName: "setFrozen",
      args: [account, isFrozen],
      account: this.adminAccount,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** Registers or removes (RouterKind.None) a router address this Guard should decode. */
  async setRouterKind(routerAddress: Address, kind: RouterKind): Promise<Hash> {
    const txHash = await this.walletClient.writeContract({
      address: this.guardAddress,
      abi: spotGuardAdminAbi,
      functionName: "setRouterKind",
      args: [routerAddress, kind],
      account: this.adminAccount,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
}
