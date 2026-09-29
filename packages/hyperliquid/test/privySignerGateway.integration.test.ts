import { describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { DecisionOutcome, OrderSide, ReasonCode } from "@mypropguard/domain";
import { buildOrderReservation, buildProposedOrder } from "@mypropguard/test-fixtures";
import { InMemoryExecutionSequencer, authorizeAndSignOrder } from "@mypropguard/execution";
import { fetchAssetIndex } from "../src/assetIndex.js";
import { HYPERLIQUID_TESTNET_INFO_URL } from "../src/infoClient.js";
import { buildOrderAction } from "../src/orderAction.js";
import { buildAgentTypedData, createL1ActionHash } from "../src/signing.js";
import { HyperliquidActionHasher } from "../src/hyperliquidActionHasher.js";
import { PrivyClient } from "../src/privyClient.js";
import { PrivySignerGateway } from "../src/privySignerGateway.js";
import { loadRootEnvIfPresent } from "./loadEnv.js";

loadRootEnvIfPresent();

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const hasPrivyCreds = Boolean(PRIVY_APP_ID && PRIVY_APP_SECRET);

/**
 * Real integration test against the live Privy API. Creates a fresh
 * (unfunded) Privy wallet each run — cheap, safe, no side effects beyond
 * that wallet existing in your Privy dashboard. Cannot place a Hyperliquid
 * order or move funds: no venue submission happens anywhere here.
 */
describe.skipIf(!hasPrivyCreds)("PrivySignerGateway against the real Privy API", () => {
  it("signs when handed a correctly-computed real authorization, and the signature recovers to the wallet address", async () => {
    const privyClient = new PrivyClient({ appId: PRIVY_APP_ID!, appSecret: PRIVY_APP_SECRET! });
    const wallet = await privyClient.createEthereumWallet();

    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: wallet.id,
      walletAddress: wallet.address as `0x${string}`,
      isTestnet: true,
    });

    const proposedOrder = buildProposedOrder({ coin: "BTC", side: OrderSide.BUY });
    const nonce = Date.now();
    // gateway is isTestnet: true, which now (correctly) resolves asset
    // indices against testnet too - must match here or connectionIds diverge.
    const assetIndex = await fetchAssetIndex(proposedOrder.coin, { baseUrl: HYPERLIQUID_TESTNET_INFO_URL });
    const hyperliquidAction = buildOrderAction({
      assetIndex,
      isBuy: true,
      price: proposedOrder.price.toString(),
      size: proposedOrder.size.toString(),
      reduceOnly: false,
      tif: "Gtc",
    });
    const connectionId = createL1ActionHash({ action: hyperliquidAction, nonce });

    const signed = await gateway.signExact(
      {
        connectionId,
        reservationId: "resv_it",
        accountId: "acct_privy_it",
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      },
      {
        accountId: "acct_privy_it",
        clientIntentId: proposedOrder.clientIntentId,
        coin: proposedOrder.coin,
        side: proposedOrder.side,
        size: proposedOrder.size,
        price: proposedOrder.price,
        reduceOnly: false,
        nonce,
        expiresAt: new Date(Date.now() + 30_000),
      },
    );

    expect(signed.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());

    const typedData = buildAgentTypedData(connectionId, true);
    const valid = await verifyTypedData({
      address: wallet.address as `0x${string}`,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: signed.signature,
    });
    expect(valid).toBe(true);
  }, 30_000);

  it("refuses to sign when the authorized connectionId doesn't match the real action hash", async () => {
    const privyClient = new PrivyClient({ appId: PRIVY_APP_ID!, appSecret: PRIVY_APP_SECRET! });
    const wallet = await privyClient.createEthereumWallet();
    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: wallet.id,
      walletAddress: wallet.address as `0x${string}`,
      isTestnet: true,
    });

    await expect(
      gateway.signExact(
        {
          connectionId: "0xbad0000000000000000000000000000000000000000000000000000000bad",
          reservationId: "resv_x",
          accountId: "acct_x",
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
        },
        {
          accountId: "acct_x",
          clientIntentId: "intent_x",
          coin: "BTC",
          side: OrderSide.BUY,
          size: buildProposedOrder().size,
          price: buildProposedOrder().price,
          reduceOnly: false,
          nonce: 1,
          expiresAt: new Date(Date.now() + 30_000),
        },
      ),
    ).rejects.toThrow(/does not match/);
  }, 30_000);

  it("works through the generic authorizeAndSignOrder orchestrator when paired with HyperliquidActionHasher (the gap is closed)", async () => {
    const privyClient = new PrivyClient({ appId: PRIVY_APP_ID!, appSecret: PRIVY_APP_SECRET! });
    const wallet = await privyClient.createEthereumWallet();

    const gateway = new PrivySignerGateway({
      privyClient,
      walletId: wallet.id,
      walletAddress: wallet.address as `0x${string}`,
      isTestnet: true,
    });
    // Must match gateway's isTestnet: true (see comment above).
    const hasher = new HyperliquidActionHasher({ assetIndexOptions: { baseUrl: HYPERLIQUID_TESTNET_INFO_URL } });
    const sequencer = new InMemoryExecutionSequencer();
    const proposedOrder = buildProposedOrder({ coin: "BTC", side: OrderSide.BUY });

    const signed = await authorizeAndSignOrder(sequencer, hasher, gateway, {
      accountId: "acct_privy_orchestrated",
      proposedOrder,
      decision: {
        outcome: DecisionOutcome.ALLOW,
        approvedSize: null,
        reasonCode: ReasonCode.WITHIN_LIMITS,
        message: "ok",
        ruleType: null,
        evaluatedAt: new Date(),
      },
      reservation: buildOrderReservation(),
    });

    expect(signed.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());

    const typedData = buildAgentTypedData(signed.authorization.connectionId as `0x${string}`, true);
    const valid = await verifyTypedData({
      address: wallet.address as `0x${string}`,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: signed.signature,
    });
    expect(valid).toBe(true);
  }, 30_000);
});
