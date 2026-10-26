import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseEther, type Address, type Hash, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { FOUR_MEME_BSC, TOKEN_MANAGER_V2_ABI } from "../src/fourMeme.js";
import { FloatExecutor, FloatTradeRefused, type FloatWalletRecord, type FloatWalletSigner } from "../src/floatExecutor.js";

/**
 * The trading wallet's whole path on a REAL local chain: judge, dry-run against real contract state, sign with a real key,
 * mine. The venue is a small contract that accepts BNB (standing in for four.meme's manager) and another that always
 * reverts (so the "would this fail?" dry run is exercised for real). Needs Foundry's `anvil` on the PATH.
 */

const MNEMONIC = "test test test test test test test test test test test junk";
const RPC = "http://127.0.0.1:8553";
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
const walletClient = createWalletClient({ chain: foundry, transport: http(RPC) });

describe("trading wallet on a real chain", () => {
  let anvil: ChildProcess;
  const funder = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const floatKey = mnemonicToAccount(MNEMONIC, { addressIndex: 5 });
  const meme = "0x2222222222222222222222222222222222222222" as Address;
  let sink: Address; // accepts BNB with any calldata: a stand-in for the four.meme manager
  let reverting: Address; // always reverts

  const wallet: FloatWalletRecord = {
    accountId: "acct_float",
    walletId: "local-key",
    address: floatKey.address,
    limits: { maxBuyWei: parseEther("0.3"), maxBuysPerDay: 4, dailySpendWei: parseEther("1"), cooldownSec: 0, frozen: false },
  };

  // Signs with the local key, like Privy would remotely. The signer fills in nonce and gas price.
  const signer: FloatWalletSigner = {
    async sendTransaction(_id, tx) {
      return walletClient.sendTransaction({ account: floatKey, to: tx.to, value: tx.value, data: tx.data, gas: tx.gas, chain: foundry });
    },
    async personalSign() {
      return "0x" as Hex;
    },
  };

  async function deployRaw(initCode: Hex): Promise<Address> {
    const hash = await walletClient.sendTransaction({ account: funder, data: initCode, chain: foundry });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  const makeExecutor = () => {
    const venues = new Map([
      [sink.toLowerCase(), { name: "test venue", abi: TOKEN_MANAGER_V2_ABI as never }],
      [reverting.toLowerCase(), { name: "reverting venue", abi: TOKEN_MANAGER_V2_ABI as never }],
    ]);
    return new FloatExecutor({ publicClient, signer, policy: { venues } });
  };

  /** A usage log standing in for the database: buys recorded as they are sent. */
  const usage = () => {
    const buys: bigint[] = [];
    return {
      buys,
      io: {
        loadUsage: async () => ({ buysToday: buys.length, spentTodayWei: buys.reduce((a, b) => a + b, 0n), lastBuyAtSec: null }),
        onSent: async (d: { kind: string; spendWei: bigint }) => void (d.kind === "buy" && buys.push(d.spendWei)),
      },
    };
  };
  const buy = (to: Address, bnb: string) => ({
    to,
    value: parseEther(bnb),
    data: encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "buyTokenAMAP", args: [meme, parseEther(bnb), 1n] }) as Hex,
  });

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", "8553", "--mnemonic", MNEMONIC, "--silent"], { stdio: "ignore" });
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    // runtime 0x00 (STOP): accepts value and any data. runtime 0x5f5ffd (PUSH0 PUSH0 REVERT): always reverts.
    sink = await deployRaw("0x600060005360016000f3");
    reverting = await deployRaw("0x625f5ffd6000526003601df3");
    const hash = await walletClient.sendTransaction({ account: funder, to: floatKey.address, value: parseEther("3"), chain: foundry });
    await publicClient.waitForTransactionReceipt({ hash });
  }, 30_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("an allowed buy is really mined: the venue receives the BNB, the wallet pays it plus gas", async () => {
    const before = await publicClient.getBalance({ address: floatKey.address });
    const sinkBefore = await publicClient.getBalance({ address: sink });
    const r = await makeExecutor().execute(wallet, buy(sink, "0.1"), usage().io);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: r.hash });
    expect(receipt.status).toBe("success");
    expect((await publicClient.getBalance({ address: sink })) - sinkBefore).toBe(parseEther("0.1"));
    const paid = before - (await publicClient.getBalance({ address: floatKey.address }));
    expect(paid).toBeGreaterThan(parseEther("0.1")); // the buy plus a (small) fee
    expect(paid).toBeLessThan(parseEther("0.101"));
    expect(r.timings.totalMs).toBeLessThan(2_000);
  });

  it("a buy over the limit never reaches the chain: no transaction is mined", async () => {
    const blockBefore = await publicClient.getBlockNumber();
    const balanceBefore = await publicClient.getBalance({ address: floatKey.address });
    const err = await makeExecutor().execute(wallet, buy(sink, "0.5"), usage().io).catch((e) => e);
    expect(err).toBeInstanceOf(FloatTradeRefused);
    expect(err.code).toBe("MAX_BUY");
    expect(await publicClient.getBlockNumber()).toBe(blockBefore);
    expect(await publicClient.getBalance({ address: floatKey.address })).toBe(balanceBefore);
  });

  it("a trade the venue would reject is caught by the dry run: nothing is mined and no fee is paid", async () => {
    const blockBefore = await publicClient.getBlockNumber();
    const balanceBefore = await publicClient.getBalance({ address: floatKey.address });
    const err = await makeExecutor().execute(wallet, buy(reverting, "0.1"), usage().io).catch((e) => e);
    expect(err).toBeInstanceOf(FloatTradeRefused);
    expect(err.code).toBe("WOULD_FAIL");
    expect(await publicClient.getBlockNumber()).toBe(blockBefore);
    expect(await publicClient.getBalance({ address: floatKey.address })).toBe(balanceBefore);
  });

  it("a run of buys uses consecutive nonces and stops at the daily count", async () => {
    const ex = makeExecutor();
    const u = usage();
    const startNonce = await publicClient.getTransactionCount({ address: floatKey.address });
    for (let i = 0; i < 4; i++) {
      // Anvil returns a hash slightly before the block exists, so wait for each receipt before the next read.
      const r = await ex.execute(wallet, buy(sink, "0.05"), u.io);
      await publicClient.waitForTransactionReceipt({ hash: r.hash });
    }
    expect(await publicClient.getTransactionCount({ address: floatKey.address })).toBe(startNonce + 4);
    const err = await ex.execute(wallet, buy(sink, "0.05"), u.io).catch((e) => e);
    expect(err.code).toBe("MAX_BUYS_PER_DAY");
    expect(await publicClient.getTransactionCount({ address: floatKey.address })).toBe(startNonce + 4);
  });

  it("buys fired at the same moment are serialised: only what the daily limit allows is mined", async () => {
    // Daily limit 1 BNB, per-buy limit 0.3: five simultaneous 0.3 buys can only fit three.
    const ex = makeExecutor();
    const u = usage();
    const w = { ...wallet, limits: { ...wallet.limits, maxBuysPerDay: 10 } };
    const startNonce = await publicClient.getTransactionCount({ address: floatKey.address });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => ex.execute(w, buy(sink, "0.3"), u.io)));
    const sent = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ hash: Hash }>[];
    expect(sent).toHaveLength(3);
    for (const s of sent) expect((await publicClient.waitForTransactionReceipt({ hash: s.value.hash })).status).toBe("success");
    expect(await publicClient.getTransactionCount({ address: floatKey.address })).toBe(startNonce + 3);
    expect(u.buys.reduce((a, b) => a + b, 0n)).toBe(parseEther("0.9"));
  });

  it("approvals to four.meme go through, to anyone else are refused, and a frozen wallet can still sell", async () => {
    const ex = makeExecutor();
    const approveData = (spender: Address) =>
      encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "s" }, { type: "uint256", name: "a" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [spender, 10n ** 30n] }) as Hex;
    const ok = await ex.execute(wallet, { to: sink, value: 0n, data: approveData(FOUR_MEME_BSC.tokenManagerV2) }, usage().io);
    expect((await publicClient.waitForTransactionReceipt({ hash: ok.hash })).status).toBe("success");
    const bad = await ex.execute(wallet, { to: sink, value: 0n, data: approveData("0x9999999999999999999999999999999999999999") }, usage().io).catch((e) => e);
    expect(bad.code).toBe("BAD_APPROVAL");

    const frozen = { ...wallet, limits: { ...wallet.limits, frozen: true } };
    const sellData = encodeFunctionData({ abi: TOKEN_MANAGER_V2_ABI, functionName: "sellToken", args: [meme, 1n] }) as Hex;
    const sold = await ex.execute(frozen, { to: sink, value: 0n, data: sellData }, usage().io);
    expect((await publicClient.waitForTransactionReceipt({ hash: sold.hash })).status).toBe("success");
    const frozenBuy = await ex.execute(frozen, buy(sink, "0.05"), usage().io).catch((e) => e);
    expect(frozenBuy.code).toBe("FROZEN");
  });

  it("a plain BNB send is refused and moves nothing", async () => {
    const recipient = "0x9999999999999999999999999999999999999999" as Address;
    const before = await publicClient.getBalance({ address: recipient });
    const err = await makeExecutor().execute(wallet, { to: recipient, value: parseEther("0.5"), data: "0x" }, usage().io).catch((e) => e);
    expect(err.code).toBe("PLAIN_SEND");
    expect(await publicClient.getBalance({ address: recipient })).toBe(before);
  });
});
