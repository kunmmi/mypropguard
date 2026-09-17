import { createHash } from "node:crypto";
import type { CanonicalOrderAction } from "@mypropguard/domain";

/**
 * PLACEHOLDER hash — NOT Hyperliquid's real wire format.
 *
 * Hyperliquid signs a phantom-agent EIP-712 message over `{source,
 * connectionId}`, where connectionId is Keccak256 of the MsgPack-encoded
 * action + nonce + vault/subaccount context + expiresAfter (see the
 * research doc's "Opaque Hyperliquid L1 Signatures" section). Reproducing
 * that exactly is real protocol work that should happen once a signer
 * vendor is chosen and benchmarked against Hyperliquid testnet — not
 * guessed at here.
 *
 * What this DOES prove: the architecture's exact-hash-authorization
 * invariant — one canonical action deterministically produces one id, so a
 * signer can refuse anything whose hash doesn't match what was authorized.
 * Swapping this for the real Hyperliquid scheme later changes only this
 * function, not the orchestration around it.
 */
export function computeConnectionId(action: CanonicalOrderAction): string {
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
