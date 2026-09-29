export const HYPERLIQUID_MAINNET_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";
export const HYPERLIQUID_TESTNET_EXCHANGE_URL = "https://api.hyperliquid-testnet.xyz/exchange";

export interface EcdsaSignature {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
}

/**
 * Splits a 65-byte ECDSA signature (0x + r + s + v, the format Privy's
 * eth_signTypedData_v4 returns) into the {r, s, v} object Hyperliquid's
 * /exchange endpoint requires. v is expected in the standard 27/28 form,
 * which is what Privy already returns — no adjustment needed.
 */
export function splitSignature(signature: `0x${string}`): EcdsaSignature {
  const hex = signature.slice(2);
  if (hex.length !== 130) {
    throw new Error(`Expected a 65-byte (130 hex char) signature, got ${hex.length / 2} bytes.`);
  }
  return {
    r: `0x${hex.slice(0, 64)}`,
    s: `0x${hex.slice(64, 128)}`,
    v: Number.parseInt(hex.slice(128, 130), 16),
  };
}

export interface SubmitActionInput {
  /** The exact action object the signature was computed over (see HyperliquidActionHasher.buildAction). */
  action: Record<string, unknown> | unknown[];
  nonce: number;
  signature: `0x${string}`;
  vaultAddress?: `0x${string}`;
}

interface OrderStatus {
  error?: string;
  resting?: unknown;
  filled?: unknown;
}

interface RawExchangeResponse {
  status: "ok" | "err";
  response: {
    type?: string;
    data?: { statuses?: OrderStatus[] };
  };
}

export interface HyperliquidExchangeClientOptions {
  /** Defaults to mainnet. Pass HYPERLIQUID_TESTNET_EXCHANGE_URL for testnet. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * REAL Hyperliquid order submission. This is the one piece the rest of the
 * codebase has deliberately never called — everything up to this point
 * (risk check, reservation, real signing) produces a signature that's never
 * been sent anywhere. This client sends it.
 *
 * Point `baseUrl` at HYPERLIQUID_TESTNET_EXCHANGE_URL and use a testnet
 * agent wallet (funded with free faucet USDC, approved via Hyperliquid's
 * testnet UI) before ever pointing this at mainnet with real funds.
 */
export class HyperliquidExchangeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HyperliquidExchangeClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? HYPERLIQUID_MAINNET_EXCHANGE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async submitAction(input: SubmitActionInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      action: input.action,
      nonce: input.nonce,
      signature: splitSignature(input.signature),
      vaultAddress: input.vaultAddress ?? null,
    };

    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Hyperliquid exchange request failed: ${response.status} ${await response.text()}`);
    }

    const raw = (await response.json()) as RawExchangeResponse;
    if (raw.status === "err") {
      throw new Error(`Hyperliquid rejected the action: ${JSON.stringify(raw.response)}`);
    }

    // A top-level "ok" only means the request was well-formed — Hyperliquid
    // nests actual per-order rejections (invalid size, bad price, etc.)
    // inside response.data.statuses. Without this check, a rejected order
    // looks identical to a resting/filled one to any caller checking
    // truthiness, which is exactly the bug that shipped here initially.
    const statuses = raw.response.data?.statuses;
    if (statuses) {
      const errors = statuses.filter((status): status is Required<Pick<OrderStatus, "error">> => Boolean(status.error));
      if (errors.length > 0) {
        throw new Error(`Hyperliquid rejected the order: ${errors.map((e) => e.error).join("; ")}`);
      }
    }

    return raw.response;
  }
}
