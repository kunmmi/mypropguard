import type { CanonicalOrderAction, SignedAction } from "@mypropguard/domain";
import { HyperliquidActionHasher, type HyperliquidActionHasherOptions } from "./hyperliquidActionHasher.js";
import { HyperliquidExchangeClient, type HyperliquidExchangeClientOptions } from "./exchangeClient.js";

export interface SubmitSignedOrderInput {
  signed: SignedAction;
  canonicalAction: CanonicalOrderAction;
  hasherOptions?: HyperliquidActionHasherOptions;
  exchangeClientOptions?: HyperliquidExchangeClientOptions;
}

/**
 * Rebuilds the exact wire-format action the signature was computed over and
 * submits it to Hyperliquid's real /exchange endpoint. This is the final
 * step after authorizeAndSignOrder (packages/execution) — everything before
 * this point can produce a valid signature without ever sending it anywhere.
 */
export async function submitSignedOrder(input: SubmitSignedOrderInput): Promise<unknown> {
  const hasher = new HyperliquidActionHasher(input.hasherOptions);
  const action = await hasher.buildAction(input.canonicalAction);

  const client = new HyperliquidExchangeClient(input.exchangeClientOptions);
  return client.submitAction({
    action,
    nonce: input.canonicalAction.nonce,
    signature: input.signed.signature as `0x${string}`,
  });
}
