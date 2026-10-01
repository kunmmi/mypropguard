import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import { EvmChainGuardRuleSyncer } from "../src/evmGuardRuleSyncer.js";
import { SpotGuardClient } from "../src/spotGuardClient.js";

const SAFE_ADDRESS = "0x1111111111111111111111111111111111111111";
const USDT_ADDRESS = "0x2222222222222222222222222222222222222222";
const NATIVE_SENTINEL = "0x0000000000000000000000000000000000000000";

function buildSyncer(decimals: number) {
  const readContract = vi.fn().mockResolvedValue(decimals);
  const writeContract = vi.fn().mockResolvedValue("0xTXHASH");
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });

  const publicClient = { readContract, waitForTransactionReceipt } as any;
  const walletClient = { writeContract } as any;
  const guardClient = new SpotGuardClient(publicClient, walletClient, {} as any, {} as any, "0xGUARD" as any);
  const syncer = new EvmChainGuardRuleSyncer(publicClient, guardClient);

  return { syncer, readContract, writeContract };
}

describe("EvmChainGuardRuleSyncer", () => {
  it("converts a MAX_POSITION_SIZE param to raw token units using the token's live decimals()", async () => {
    const { syncer, readContract, writeContract } = buildSyncer(6); // USDT has 6 decimals

    await syncer.syncRule({
      safeAddress: SAFE_ADDRESS,
      ruleType: RuleType.MAX_POSITION_SIZE,
      param: new Decimal(500),
      tokenAddress: USDT_ADDRESS,
    });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: USDT_ADDRESS, functionName: "decimals" }));
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "setTokenLimit",
        args: [SAFE_ADDRESS, USDT_ADDRESS, 500_000_000n],
      }),
    );
  });

  it("uses 18 decimals for the native-token sentinel without reading on-chain decimals", async () => {
    const { syncer, readContract, writeContract } = buildSyncer(18);

    await syncer.syncRule({
      safeAddress: SAFE_ADDRESS,
      ruleType: RuleType.MAX_POSITION_SIZE,
      param: new Decimal(2),
      tokenAddress: NATIVE_SENTINEL,
    });

    expect(readContract).not.toHaveBeenCalled();
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "setTokenLimit",
        args: [SAFE_ADDRESS, NATIVE_SENTINEL, 2_000_000_000_000_000_000n],
      }),
    );
  });

  it("rejects MAX_POSITION_SIZE with no tokenAddress", async () => {
    const { syncer } = buildSyncer(18);

    await expect(
      syncer.syncRule({ safeAddress: SAFE_ADDRESS, ruleType: RuleType.MAX_POSITION_SIZE, param: new Decimal(500) }),
    ).rejects.toThrow(/tokenAddress/);
  });

  it("pushes MAX_TRADE_FREQUENCY as setMaxTradesPerDay, no token involved", async () => {
    const { syncer, writeContract } = buildSyncer(18);

    await syncer.syncRule({ safeAddress: SAFE_ADDRESS, ruleType: RuleType.MAX_TRADE_FREQUENCY, param: new Decimal(10) });

    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "setMaxTradesPerDay", args: [SAFE_ADDRESS, 10n] }),
    );
  });

  it("rejects rule types the spot Guards don't understand", async () => {
    const { syncer } = buildSyncer(18);

    await expect(
      syncer.syncRule({ safeAddress: SAFE_ADDRESS, ruleType: RuleType.MAX_DAILY_LOSS, param: new Decimal(500) }),
    ).rejects.toThrow(/does not support/);
  });
});
