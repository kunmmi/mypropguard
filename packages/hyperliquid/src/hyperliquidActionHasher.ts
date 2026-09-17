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

  async computeConnectionId(action: CanonicalOrderAction): Promise<string> {
    const assetIndex = await fetchAssetIndex(action.coin, this.options.assetIndexOptions);

    const hyperliquidAction = buildOrderAction({
      assetIndex,
      isBuy: action.side === OrderSide.BUY,
      price: action.price.toString(),
      size: action.size.toString(),
      reduceOnly: action.reduceOnly,
      tif: this.options.tif ?? "Gtc",
    });

    return createL1ActionHash({ action: hyperliquidAction, nonce: action.nonce });
  }
}
