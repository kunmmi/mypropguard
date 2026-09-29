import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { OrderSide } from "@mypropguard/domain";
import { buildProposedOrder } from "@mypropguard/test-fixtures";
import { HyperliquidActionHasher } from "../src/hyperliquidActionHasher.js";
import { HYPERLIQUID_MAINNET_INFO_URL } from "../src/infoClient.js";
import { PrivyClient } from "../src/privyClient.js";
import { PrivySignerGateway } from "../src/privySignerGateway.js";
import { HYPERLIQUID_MAINNET_EXCHANGE_URL } from "../src/exchangeClient.js";
import { submitSignedOrder } from "../src/submitOrder.js";
import { loadRootEnvIfPresent } from "./loadEnv.js";

loadRootEnvIfPresent();

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const AGENT_WALLET_ID = process.env.PRIVY_AGENT_WALLET_ID;
const AGENT_WALLET_ADDRESS = process.env.PRIVY_AGENT_WALLET_ADDRESS as `0x${string}` | undefined;

/**
 * REAL MAINNET ORDER. REAL MONEY. This places a genuine resting limit order
 * on Hyperliquid mainnet using whatever funds sit in the approved account's
 * Perps balance. Deep out-of-the-money (half of real market price) so it
 * rests instead of filling - the ~$10 minimum notional is Hyperliquid's own
 * rule (confirmed on testnet: smaller orders are rejected outright), not a
 * choice made here, but a resting order that won't fill doesn't actually
 * spend that notional, only provisionally reserves margin against it.
 *
 * Deliberately opt-in only, deliberately not run by anyone but you: set
 * SUBMIT_MAINNET_ORDER=1 yourself when you're ready. Cancel it afterward
 * from app.hyperliquid.xyz if you want a clean book - no urgency, it's
 * resting far from market.
 */
const canRun = Boolean(PRIVY_APP_ID && PRIVY_APP_SECRET && AGENT_WALLET_ID && AGENT_WALLET_ADDRESS && process.env.SUBMIT_MAINNET_ORDER);

describe.skipIf(!canRun)("submitSignedOrder against real Hyperliquid MAINNET", () => {
  it("places a real resting limit order using real funds", async () => {
    const privyClient = new PrivyClient({ appId: PRIVY_APP_ID!, appSecret: PRIVY_APP_SECRET! });
    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: AGENT_WALLET_ID!,
      walletAddress: AGENT_WALLET_ADDRESS!,
      isTestnet: false,
    });
    const hasher = new HyperliquidActionHasher({ assetIndexOptions: { baseUrl: HYPERLIQUID_MAINNET_INFO_URL } });

    const midResponse = await fetch(HYPERLIQUID_MAINNET_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    const mids = (await midResponse.json()) as Record<string, string>;
    const restingPrice = new Decimal(mids.BTC!).times(0.5).toDecimalPlaces(0);

    // Smallest size that reliably clears Hyperliquid's ~$10 minimum notional
    // at half of real BTC price.
    const size = new Decimal(20).div(restingPrice).toDecimalPlaces(5, Decimal.ROUND_UP);

    const proposedOrder = buildProposedOrder({ coin: "BTC", side: OrderSide.BUY, size, price: restingPrice });
    const nonce = Date.now();
    const canonicalAction = {
      accountId: "acct_mainnet_it",
      clientIntentId: proposedOrder.clientIntentId,
      coin: proposedOrder.coin,
      side: proposedOrder.side,
      size: proposedOrder.size,
      price: proposedOrder.price,
      reduceOnly: false,
      nonce,
      expiresAt: new Date(Date.now() + 30_000),
    };

    const connectionId = await hasher.computeConnectionId(canonicalAction);
    const signed = await gateway.signExact(
      { connectionId, reservationId: "resv_mainnet_it", accountId: "acct_mainnet_it", issuedAt: new Date(), expiresAt: canonicalAction.expiresAt },
      canonicalAction,
    );

    const response = await submitSignedOrder({
      signed,
      canonicalAction,
      exchangeClientOptions: { baseUrl: HYPERLIQUID_MAINNET_EXCHANGE_URL },
    });

    // eslint-disable-next-line no-console
    console.log("MAINNET ORDER RESPONSE:", JSON.stringify(response, null, 2));
    expect(response).toBeTruthy();
  }, 30_000);
});
