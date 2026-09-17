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

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader,
      "privy-app-id": this.options.appId,
      "Content-Type": "application/json",
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
