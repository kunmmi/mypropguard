export interface PrivyClientOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface PrivyWallet {
  id: string;
  address: string;
  chainType: string;
}

interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Minimal Privy REST client for what this project needs: creating an
 * Ethereum server wallet and signing EIP-712 typed data with it. Verified
 * against the real Privy API on 2026-09-17 (both calls return 200, and the
 * resulting signature recovers to the wallet's own address via viem's
 * verifyTypedData — see test/privySigning.integration.test.ts).
 */
export class PrivyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;

  constructor(private readonly options: PrivyClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.privy.io";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authHeader = `Basic ${Buffer.from(`${options.appId}:${options.appSecret}`).toString("base64")}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: this.authHeader,
      "privy-app-id": this.options.appId,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async createEthereumWallet(): Promise<PrivyWallet> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/wallets`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ chain_type: "ethereum" }),
    });

    if (!response.ok) {
      throw new Error(`Privy createEthereumWallet failed: ${response.status} ${await response.text()}`);
    }

    const raw = (await response.json()) as { id: string; address: string; chain_type: string };
    return { id: raw.id, address: raw.address, chainType: raw.chain_type };
  }

  /**
   * Signs a text message (EIP-191 personal_sign) with a wallet. Request and response shapes follow Privy's REST docs
   * (docs.privy.io/api-reference/wallets/ethereum/personal-sign): `params.message` + `params.encoding`, answered with
   * `data.signature`. Callers must have approved the message first (packages/evm loginMessage.ts).
   */
  async personalSign(walletId: string, message: string): Promise<`0x${string}`> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/wallets/${walletId}/rpc`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ method: "personal_sign", params: { message, encoding: "utf-8" } }),
    });
    if (!response.ok) {
      throw new Error(`Privy personalSign failed: ${response.status} ${await response.text()}`);
    }
    const raw = (await response.json()) as { data?: { signature?: `0x${string}` } };
    if (!raw.data?.signature) throw new Error("Privy personalSign returned no signature");
    return raw.data.signature;
  }

  /**
   * Signs AND broadcasts one transaction from a wallet. Per Privy's REST docs
   * (docs.privy.io/api-reference/wallets/ethereum/eth-send-transaction) the call is synchronous: success means the
   * transaction was broadcast, not that it was mined. Privy chooses the nonce and gas price. A fresh idempotency key
   * goes on every call, and the caller must NOT retry a failed send: an ambiguous failure could already be on-chain.
   *
   * `caip2` is the chain, e.g. "eip155:56" for BNB Chain.
   */
  async sendTransaction(
    walletId: string,
    caip2: string,
    tx: { to: string; value: bigint; data: `0x${string}`; gas?: bigint },
  ): Promise<`0x${string}`> {
    const transaction: Record<string, unknown> = { to: tx.to, value: `0x${tx.value.toString(16)}`, data: tx.data };
    if (tx.gas !== undefined) transaction.gas_limit = Number(tx.gas);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/wallets/${walletId}/rpc`, {
      method: "POST",
      headers: this.headers({ "privy-idempotency-key": globalThis.crypto.randomUUID() }),
      body: JSON.stringify({ method: "eth_sendTransaction", caip2, chain_type: "ethereum", params: { transaction } }),
    });
    if (!response.ok) {
      throw new Error(`Privy sendTransaction failed: ${response.status} ${await response.text()}`);
    }
    const raw = (await response.json()) as { data?: { hash?: `0x${string}` } };
    if (!raw.data?.hash) throw new Error("Privy sendTransaction returned no transaction hash");
    return raw.data.hash;
  }

  async signTypedData(walletId: string, typedData: TypedData): Promise<`0x${string}`> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/wallets/${walletId}/rpc`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        method: "eth_signTypedData_v4",
        params: {
          typed_data: {
            types: typedData.types,
            primary_type: typedData.primaryType,
            domain: typedData.domain,
            message: typedData.message,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Privy signTypedData failed: ${response.status} ${await response.text()}`);
    }

    const raw = (await response.json()) as { data: { signature: `0x${string}` } };
    return raw.data.signature;
  }
}
