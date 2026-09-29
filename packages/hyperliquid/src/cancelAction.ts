/**
 * Builds a Hyperliquid `cancel` L1 action. Field order/shape per
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint/cancel-order(s)
 */
export interface BuildCancelActionInput {
  /** Hyperliquid asset index (see assetIndex.ts) - NOT the coin symbol. */
  assetIndex: number;
  /** The venue's own order id, as returned when the order was placed. */
  oid: number;
}

export function buildCancelAction(input: BuildCancelActionInput): Record<string, unknown> {
  return {
    type: "cancel",
    cancels: [{ a: input.assetIndex, o: input.oid }],
  };
}
