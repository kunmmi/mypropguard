import { encodeFunctionData, erc20Abi, type Address, type Hash, type PublicClient } from "viem";
import type { FloatWalletSigner } from "@mypropguard/evm";

export interface SweepItem {
  /** "BNB" for the native coin, otherwise the token's address. */
  asset: string;
  amount: bigint;
  txHash: Hash | null;
  error: string | null;
}

/** Native-coin transfers cost exactly this much gas; the margin below covers the price moving before it lands. */
const NATIVE_TRANSFER_GAS = 21_000n;
const GAS_PRICE_MARGIN = 2n;

/**
 * Moves everything the trading wallet holds back to the owner's Safe: each token it ever traded, then the BNB that is
 * left. The destination is a parameter of THIS function only; no request from a linked site can reach it.
 *
 * Tokens go first because they need BNB for fees; the BNB goes last, minus its own fee.
 */
export async function sweepFloat(input: {
  walletId: string;
  walletAddress: Address;
  to: Address;
  tokens: Address[];
  publicClient: Pick<PublicClient, "readContract" | "getBalance" | "getGasPrice" | "waitForTransactionReceipt">;
  signer: Pick<FloatWalletSigner, "sendTransaction">;
}): Promise<SweepItem[]> {
  const { publicClient, signer } = input;
  const out: SweepItem[] = [];
  const reason = (e: unknown) => (e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e)).split("\n")[0]!;

  for (const token of input.tokens) {
    let amount = 0n;
    try {
      amount = (await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [input.walletAddress] })) as bigint;
      if (amount === 0n) continue;
      const hash = await signer.sendTransaction(input.walletId, {
        to: token,
        value: 0n,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [input.to, amount] }),
      });
      await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      out.push({ asset: token, amount, txHash: hash, error: null });
    } catch (error) {
      out.push({ asset: token, amount, txHash: null, error: reason(error) });
    }
  }

  try {
    const [balance, gasPrice] = await Promise.all([publicClient.getBalance({ address: input.walletAddress }), publicClient.getGasPrice()]);
    const value = balance - NATIVE_TRANSFER_GAS * gasPrice * GAS_PRICE_MARGIN;
    if (value > 0n) {
      const hash = await signer.sendTransaction(input.walletId, { to: input.to, value, data: "0x", gas: NATIVE_TRANSFER_GAS });
      out.push({ asset: "BNB", amount: value, txHash: hash, error: null });
    }
  } catch (error) {
    out.push({ asset: "BNB", amount: 0n, txHash: null, error: reason(error) });
  }
  return out;
}
