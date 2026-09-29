import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { OrderSide } from "@mypropguard/domain";
import { buildProposedOrder } from "@mypropguard/test-fixtures";
import { HyperliquidActionHasher } from "../src/hyperliquidActionHasher.js";
import { HYPERLIQUID_TESTNET_INFO_URL } from "../src/infoClient.js";
import { HyperliquidOrderLifecycle } from "../src/orderLifecycle.js";
import { PrivyClient } from "../src/privyClient.js";
import { PrivySignerGateway } from "../src/privySignerGateway.js";
import { loadRootEnvIfPresent } from "./loadEnv.js";

loadRootEnvIfPresent();

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const AGENT_WALLET_ID = process.env.PRIVY_AGENT_WALLET_ID;
const AGENT_WALLET_ADDRESS = process.env.PRIVY_AGENT_WALLET_ADDRESS as `0x${string}` | undefined;
const MASTER_ADDRESS = process.env.HYPERLIQUID_TESTNET_MASTER_ADDRESS;

const canRun = Boolean(
  PRIVY_APP_ID && PRIVY_APP_SECRET && AGENT_WALLET_ID && AGENT_WALLET_ADDRESS && MASTER_ADDRESS && process.env.SUBMIT_TESTNET_ORDER,
);

/**
 * Full real order-lifecycle round trip on Hyperliquid testnet: place a
 * resting order, read its live status (OPEN), cancel it, read status again.
 * Same opt-in gating as submitOrder.integration.test.ts, plus
 * HYPERLIQUID_TESTNET_MASTER_ADDRESS (the funded/approved account, needed
 * for the status read - Hyperliquid's orderStatus is keyed by account
 * address, not agent address).
 */
describe.skipIf(!canRun)("HyperliquidOrderLifecycle against real Hyperliquid testnet", () => {
  it("places, reads OPEN, cancels, then confirms it's no longer open", async () => {
    const privyClient = new PrivyClient({ appId: PRIVY_APP_ID!, appSecret: PRIVY_APP_SECRET! });
    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: AGENT_WALLET_ID!,
      walletAddress: AGENT_WALLET_ADDRESS!,
      isTestnet: true,
    });
    const hasher = new HyperliquidActionHasher({ assetIndexOptions: { baseUrl: HYPERLIQUID_TESTNET_INFO_URL } });
    const lifecycle = new HyperliquidOrderLifecycle({ privyClient, walletId: AGENT_WALLET_ID!, isTestnet: true });

    // Same "half of real mid price" trick as submitOrder.integration.test.ts.
    const midResponse = await fetch(HYPERLIQUID_TESTNET_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    const mids = (await midResponse.json()) as Record<string, string>;
    const restingPrice = new Decimal(mids.BTC!).times(0.5).toDecimalPlaces(0);

    const proposedOrder = buildProposedOrder({ coin: "BTC", side: OrderSide.BUY, size: new Decimal("0.001"), price: restingPrice });
    const nonce = Date.now();
    const canonicalAction = {
      accountId: "acct_lifecycle_it",
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
      { connectionId, reservationId: "resv_lifecycle_it", accountId: "acct_lifecycle_it", issuedAt: new Date(), expiresAt: canonicalAction.expiresAt },
      canonicalAction,
    );

    const submitted = await lifecycle.submit(signed, canonicalAction);
    expect(submitted.venueOrderId).toMatch(/^\d+$/);

    const openStatus = await lifecycle.getOrderStatus(MASTER_ADDRESS!, submitted.venueOrderId);
    expect(openStatus.status).toBe("OPEN");

    await lifecycle.cancelOrder("BTC", submitted.venueOrderId);

    const afterCancelStatus = await lifecycle.getOrderStatus(MASTER_ADDRESS!, submitted.venueOrderId);
    expect(afterCancelStatus.status).not.toBe("OPEN");
  }, 30_000);
});
