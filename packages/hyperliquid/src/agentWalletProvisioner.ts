import type { AgentWalletProvisioner, ProvisionedAgentWallet } from "@mypropguard/domain";
import type { PrivyClient } from "./privyClient.js";

/**
 * Real, working AgentWalletProvisioner: creates a fresh Privy-managed
 * Ethereum wallet for one account. Verified against the live Privy API
 * elsewhere in this package (privySignerGateway.integration.test.ts already
 * calls privyClient.createEthereumWallet() for real) - this just wraps that
 * same call behind the venue-agnostic domain port.
 *
 * Provisioning a wallet here does not approve it as a Hyperliquid agent -
 * that's a real signature only the account owner can give, on Hyperliquid's
 * own site, with the address this returns.
 */
export class HyperliquidAgentWalletProvisioner implements AgentWalletProvisioner {
  constructor(private readonly privyClient: PrivyClient) {}

  async provisionWallet(): Promise<ProvisionedAgentWallet> {
    const wallet = await this.privyClient.createEthereumWallet();
    return { walletId: wallet.id, walletAddress: wallet.address };
  }
}
