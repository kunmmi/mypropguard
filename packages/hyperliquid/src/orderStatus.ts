import type { VenueOrderLifecycleStatus, VenueOrderStatus } from "@mypropguard/domain";
import { HYPERLIQUID_MAINNET_INFO_URL } from "./infoClient.js";

export interface FetchOrderStatusOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RawOrderStatusResponse {
  status: "order" | "unknownOid";
  order?: {
    order: unknown;
    status: string;
    statusTimestamp: number;
  };
}

/** Maps Hyperliquid's raw per-order status string to the normalized venue-agnostic shape. */
function mapStatus(raw: string): VenueOrderLifecycleStatus {
  switch (raw) {
    case "open":
      return "OPEN";
    case "filled":
      return "FILLED";
    case "canceled":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

/**
 * Real Hyperliquid order-status read (public, no credentials). Verified
 * against the live testnet API on 2026-09-29: a real resting order returns
 * `{status:"order", order:{order:{...}, status:"open", ...}}`; an unknown
 * oid returns `{status:"unknownOid"}`.
 */
export async function fetchOrderStatus(
  address: string,
  oid: number,
  options: FetchOrderStatusOptions = {},
): Promise<VenueOrderStatus> {
  const baseUrl = options.baseUrl ?? HYPERLIQUID_MAINNET_INFO_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "orderStatus", user: address, oid }),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid orderStatus request failed: ${response.status} ${await response.text()}`);
  }

  const raw = (await response.json()) as RawOrderStatusResponse;
  if (raw.status === "unknownOid" || !raw.order) {
    return { status: "UNKNOWN" };
  }
  return { status: mapStatus(raw.order.status) };
}
