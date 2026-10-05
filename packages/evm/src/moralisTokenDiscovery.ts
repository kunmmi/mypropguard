import type { EvmTokenDiscovery } from "@mypropguard/domain";

const MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2";
const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000";
const MAX_PAGES = 5;

export interface MoralisTokenDiscoveryOptions {
  apiKey: string;
  /** Moralis chain name, e.g. "bsc" or "eth". */
  chain: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface MoralisTokenRow {
  token_address?: string;
  native_token?: boolean;
  possible_spam?: boolean;
}

interface MoralisTokensResponse {
  result?: MoralisTokenRow[];
  cursor?: string | null;
}

/**
 * Lists the ERC-20s a wallet holds using Moralis's wallet-tokens API, with spam tokens filtered out
 * by Moralis. This is the one thing a plain RPC cannot do. The result only decides which tokens are
 * valued: a token's value is capped by what its pool could actually pay (see
 * PancakeSwapEquityReader), so a token that slips past the spam filter cannot inflate equity beyond
 * the real liquidity behind it.
 */
export class MoralisTokenDiscovery implements EvmTokenDiscovery {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MoralisTokenDiscoveryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async discoverTokens(safeAddress: string): Promise<string[]> {
    const tokens = new Set<string>();
    let cursor: string | null | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${MORALIS_BASE_URL}/wallets/${safeAddress}/tokens`);
      url.searchParams.set("chain", this.options.chain);
      url.searchParams.set("exclude_spam", "true");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);

      const response = await this.fetchImpl(url, { headers: { "X-API-Key": this.options.apiKey, accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`Moralis token discovery failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as MoralisTokensResponse;
      for (const row of body.result ?? []) {
        if (!row.token_address || row.native_token || row.possible_spam) continue;
        const address = row.token_address.toLowerCase();
        if (address !== NATIVE_PLACEHOLDER) tokens.add(address);
      }
      cursor = body.cursor;
      if (!cursor) break;
    }
    return [...tokens];
  }
}
