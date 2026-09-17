import { createHash } from "node:crypto";
import type { ActionHasher, CanonicalOrderAction } from "@mypropguard/domain";

/**
 * PLACEHOLDER hash — NOT Hyperliquid's real wire format. Use
 * HyperliquidActionHasher (packages/hyperliquid) for anything that needs to
 * produce a signature Hyperliquid would actually accept; this exists so the
 * orchestrator and FakeSignerGateway can be tested fast and offline, with
 * no real venue/network dependency.
 *
 * What this DOES prove: the architecture's exact-hash-authorization
 * invariant — one canonical action deterministically produces one id, so a
 * signer can refuse anything whose hash doesn't match what was authorized.
 * Swapping the hasher for HyperliquidActionHasher changes only which hash
 * gets computed, not the orchestration around it (see authorizeAndSign.ts).
 */
export class PlaceholderActionHasher implements ActionHasher {
  async computeConnectionId(action: CanonicalOrderAction): Promise<string> {
    const canonicalJson = JSON.stringify({
      accountId: action.accountId,
      clientIntentId: action.clientIntentId,
      coin: action.coin,
      side: action.side,
      size: action.size.toString(),
      price: action.price.toString(),
      reduceOnly: action.reduceOnly,
      nonce: action.nonce,
      expiresAt: action.expiresAt.toISOString(),
    });

    return createHash("sha256").update(canonicalJson).digest("hex");
  }
}
