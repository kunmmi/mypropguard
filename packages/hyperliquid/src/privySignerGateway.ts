import type { ActionAuthorization, CanonicalOrderAction, SignedAction, SignerGateway } from "@mypropguard/domain";
import { OrderSide } from "@mypropguard/domain";
import { fetchAssetIndex, type FetchAssetIndexOptions } from "./assetIndex.js";
import { buildOrderAction, type TimeInForce } from "./orderAction.js";
import { buildAgentTypedData, createL1ActionHash } from "./signing.js";
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
 * REAL Hyperliquid + Privy signer. Builds the actual Hyperliquid order
 * action (with a real asset index resolved from Hyperliquid's public meta
 * endpoint), computes the REAL connectionId (MsgPack + Keccak256, see
 * signing.ts), independently verifies it matches the authorization it was
 * handed (default-deny), and signs the phantom-agent EIP-712 message with a
 * Privy-managed key.
 *
 * This CAN produce a signature Hyperliquid's real validator would accept —
 * but nothing in this codebase submits it anywhere. There is no funded or
 * approved agent wallet, so even a correct signature here cannot move funds
 * or place a live order. Verified end-to-end (real hash -> real Privy
 * signature -> recovers to the wallet address via viem) on 2026-09-17.
 */
export class PrivySignerGateway implements SignerGateway {
  constructor(private readonly options: PrivySignerGatewayOptions) {}

  async signExact(authorization: ActionAuthorization, action: CanonicalOrderAction): Promise<SignedAction> {
    const assetIndex = await fetchAssetIndex(action.coin, this.options.assetIndexOptions);

    const hyperliquidAction = buildOrderAction({
      assetIndex,
      isBuy: action.side === OrderSide.BUY,
      price: action.price.toString(),
      size: action.size.toString(),
      reduceOnly: action.reduceOnly,
      tif: this.options.tif ?? "Gtc",
    });

    const connectionId = createL1ActionHash({ action: hyperliquidAction, nonce: action.nonce });

    if (connectionId !== authorization.connectionId) {
      throw new Error(
        "Refused to sign: authorization connectionId does not match the real Hyperliquid action hash.",
      );
    }
    if (authorization.expiresAt.getTime() < Date.now()) {
      throw new Error("Refused to sign: authorization has expired.");
    }

    const typedData = buildAgentTypedData(connectionId, this.options.isTestnet);
    const signature = await this.options.privyClient.signTypedData(this.options.walletId, typedData);

    return {
      authorization,
      signature,
      signerAddress: this.options.walletAddress,
    };
  }
}
