import type { ActionAuthorization, CanonicalOrderAction, SignedAction, SignerGateway } from "@mypropguard/domain";
import type { FetchAssetIndexOptions } from "./assetIndex.js";
import { HYPERLIQUID_MAINNET_INFO_URL, HYPERLIQUID_TESTNET_INFO_URL } from "./infoClient.js";
import type { TimeInForce } from "./orderAction.js";
import { buildAgentTypedData } from "./signing.js";
import { HyperliquidActionHasher } from "./hyperliquidActionHasher.js";
import type { PrivyClient } from "./privyClient.js";

export interface PrivySignerGatewayOptions {
  privyClient: PrivyClient;
  /** The Privy wallet id previously provisioned as the Hyperliquid agent wallet. */
  walletId: string;
  walletAddress: `0x${string}`;
  isTestnet: boolean;
  tif?: TimeInForce;
  assetIndexOptions?: FetchAssetIndexOptions;
}

/**
 * REAL Hyperliquid + Privy signer. Independently recomputes the REAL
 * connectionId via HyperliquidActionHasher (real asset index, real order
 * action, real MsgPack + Keccak256 hash), refuses to sign anything that
 * doesn't match the authorization it was handed (default-deny), and signs
 * the phantom-agent EIP-712 message with a Privy-managed key.
 *
 * This CAN produce a signature Hyperliquid's real validator would accept —
 * but nothing in this codebase submits it anywhere. There is no funded or
 * approved agent wallet, so even a correct signature here cannot move funds
 * or place a live order. Verified end-to-end (real hash -> real Privy
 * signature -> recovers to the wallet address via viem) on 2026-09-17.
 *
 * `isTestnet` also picks the matching Info API for asset index resolution
 * unless `assetIndexOptions.baseUrl` is given explicitly. Mainnet and
 * testnet do NOT share the same coin-to-index mapping — resolving "BTC" on
 * mainnet's universe and submitting that index to testnet can silently
 * place an order on an entirely different asset. Discovered for real:
 * asking for BTC and getting a resting SOL order on testnet, traced to this
 * exact mismatch.
 */
export class PrivySignerGateway implements SignerGateway {
  private readonly hasher: HyperliquidActionHasher;

  constructor(private readonly options: PrivySignerGatewayOptions) {
    const defaultInfoUrl = options.isTestnet ? HYPERLIQUID_TESTNET_INFO_URL : HYPERLIQUID_MAINNET_INFO_URL;
    this.hasher = new HyperliquidActionHasher({
      tif: options.tif,
      assetIndexOptions: { baseUrl: defaultInfoUrl, ...options.assetIndexOptions },
    });
  }

  async signExact(authorization: ActionAuthorization, action: CanonicalOrderAction): Promise<SignedAction> {
    const connectionId = await this.hasher.computeConnectionId(action);

    if (connectionId !== authorization.connectionId) {
      throw new Error(
        "Refused to sign: authorization connectionId does not match the real Hyperliquid action hash.",
      );
    }
    if (authorization.expiresAt.getTime() < Date.now()) {
      throw new Error("Refused to sign: authorization has expired.");
    }

    const typedData = buildAgentTypedData(connectionId as `0x${string}`, this.options.isTestnet);
    const signature = await this.options.privyClient.signTypedData(this.options.walletId, typedData);

    return {
      authorization,
      signature,
      signerAddress: this.options.walletAddress,
    };
  }
}
