import type {
  CanonicalOrderAction,
  OrderCanceller,
  OrderLifecycleReader,
  OrderSubmitter,
  SignedAction,
  SubmittedOrder,
  VenueOrderStatus,
} from "@mypropguard/domain";
import { fetchAssetIndex, type FetchAssetIndexOptions } from "./assetIndex.js";
import { buildCancelAction } from "./cancelAction.js";
import {
  HYPERLIQUID_MAINNET_EXCHANGE_URL,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidExchangeClient,
  type HyperliquidExchangeClientOptions,
} from "./exchangeClient.js";
import { HYPERLIQUID_MAINNET_INFO_URL, HYPERLIQUID_TESTNET_INFO_URL } from "./infoClient.js";
import { fetchOrderStatus, type FetchOrderStatusOptions } from "./orderStatus.js";
import { buildAgentTypedData, createL1ActionHash } from "./signing.js";
import { submitSignedOrder } from "./submitOrder.js";
import type { PrivyClient } from "./privyClient.js";

export interface HyperliquidOrderLifecycleOptions {
  privyClient: PrivyClient;
  /** The Privy wallet id previously provisioned as the Hyperliquid agent wallet. */
  walletId: string;
  isTestnet: boolean;
  assetIndexOptions?: FetchAssetIndexOptions;
  exchangeClientOptions?: HyperliquidExchangeClientOptions;
  infoOptions?: FetchOrderStatusOptions;
}

interface OrderActionResponse {
  data?: { statuses?: Array<{ resting?: { oid: number }; filled?: { oid: number } }> };
}

function extractOid(response: unknown): number | null {
  const statuses = (response as OrderActionResponse | undefined)?.data?.statuses;
  const first = statuses?.[0];
  return first?.resting?.oid ?? first?.filled?.oid ?? null;
}

/**
 * Real Hyperliquid order-lifecycle operations beyond initial placement:
 * submitting a signed order and getting back its venue order id, cancelling
 * a resting order, and reading live order status. Kept separate from
 * PrivySignerGateway (which only signs) since these are direct venue
 * actions that aren't subject to risk-engine evaluation - cancelling a
 * trade can't itself violate a risk limit.
 *
 * `isTestnet` picks the matching Info/Exchange API by default, same as
 * PrivySignerGateway - mainnet and testnet don't share asset indices, and
 * getting this wrong silently targets the wrong coin (see
 * PrivySignerGateway's own doc comment for how that was discovered).
 */
export class HyperliquidOrderLifecycle implements OrderSubmitter, OrderCanceller, OrderLifecycleReader {
  private readonly assetIndexOptions: FetchAssetIndexOptions;
  private readonly exchangeClientOptions: HyperliquidExchangeClientOptions;
  private readonly infoOptions: FetchOrderStatusOptions;

  constructor(private readonly options: HyperliquidOrderLifecycleOptions) {
    const defaultInfoUrl = options.isTestnet ? HYPERLIQUID_TESTNET_INFO_URL : HYPERLIQUID_MAINNET_INFO_URL;
    const defaultExchangeUrl = options.isTestnet ? HYPERLIQUID_TESTNET_EXCHANGE_URL : HYPERLIQUID_MAINNET_EXCHANGE_URL;
    this.assetIndexOptions = { baseUrl: defaultInfoUrl, ...options.assetIndexOptions };
    this.exchangeClientOptions = { baseUrl: defaultExchangeUrl, ...options.exchangeClientOptions };
    this.infoOptions = { baseUrl: defaultInfoUrl, ...options.infoOptions };
  }

  async submit(signed: SignedAction, action: CanonicalOrderAction): Promise<SubmittedOrder> {
    const response = await submitSignedOrder({
      signed,
      canonicalAction: action,
      hasherOptions: { assetIndexOptions: this.assetIndexOptions },
      exchangeClientOptions: this.exchangeClientOptions,
    });

    const oid = extractOid(response);
    if (oid === null) {
      throw new Error(`Hyperliquid accepted the order but returned no order id: ${JSON.stringify(response)}`);
    }
    return { venueOrderId: String(oid) };
  }

  async cancelOrder(coin: string, venueOrderId: string): Promise<void> {
    const assetIndex = await fetchAssetIndex(coin, this.assetIndexOptions);
    const action = buildCancelAction({ assetIndex, oid: Number(venueOrderId) });
    const nonce = Date.now();
    const connectionId = createL1ActionHash({ action, nonce });
    const typedData = buildAgentTypedData(connectionId, this.options.isTestnet);
    const signature = await this.options.privyClient.signTypedData(this.options.walletId, typedData);

    const client = new HyperliquidExchangeClient(this.exchangeClientOptions);
    await client.submitAction({ action, nonce, signature });
  }

  async getOrderStatus(address: string, venueOrderId: string): Promise<VenueOrderStatus> {
    return fetchOrderStatus(address, Number(venueOrderId), this.infoOptions);
  }
}
