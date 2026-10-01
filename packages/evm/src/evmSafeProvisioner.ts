import type { Address } from "viem";
import type { EvmSafeProvisioner as EvmSafeProvisionerPort, ProvisionedEvmSafe } from "@mypropguard/domain";
import { SafeDeployer } from "./safeDeployer.js";

/**
 * Adapts packages/evm's real SafeDeployer to the domain EvmSafeProvisioner port apps/api expects
 * (the same role packages/hyperliquid's HyperliquidAgentWalletProvisioner plays for
 * AgentWalletProvisioner). One instance per chain - `chainId` here is just what gets echoed back
 * in ProvisionedEvmSafe, not used to pick an RPC (the SafeDeployer passed in already targets one
 * specific chain's RPC).
 */
export class EvmChainSafeProvisioner implements EvmSafeProvisionerPort {
  constructor(
    private readonly safeDeployer: SafeDeployer,
    private readonly chainId: number,
    private readonly guardAddress: Address,
  ) {}

  async provisionSafe(ownerWalletAddress: string): Promise<ProvisionedEvmSafe> {
    const { safeAddress } = await this.safeDeployer.deploySafeWithGuard({
      owner: ownerWalletAddress as Address,
      guard: this.guardAddress,
    });
    return { safeAddress, chainId: this.chainId };
  }
}
