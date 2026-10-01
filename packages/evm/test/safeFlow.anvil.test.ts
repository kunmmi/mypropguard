import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { SafeDeployer } from "../src/safeDeployer.js";
import { GmxGuardClient } from "../src/gmxGuardClient.js";
import { safeReadAbi, SAFE_GUARD_STORAGE_SLOT } from "../src/abis.js";

/**
 * Drives the real deployment flow (packages/evm's actual TS clients, not a mock) against a real
 * local Anvil chain - proving the TS orchestration layer works end to end, the same way
 * packages/evm-guard's Foundry tests already proved the Solidity side works end to end on live
 * mainnet forks. This test needs Foundry's `anvil` on PATH (installed via `foundryup`) and the
 * compiled artifacts in packages/evm-guard/out/ (run `forge build` there first if missing).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVM_GUARD_OUT = join(__dirname, "..", "..", "evm-guard", "out");

// The standard, widely-published Anvil/Hardhat test mnemonic - deterministic accounts/keys,
// never used for anything but local throwaway chains. Deriving accounts directly from the
// mnemonic (rather than hand-copying private keys) avoids transcription errors.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

const RPC_URL = "http://127.0.0.1:8549";

function loadArtifact(relativePath: string): { abi: readonly unknown[]; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(EVM_GUARD_OUT, relativePath), "utf-8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

describe("real Safe deployment + GMX Guard rule sync against a local Anvil chain", () => {
  let anvil: ChildProcess;
  const deployerAccount = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 0 });
  const traderAccount = mnemonicToAccount(TEST_MNEMONIC, { addressIndex: 1 });

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ transport: http(RPC_URL) });

  let safeSingleton: Address;
  let safeProxyFactory: Address;
  let safeGuardSetup: Address;
  let guardAddress: Address;

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", "8549", "--mnemonic", TEST_MNEMONIC, "--silent"], { stdio: "ignore" });

    // Wait for anvil to accept connections - poll instead of a fixed sleep.
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const safe = loadArtifact("Safe.sol/Safe.json");
    const factory = loadArtifact("SafeProxyFactory.sol/SafeProxyFactory.json");
    const guardSetup = loadArtifact("SafeGuardSetup.sol/SafeGuardSetup.json");
    const gmxGuard = loadArtifact("GmxPositionLimitGuard.sol/GmxPositionLimitGuard.json");

    safeSingleton = await deployAndWait(safe);
    safeProxyFactory = await deployAndWait(factory);
    safeGuardSetup = await deployAndWait(guardSetup);
    // Admin = deployer, and the "ExchangeRouter" address is just a placeholder (reusing the
    // trader's own address, properly checksummed) - this test only exercises deployment/rule-sync
    // wiring, not real GMX calldata decoding (packages/evm-guard's own tests already prove that).
    guardAddress = await deployAndWait(gmxGuard, [deployerAccount.address, traderAccount.address]);

    async function deployAndWait(artifact: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
      const hash = await walletClient.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        args,
        account: deployerAccount,
        chain: undefined,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error("deployment produced no contract address");
      return receipt.contractAddress;
    }
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("deploys a real Safe for the trader with the Guard already attached, via the real SafeDeployer client", async () => {
    const deployer = new SafeDeployer(
      publicClient as any,
      walletClient as any,
      deployerAccount,
      undefined as any,
      { safeProxyFactory, safeSingleton, safeGuardSetup },
    );

    const { safeAddress } = await deployer.deploySafeWithGuard({
      owner: traderAccount.address,
      guard: guardAddress,
    });

    const owners = await publicClient.readContract({
      address: safeAddress,
      abi: safeReadAbi,
      functionName: "getOwners",
    });
    expect(owners).toEqual([traderAccount.address]);

    const threshold = await publicClient.readContract({
      address: safeAddress,
      abi: safeReadAbi,
      functionName: "getThreshold",
    });
    expect(threshold).toBe(1n);

    const storedGuard = await publicClient.getStorageAt({ address: safeAddress, slot: SAFE_GUARD_STORAGE_SLOT });
    expect(storedGuard?.toLowerCase()).toContain(guardAddress.slice(2).toLowerCase());
  });

  it("syncs a risk rule onto the real deployed Guard, via the real GmxGuardClient", async () => {
    const deployer = new SafeDeployer(
      publicClient as any,
      walletClient as any,
      deployerAccount,
      undefined as any,
      { safeProxyFactory, safeSingleton, safeGuardSetup },
    );
    const { safeAddress } = await deployer.deploySafeWithGuard({
      owner: traderAccount.address,
      guard: guardAddress,
      saltNonce: 1n, // distinct Safe from the previous test
    });

    const guardClient = new GmxGuardClient(publicClient as any, walletClient as any, deployerAccount, undefined as any, guardAddress);
    await guardClient.setLimits(safeAddress, 100n * 10n ** 30n, 5n);

    const limitsAbi = [
      {
        type: "function",
        name: "limits",
        stateMutability: "view",
        inputs: [{ name: "", type: "address" }],
        outputs: [
          { name: "maxPositionSizeUsd", type: "uint256" },
          { name: "maxTradesPerDay", type: "uint256" },
        ],
      },
    ] as const;

    const [maxPositionSizeUsd, maxTradesPerDay] = await publicClient.readContract({
      address: guardAddress,
      abi: limitsAbi,
      functionName: "limits",
      args: [safeAddress],
    });

    expect(maxPositionSizeUsd).toBe(100n * 10n ** 30n);
    expect(maxTradesPerDay).toBe(5n);
  });
});
