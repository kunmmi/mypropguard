import { describe, expect, it } from "vitest";
import { HyperliquidAgentWalletProvisioner } from "../src/agentWalletProvisioner.js";
import { PrivyClient } from "../src/privyClient.js";
import { loadRootEnvIfPresent } from "./loadEnv.js";

loadRootEnvIfPresent();

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const hasPrivyCreds = Boolean(PRIVY_APP_ID && PRIVY_APP_SECRET);

/**
 * Real integration test against the live Privy API - same low-risk shape as
 * privySignerGateway.integration.test.ts (creates a fresh, unfunded wallet;
 * no cost, no Hyperliquid involvement, nothing to approve).
 */
describe.skipIf(!hasPrivyCreds)("HyperliquidAgentWalletProvisioner against the real Privy API", () => {
  it("provisions a genuinely distinct wallet each time, not the shared server-wide one", async () => {
    const privyClient = new PrivyClient({ appId: PRIVY_APP_ID!, appSecret: PRIVY_APP_SECRET! });
    const provisioner = new HyperliquidAgentWalletProvisioner(privyClient);

    const first = await provisioner.provisionWallet();
    const second = await provisioner.provisionWallet();

    expect(first.walletId).toMatch(/.+/);
    expect(first.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Two calls must not return the same wallet, and neither should match
    // the single shared wallet this whole codebase otherwise signs with.
    expect(second.walletId).not.toBe(first.walletId);
    expect(second.walletAddress.toLowerCase()).not.toBe(first.walletAddress.toLowerCase());
    if (process.env.PRIVY_AGENT_WALLET_ADDRESS) {
      expect(first.walletAddress.toLowerCase()).not.toBe(process.env.PRIVY_AGENT_WALLET_ADDRESS.toLowerCase());
    }
  }, 30_000);
});
