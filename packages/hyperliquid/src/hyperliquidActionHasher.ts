import type { ActionHasher, CanonicalOrderAction } from "@mypropguard/domain";
import { OrderSide } from "@mypropguard/domain";
import { fetchAssetIndex, type FetchAssetIndexOptions } from "./assetIndex.js";
import { buildOrderAction, type TimeInForce } from "./orderAction.js";
import { createL1ActionHash } from "./signing.js";

export interface HyperliquidActionHasherOptions {
  tif?: TimeInForce;
  assetIndexOptions?: FetchAssetIndexOptions;
}

/**
 * REAL Hyperliquid ActionHasher: resolves the real asset index, builds the
 * real order action, and computes the real connectionId (MsgPack +
 * Keccak256 — see signing.ts). This is what makes `authorizeAndSignOrder`
 * (packages/execution) produce an authorization that PrivySignerGateway
 * will actually accept, instead of the offline placeholder hash.
 */
export class HyperliquidActionHasher implements ActionHasher {
  constructor(private readonly options: HyperliquidActionHasherOptions = {}) {}

  /**
   * The exact wire-format action object this hasher hashes — needed
   * verbatim (same key order) to submit to the real /exchange endpoint
   * alongside the signature, since the venue recomputes the same hash from
   * the action it's given.
   */
  async buildAction(action: CanonicalOrderAction): Promise<Record<string, unknown>> {
    const assetIndex = await fetchAssetIndex(action.coin, this.options.assetIndexOptions);

    return buildOrderAction({
      assetIndex,
      isBuy: action.side === OrderSide.BUY,
      price: action.price.toString(),
      size: action.size.toString(),
      reduceOnly: action.reduceOnly,
      tif: this.options.tif ?? "Gtc",
    });
  }

  async computeConnectionId(action: CanonicalOrderAction): Promise<string> {
    const hyperliquidAction = await this.buildAction(action);
    return createL1ActionHash({ action: hyperliquidAction, nonce: action.nonce });
  }
}
