import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { OrderSide } from "@mypropguard/domain";
import { buildProposedOrder } from "@mypropguard/test-fixtures";
import { HyperliquidActionHasher } from "../src/hyperliquidActionHasher.js";
import { PrivyClient } from "../src/privyClient.js";
import { PrivySignerGateway } from "../src/privySignerGateway.js";
import { HYPERLIQUID_TESTNET_EXCHANGE_URL } from "../src/exchangeClient.js";
import { submitSignedOrder } from "../src/submitOrder.js";
import { loadRootEnvIfPresent } from "./loadEnv.js";

loadRootEnvIfPresent();

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const AGENT_WALLET_ID = process.env.PRIVY_AGENT_WALLET_ID;
const AGENT_WALLET_ADDRESS = process.env.PRIVY_AGENT_WALLET_ADDRESS as `0x${string}` | undefined;

/**
 * Places a REAL order on Hyperliquid's TESTNET (free faucet funds, zero
 * real money). Opt-in only: requires not just Privy credentials but proof
 * you've done the one-time manual setup this codebase cannot do for you —
 * approving this agent wallet on a funded testnet account via Hyperliquid's
 * own UI (app.hyperliquid-testnet.xyz). Set SUBMIT_TESTNET_ORDER=1 once
 * that's done. Places a deep out-of-the-money limit order so it rests
 * without filling — cancel it from the testnet UI afterward if you want a
 * clean order book, no urgency since it's fake money.
 */
const canRun = Boolean(PRIVY_APP_ID && PRIVY_APP_SECRET && AGENT_WALLET_ID && AGENT_WALLET_ADDRESS && process.env.SUBMIT_TESTNET_ORDER);

describe.skipIf(!canRun)("submitSignedOrder against real Hyperliquid testnet", () => {
  it("places a resting limit order and gets back a real venue response", async () => {
    const privyClient = new PrivyClient({ appId: PRIVY_APP_ID!, appSecret: PRIVY_APP_SECRET! });
    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: AGENT_WALLET_ID!,
      walletAddress: AGENT_WALLET_ADDRESS!,
      isTestnet: true,
    });
    const hasher = new HyperliquidActionHasher();

    // Tiny size and a price deep below market: rests instead of filling,
    // and keeps required margin trivial for a freshly faucet-funded account.
    const proposedOrder = buildProposedOrder({
      coin: "BTC",
      side: OrderSide.BUY,
      size: new Decimal("0.001"),
      price: new Decimal("100"),
    });
    const nonce = Date.now();
    const canonicalAction = {
      accountId: "acct_testnet_it",
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
      {
        connectionId,
        reservationId: "resv_testnet_it",
        accountId: "acct_testnet_it",
        issuedAt: new Date(),
        expiresAt: canonicalAction.expiresAt,
      },
      canonicalAction,
    );

    const response = await submitSignedOrder({
      signed,
      canonicalAction,
      exchangeClientOptions: { baseUrl: HYPERLIQUID_TESTNET_EXCHANGE_URL },
    });

    expect(response).toBeTruthy();
  }, 30_000);
});
