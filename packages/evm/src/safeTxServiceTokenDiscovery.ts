import type { EvmTokenDiscovery } from "@mypropguard/domain";

const MAX_PAGES = 20;
const PAGE_SIZE = 100;

export interface SafeTxServiceTokenDiscoveryOptions {
  /** Safe Transaction Service chain slug, e.g. "bnb" for BNB Chain or "eth" for Ethereum. */
  chainSlug: string;
  /** Optional API key, sent as a bearer token if Safe starts requiring one. */
  apiKey?: string;
  /** Override for tests or a self-hosted service. */
  baseUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface Page<T> {
  count?: number;
  next?: string | null;
  results?: T[];
}

interface MultisigTx {
  nonce: number;
  transactionHash?: string | null;
  isExecuted?: boolean;
}

interface Transfer {
  type?: string;
  to?: string;
  tokenAddress?: string | null;
  transactionHash?: string | null;
}

/**
 * Finds the ERC-20s a Safe acquired by trading, from Safe's own free Transaction Service - no sign-up
 * or key. It indexes every transfer in or out of a Safe (for Safes built on the L2 singleton).
 *
 * A token counts only if it arrived during one of the Safe's own executed transactions, so tokens
 * simply airdropped to the Safe are ignored and cannot inflate its equity. The index lags the chain
 * by seconds to minutes, so the answer is checked against the Safe's on-chain transaction count: if the
 * service has not yet seen every executed transaction, this throws instead of returning a list that
 * would miss the newest buy.
 */
export class SafeTxServiceTokenDiscovery implements EvmTokenDiscovery {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: SafeTxServiceTokenDiscoveryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? `https://api.safe.global/tx-service/${options.chainSlug}/api/v1`).replace(/\/$/, "");
  }

  async discoverTokens(safeAddress: string, context?: { nonce: number }): Promise<string[]> {
    const expectedExecuted = context?.nonce;
    const safeLower = safeAddress.toLowerCase();

    const executed = await this.getAll<MultisigTx>(`/safes/${safeAddress}/multisig-transactions/?executed=true&limit=${PAGE_SIZE}`, expectedExecuted === 0);
    const executedHashes = new Set<string>();
    for (const tx of executed) {
      if (tx.transactionHash) executedHashes.add(tx.transactionHash.toLowerCase());
    }
    if (expectedExecuted !== undefined && executed.length < expectedExecuted) {
      throw new Error(
        `Safe Transaction Service has indexed ${executed.length} of ${expectedExecuted} executed transactions for ${safeAddress}; retry shortly`,
      );
    }
    if (executedHashes.size === 0) return [];

    const transfers = await this.getAll<Transfer>(`/safes/${safeAddress}/transfers/?erc20=true&limit=${PAGE_SIZE}`, false);
    const tokens = new Set<string>();
    for (const transfer of transfers) {
      if (!transfer.tokenAddress || !transfer.to || !transfer.transactionHash) continue;
      if (transfer.to.toLowerCase() !== safeLower) continue;
      if (!executedHashes.has(transfer.transactionHash.toLowerCase())) continue;
      tokens.add(transfer.tokenAddress.toLowerCase());
    }
    return [...tokens];
  }

  private async getAll<T>(path: string, notFoundIsEmpty: boolean): Promise<T[]> {
    const out: T[] = [];
    let url: string | null | undefined = `${this.baseUrl}${path}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const response = await this.fetchImpl(url, {
        headers: { accept: "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
      });
      if (response.status === 404 && notFoundIsEmpty) return [];
      if (!response.ok) {
        throw new Error(`Safe Transaction Service request failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as Page<T>;
      out.push(...(body.results ?? []));
      url = body.next;
    }
    return out;
  }
}
