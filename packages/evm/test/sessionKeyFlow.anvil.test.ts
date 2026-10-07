import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { SafeDeployer } from "../src/safeDeployer.js";
import { safeExecAbi } from "../src/abis.js";
import {
  SafeSessionExecutor,
  SessionTradeRefused,
  buildDisableSessionKeyTx,
  buildEnableSessionKeyTx,
  isSessionKeyActive,
  type SafeTxTypedDataSigner,
} from "../src/safeSessionExecutor.js";

/**
 * The one-click flow, end to end, on a real local chain with the real contracts: a real Safe, the real
 * SpotRiskGuard, a session key that signs, and the trader's own wallet for the setup. Needs Foundry's `anvil`
 * and compiled contracts in packages/evm-guard/out (run `forge build` there first).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "evm-guard", "out");
const MNEMONIC = "test test test test test test test test test test test junk";
const RPC = "http://127.0.0.1:8551";

function artifact(path: string): { abi: readonly unknown[]; bytecode: Hex } {
  const json = JSON.parse(readFileSync(join(OUT, path), "utf-8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

describe("one-click trading: a session key trades on a real Safe, and can do nothing else", () => {
  let anvil: ChildProcess;
  const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const trader = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
  const sessionKey = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
  const gasWallet = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
  const counterparty = "0x00000000000000000000000000000000000dead1" as Address;

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  const walletClient = createWalletClient({ chain: foundry, transport: http(RPC) });

  let safeAddress: Address;
  let guardAddress: Address;
  let multiSend: Address;
  let executor: SafeSessionExecutor;

  // Signs the way Privy does (EIP-712 typed data by wallet id), but with a local key.
  const signer: SafeTxTypedDataSigner = {
    async signTypedData(walletId, typedData) {
      expect(walletId).toBe("session-wallet");
      const { EIP712Domain: _domain, ...types } = typedData.types;
      return sessionKey.signTypedData({
        domain: typedData.domain as any,
        types: types as any,
        primaryType: typedData.primaryType,
        message: {
          ...typedData.message,
          value: BigInt(typedData.message.value as string),
          safeTxGas: BigInt(typedData.message.safeTxGas as string),
          baseGas: BigInt(typedData.message.baseGas as string),
          gasPrice: BigInt(typedData.message.gasPrice as string),
          nonce: BigInt(typedData.message.nonce as string),
        } as any,
      });
    },
  };

  async function deploy(a: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
    const hash = await walletClient.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: deployer });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.contractAddress!;
  }

  async function ownerSends(tx: { to: Address; data: Hex }) {
    const hash = await walletClient.sendTransaction({ account: trader, to: tx.to, data: tx.data, value: 0n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  }

  async function buys(): Promise<bigint> {
    const state = (await publicClient.readContract({
      address: guardAddress,
      abi: [{ type: "function", name: "tradeState", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] }],
      functionName: "tradeState",
      args: [safeAddress],
    })) as readonly [bigint, bigint];
    return state[1];
  }

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", "8551", "--mnemonic", MNEMONIC, "--silent"], { stdio: "ignore" });
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const singleton = await deploy(artifact("Safe.sol/Safe.json"));
    const factory = await deploy(artifact("SafeProxyFactory.sol/SafeProxyFactory.json"));
    const guardSetup = await deploy(artifact("SafeGuardSetup.sol/SafeGuardSetup.json"));
    multiSend = await deploy(artifact("MultiSendCallOnly.sol/MultiSendCallOnly.json"));
    guardAddress = await deploy(artifact("SpotRiskGuard.sol/SpotRiskGuard.json"), [
      deployer.address, // admin
      "0x00000000000000000000000000000000000000a1", // wrapped native (unused here)
      multiSend,
      "0x0000000000000000000000000000000000000000", // no Permit2
      [],
      [],
    ]);

    const safeDeployer = new SafeDeployer(publicClient as any, walletClient as any, deployer, foundry, {
      safeProxyFactory: factory,
      safeSingleton: singleton,
      safeGuardSetup: guardSetup,
    });
    safeAddress = (await safeDeployer.deploySafeWithGuard({ owner: trader.address, guard: guardAddress })).safeAddress;

    // Rules: two buys a day, at most 1 coin of the native token each.
    const adminAbi = [
      { type: "function", name: "setMaxTradesPerDay", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [] },
      { type: "function", name: "setTokenLimit", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] },
    ] as const;
    for (const [fn, args] of [
      ["setMaxTradesPerDay", [safeAddress, 2n]],
      ["setTokenLimit", [safeAddress, "0x0000000000000000000000000000000000000000", parseEther("1")]],
    ] as const) {
      const hash = await walletClient.writeContract({ address: guardAddress, abi: adminAbi, functionName: fn as any, args: args as any, account: deployer });
      await publicClient.waitForTransactionReceipt({ hash });
    }

    await walletClient.sendTransaction({ account: deployer, to: safeAddress, value: parseEther("5") });
    await walletClient.sendTransaction({ account: deployer, to: gasWallet.address, value: parseEther("5") });
    await walletClient.sendTransaction({ account: deployer, to: trader.address, value: parseEther("5") });

    executor = new SafeSessionExecutor(publicClient as any, walletClient as any, gasWallet, foundry, signer, { receiptTimeoutMs: 15_000 });
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("does not trade before the trader has enabled one-click trading", async () => {
    expect(await isSessionKeyActive(publicClient as any, safeAddress, guardAddress, sessionKey.address)).toBe(false);
  });

  it("enables with ONE transaction from the trader's own wallet", async () => {
    const tx = await buildEnableSessionKeyTx({ publicClient: publicClient as any, safeAddress, ownerAddress: trader.address, multiSendCallOnly: multiSend, guardAddress, sessionKeyAddress: sessionKey.address });
    await ownerSends(tx);
    expect(await isSessionKeyActive(publicClient as any, safeAddress, guardAddress, sessionKey.address)).toBe(true);
    const threshold = await publicClient.readContract({ address: safeAddress, abi: safeExecAbi, functionName: "getThreshold" });
    expect(threshold).toBe(1n);
  });

  const trade = (value: bigint, data: Hex = "0x12345678") => ({
    safeAddress,
    sessionWalletId: "session-wallet",
    sessionWalletAddress: sessionKey.address,
    to: counterparty,
    value,
    data,
  });

  it("makes a buy inside the limits with no popup, paid for by the gas wallet", async () => {
    const before = await publicClient.getBalance({ address: safeAddress });
    const gasBefore = await publicClient.getBalance({ address: gasWallet.address });
    const hash = await executor.execute(trade(parseEther("0.5")));
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(before - (await publicClient.getBalance({ address: safeAddress }))).toBe(parseEther("0.5"));
    expect(gasBefore).toBeGreaterThan(await publicClient.getBalance({ address: gasWallet.address }));
    expect(await buys()).toBe(1n);
  });

  it("refuses a buy over the per-trade limit with a plain explanation, and sends nothing", async () => {
    const before = await publicClient.getTransactionCount({ address: gasWallet.address });
    const error = await executor.execute(trade(parseEther("2"))).catch((e) => e);
    expect(error).toBeInstanceOf(SessionTradeRefused);
    expect(error.code).toBe("GUARD_REFUSED");
    expect(error.message).toContain("per-trade limit");
    expect(await publicClient.getTransactionCount({ address: gasWallet.address })).toBe(before);
  });

  it("refuses to send money out: a session key can only trade", async () => {
    const error = await executor.execute(trade(parseEther("0.1"), "0x")).catch((e) => e);
    expect(error).toBeInstanceOf(SessionTradeRefused);
    expect(error.message).toContain("can only buy and sell");
  });

  it("runs several trades in a row without nonce clashes, then stops at the daily buy count", async () => {
    await executor.execute(trade(parseEther("0.1")));
    const error = await executor.execute(trade(parseEther("0.1"))).catch((e) => e);
    expect(error).toBeInstanceOf(SessionTradeRefused);
    expect(error.message).toContain("buy number 3");
    expect(await buys()).toBe(2n);
  });

  it("rejects a signature that is not from the session key", async () => {
    const wrong = new SafeSessionExecutor(publicClient as any, walletClient as any, gasWallet, foundry, {
      signTypedData: (walletId, typedData) => signer.signTypedData(walletId, typedData).then(() => deployerSign(typedData)),
    });
    async function deployerSign(typedData: any): Promise<Hex> {
      const { EIP712Domain: _d, ...types } = typedData.types;
      return deployer.signTypedData({
        domain: typedData.domain,
        types,
        primaryType: typedData.primaryType,
        message: { ...typedData.message, value: BigInt(typedData.message.value), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(typedData.message.nonce) },
      });
    }
    const error = await wrong.execute(trade(parseEther("0.1"))).catch((e) => e);
    expect(error).toBeInstanceOf(SessionTradeRefused);
    expect(error.code).toBe("SIGNATURE_MISMATCH");
  });

  it("disables with one transaction from the trader's wallet, after which the key is not an owner", async () => {
    const tx = await buildDisableSessionKeyTx({ publicClient: publicClient as any, safeAddress, ownerAddress: trader.address, multiSendCallOnly: multiSend, guardAddress, sessionKeyAddress: sessionKey.address });
    await ownerSends(tx);
    expect(await isSessionKeyActive(publicClient as any, safeAddress, guardAddress, sessionKey.address)).toBe(false);
    const owners = await publicClient.readContract({ address: safeAddress, abi: safeExecAbi, functionName: "getOwners" });
    expect(owners).toEqual([trader.address]);
  });
});
