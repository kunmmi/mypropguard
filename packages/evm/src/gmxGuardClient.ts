import type { Address, Chain, Hash, PublicClient, WalletClient, Account } from "viem";
import { gmxGuardAdminAbi } from "./abis.js";

/**
 * Admin-only on-chain rule configuration for GmxPositionLimitGuard
 * (packages/evm-guard/src/GmxPositionLimitGuard.sol). Every call here is a real transaction
 * signed by MyPropGuard's own admin wallet (the same address passed as `_admin` when the Guard
 * was deployed) - never the trader's key, matching the Guard's own `onlyAdmin` enforcement.
 */
export class GmxGuardClient {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly adminAccount: Account,
    private readonly chain: Chain,
    private readonly guardAddress: Address,
  ) {}

  /** @param maxPositionSizeUsd 30-decimal USD, matching GMX's own sizeDeltaUsd precision. */
  async setLimits(account: Address, maxPositionSizeUsd: bigint, maxTradesPerDay: bigint): Promise<Hash> {
    const txHash = await this.walletClient.writeContract({
      address: this.guardAddress,
      abi: gmxGuardAdminAbi,
      functionName: "setLimits",
      args: [account, maxPositionSizeUsd, maxTradesPerDay],
      account: this.adminAccount,
      chain: this.chain,
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }
}
