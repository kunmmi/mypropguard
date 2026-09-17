import { HYPERLIQUID_MAINNET_INFO_URL } from "./infoClient.js";

export interface FetchAssetIndexOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface RawMetaResponse {
  universe: Array<{ name: string }>;
}

/**
 * Resolves a coin symbol (e.g. "BTC") to Hyperliquid's numeric asset index,
 * required by the `a` field in an order action. Public read, no credentials.
 */
export async function fetchAssetIndex(coin: string, options: FetchAssetIndexOptions = {}): Promise<number> {
  const baseUrl = options.baseUrl ?? HYPERLIQUID_MAINNET_INFO_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  const response = await fetchImpl(baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "meta" }),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid meta request failed: ${response.status} ${await response.text()}`);
  }

  const raw = (await response.json()) as RawMetaResponse;
  const index = raw.universe.findIndex((asset) => asset.name === coin);
  if (index === -1) {
    throw new Error(`Unknown Hyperliquid asset: ${coin}`);
  }
  return index;
}
