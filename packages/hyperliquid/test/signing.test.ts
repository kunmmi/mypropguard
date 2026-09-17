import { describe, expect, it } from "vitest";
import { buildAgentTypedData, createL1ActionHash } from "../src/signing.js";
import { buildOrderAction } from "../src/orderAction.js";

describe("createL1ActionHash", () => {
  const action = buildOrderAction({
    assetIndex: 0,
    isBuy: true,
    price: "50000",
    size: "1",
    reduceOnly: false,
    tif: "Gtc",
  });

  it("is deterministic for identical input", () => {
    const a = createL1ActionHash({ action, nonce: 1 });
    const b = createL1ActionHash({ action, nonce: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when the nonce changes", () => {
    const a = createL1ActionHash({ action, nonce: 1 });
    const b = createL1ActionHash({ action, nonce: 2 });
    expect(a).not.toBe(b);
  });

  it("changes when any order field changes", () => {
    const base = createL1ActionHash({ action, nonce: 1 });
    const biggerSize = createL1ActionHash({
      action: buildOrderAction({ assetIndex: 0, isBuy: true, price: "50000", size: "2", reduceOnly: false, tif: "Gtc" }),
      nonce: 1,
    });
    const sell = createL1ActionHash({
      action: buildOrderAction({ assetIndex: 0, isBuy: false, price: "50000", size: "1", reduceOnly: false, tif: "Gtc" }),
      nonce: 1,
    });
    expect(biggerSize).not.toBe(base);
    expect(sell).not.toBe(base);
  });

  it("changes when a vault address is included", () => {
    const withoutVault = createL1ActionHash({ action, nonce: 1 });
    const withVault = createL1ActionHash({
      action,
      nonce: 1,
      vaultAddress: "0x1234567890123456789012345678901234567890",
    });
    expect(withVault).not.toBe(withoutVault);
  });

  it("changes when expiresAfter is included", () => {
    const withoutExpiry = createL1ActionHash({ action, nonce: 1 });
    const withExpiry = createL1ActionHash({ action, nonce: 1, expiresAfter: 1_800_000_000_000 });
    expect(withExpiry).not.toBe(withoutExpiry);
  });
});

describe("buildAgentTypedData", () => {
  it("uses source 'a' for mainnet and 'b' for testnet", () => {
    const connectionId = "0x1111111111111111111111111111111111111111111111111111111111111a" as `0x${string}`;
    const mainnet = buildAgentTypedData(connectionId, false);
    const testnet = buildAgentTypedData(connectionId, true);

    expect(mainnet.message.source).toBe("a");
    expect(testnet.message.source).toBe("b");
    expect(mainnet.domain.chainId).toBe(1337);
    expect(mainnet.domain.verifyingContract).toBe("0x0000000000000000000000000000000000000000");
    expect(mainnet.message.connectionId).toBe(connectionId);
  });
});
