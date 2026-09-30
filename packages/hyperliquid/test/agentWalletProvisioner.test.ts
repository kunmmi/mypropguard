import { describe, expect, it } from "vitest";
import { HyperliquidAgentWalletProvisioner } from "../src/agentWalletProvisioner.js";
import { PrivyClient } from "../src/privyClient.js";

describe("HyperliquidAgentWalletProvisioner (injected fetch, no real network or credentials)", () => {
  it("creates a real-shaped Ethereum wallet via Privy and returns walletId/walletAddress", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: "wallet_abc", address: "0x000000000000000000000000000000000000ab", chain_type: "ethereum" }), {
        status: 200,
      })) as typeof fetch;

    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl });
    const provisioner = new HyperliquidAgentWalletProvisioner(privyClient);

    const result = await provisioner.provisionWallet();
    expect(result).toEqual({ walletId: "wallet_abc", walletAddress: "0x000000000000000000000000000000000000ab" });
  });

  it("propagates a Privy failure instead of silently returning an empty wallet", async () => {
    const fetchImpl = (async () => new Response("server error", { status: 500 })) as typeof fetch;
    const privyClient = new PrivyClient({ appId: "id", appSecret: "secret", fetchImpl });
    const provisioner = new HyperliquidAgentWalletProvisioner(privyClient);

    await expect(provisioner.provisionWallet()).rejects.toThrow();
  });
});
