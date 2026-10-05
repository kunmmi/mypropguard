import type { EvmTokenDiscovery } from "@mypropguard/domain";

const GOLDRUSH_BASE_URL = "https://api.covalenthq.com/v1";
const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000";
const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export interface GoldRushTokenDiscoveryOptions {
  apiKey: string;
  /** GoldRush chain name, e.g. "bsc-mainnet" or "eth-mainnet". */
  chain: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface GoldRushItem {
  contract_address?: string;
  native_token?: boolean;
  is_spam?: boolean;
  balance?: string | null;
}

interface GoldRushResponse {
  data?: { items?: GoldRushItem[] };
  error?: boolean;
  error_message?: string | null;
}

/**
 * Lists the ERC-20s a wallet holds using GoldRush's (Covalent's) balances API, with spam tokens
 * filtered out by GoldRush. Same job and same safety reasoning as MoralisTokenDiscovery: it only
 * decides which tokens are valued, and a token's value is capped by what its pool could really pay.
 */
export class GoldRushTokenDiscovery implements EvmTokenDiscovery {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GoldRushTokenDiscoveryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async discoverTokens(safeAddress: string): Promise<string[]> {
    const url = new URL(`${GOLDRUSH_BASE_URL}/${this.options.chain}/address/${safeAddress}/balances_v2/`);
    url.searchParams.set("no-spam", "true");

    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as GoldRushResponse;
    if (!response.ok || body.error) {
      const detail = body.error_message ? ` (${String(body.error_message).slice(0, 200)})` : "";
      throw new Error(`GoldRush token discovery failed: HTTP ${response.status}${detail}`);
    }

    const tokens = new Set<string>();
    for (const item of body.data?.items ?? []) {
      if (!item.contract_address || item.native_token || item.is_spam) continue;
      const address = item.contract_address.toLowerCase();
      if (address === NATIVE_PLACEHOLDER || address === NATIVE_SENTINEL) continue;
      tokens.add(address);
    }
    return [...tokens];
  }
}
