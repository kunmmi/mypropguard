import {
  concat,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  recoverTypedDataAddress,
  getAddress,
  isAddressEqual,
  toHex,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { multiSendAbi, safeExecAbi, spotGuardErrorsAbi, spotGuardSessionAbi } from "./abis.js";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const SENTINEL_OWNERS = "0x0000000000000000000000000000000000000001" as const;

/** Signs Safe transaction typed data with a session key held elsewhere (Privy), by wallet id. */
export interface SafeTxTypedDataSigner {
  signTypedData(
    walletId: string,
    typedData: {
      domain: Record<string, unknown>;
      types: Record<string, Array<{ name: string; type: string }>>;
      primaryType: string;
      message: Record<string, unknown>;
    },
  ): Promise<Hex>;
}

export const SAFE_TX_TYPES = {
  EIP712Domain: [
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface SessionTrade {
  safeAddress: Address;
  /** The Privy wallet that holds the session key, and its address (checked against the signature). */
  sessionWalletId: string;
  sessionWalletAddress: Address;
  to: Address;
  value: bigint;
  data: Hex;
}

/** A refusal the trader can understand, as opposed to a crash. `code` is stable for the UI and logs. */
export class SessionTradeRefused extends Error {
  constructor(
    readonly code: "GUARD_REFUSED" | "TRADE_WOULD_FAIL" | "SIGNATURE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SessionTradeRefused";
  }
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Turns SpotRiskGuard's revert data into a sentence. Returns undefined for data that is not one of its errors. */
export function describeGuardRevert(data: Hex): string | undefined {
  let decoded;
  try {
    decoded = decodeErrorResult({ abi: spotGuardErrorsAbi, data });
  } catch {
    return undefined;
  }
  const args = (decoded.args ?? []) as readonly unknown[];
  switch (decoded.errorName) {
    case "AccountIsFrozen":
      return "Blocked by MyPropGuard: this account is frozen for today after hitting its daily loss limit. Selling is still allowed.";
    case "TradeAmountExceeded":
      return `Blocked by MyPropGuard: this buy is larger than the per-trade limit (asked ${args[1]}, limit ${args[2]}, in the smallest unit of ${args[0] === ZERO ? "BNB" : shortAddress(String(args[0]))}).`;
    case "TradeCountExceeded":
      return `Blocked by MyPropGuard: this would be buy number ${args[0]} today, and the limit is ${args[1]}.`;
    case "LimitsNotConfigured":
      return "Blocked by MyPropGuard: no daily buy limit is set for this account yet. Add a trade-frequency rule first.";
    case "SpenderNotAllowed":
      return `Blocked by MyPropGuard: approving ${shortAddress(String(args[1]))} to spend this token is not allowed. Only allowlisted routers can be approved.`;
    case "SessionKeyBlocked":
      return "Blocked by MyPropGuard: one-click trading can only buy and sell. Sending funds out, or changing the account, needs your own wallet.";
    case "BlockedCall":
    case "DelegateCallNotAllowed":
    case "ModulesNotAllowed":
      return "Blocked by MyPropGuard: this kind of transaction is not allowed on a protected account.";
    default:
      return `Blocked by MyPropGuard (${decoded.errorName}).`;
  }
}

/** Finds raw revert bytes anywhere inside a viem error, however deeply wrapped. */
function revertDataOf(error: unknown): Hex | undefined {
  let current: any = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const data = current.data ?? current.raw;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) return data as Hex;
    if (data && typeof data === "object" && typeof data.data === "string" && data.data.startsWith("0x")) return data.data as Hex;
    current = current.cause;
  }
  return undefined;
}

/** Accepts a signature with v of 0/1 or 27/28 and returns the form the Safe expects (27/28). */
function normalizeSignature(signature: Hex): Hex {
  if (signature.length !== 132) throw new Error(`Unexpected signature length ${signature.length}`);
  const v = parseInt(signature.slice(130), 16);
  if (v === 27 || v === 28) return signature;
  if (v === 0 || v === 1) return `${signature.slice(0, 130)}${(v + 27).toString(16)}` as Hex;
  throw new Error(`Unexpected signature v ${v}`);
}

/**
 * Runs a trade for a trader's Safe the way a wallet would, with no prompt: it builds the Safe transaction,
 * has the trader's session key sign it, and sends it to the chain from a separate gas wallet.
 *
 * Nothing here can move more than the Guard allows. The Guard reads who signed, sees the session key,
 * and lets the transaction trade only, inside the per-buy cap, the daily buy count and the freeze.
 * Before anything is sent the exact transaction is simulated, so a trade the Guard (or the exchange)
 * would refuse comes back as a plain explanation rather than a failed on-chain transaction.
 *
 * One transaction at a time: a Safe's nonce must be used in order, and the gas wallet's nonce too, so each
 * trade waits for the previous one to be mined before it builds its own.
 */
export class SafeSessionExecutor {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly gasAccount: Account,
    private readonly chain: Chain,
    private readonly signer: SafeTxTypedDataSigner,
    private readonly options: { receiptTimeoutMs?: number } = {},
  ) {}

  /** Signs and sends one trade. Resolves with the transaction hash as soon as it is broadcast. */
  async execute(trade: SessionTrade): Promise<Hash> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;

    let mined: Promise<unknown> | undefined;
    try {
      const hash = await this.signSimulateAndSend(trade);
      mined = this.publicClient
        .waitForTransactionReceipt({ hash, timeout: this.options.receiptTimeoutMs ?? 90_000 })
        .catch(() => undefined);
      return hash;
    } finally {
      // The next trade starts once this one is mined (or after the timeout), so the nonces stay in order.
      if (mined) void mined.finally(release);
      else release();
    }
  }

  private async signSimulateAndSend(trade: SessionTrade): Promise<Hash> {
    const nonce = await this.publicClient.readContract({ address: trade.safeAddress, abi: safeExecAbi, functionName: "nonce" });

    const message = {
      to: trade.to,
      value: trade.value,
      data: trade.data,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce,
    };
    const domain = { chainId: this.chain.id, verifyingContract: trade.safeAddress };

    const raw = await this.signer.signTypedData(trade.sessionWalletId, {
      domain,
      types: SAFE_TX_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      primaryType: "SafeTx",
      message: {
        ...message,
        value: message.value.toString(),
        safeTxGas: "0",
        baseGas: "0",
        gasPrice: "0",
        nonce: message.nonce.toString(),
      },
    });
    const signature = normalizeSignature(raw);

    // The signature must be the session key's own, or the Safe would reject it - and a signature from some
    // other key must never be sent as if it were. Check before spending gas.
    const signer = await recoverTypedDataAddress({
      domain,
      types: { SafeTx: SAFE_TX_TYPES.SafeTx },
      primaryType: "SafeTx",
      message,
      signature,
    });
    if (!isAddressEqual(signer, trade.sessionWalletAddress)) {
      throw new SessionTradeRefused("SIGNATURE_MISMATCH", `The signing wallet is ${signer}, not the session key ${trade.sessionWalletAddress}.`);
    }

    const args = [trade.to, trade.value, trade.data, 0, 0n, 0n, 0n, ZERO, ZERO, signature] as const;
    try {
      await this.publicClient.simulateContract({
        address: trade.safeAddress,
        abi: safeExecAbi,
        functionName: "execTransaction",
        args,
        account: this.gasAccount,
      });
    } catch (error) {
      throw this.explain(error);
    }

    const gas = await this.publicClient.estimateContractGas({
      address: trade.safeAddress,
      abi: safeExecAbi,
      functionName: "execTransaction",
      args,
      account: this.gasAccount,
    });

    return this.walletClient.writeContract({
      address: trade.safeAddress,
      abi: safeExecAbi,
      functionName: "execTransaction",
      args,
      account: this.gasAccount,
      chain: this.chain,
      gas: (gas * 125n) / 100n,
    });
  }

  private explain(error: unknown): Error {
    const data = revertDataOf(error);
    if (data) {
      const sentence = describeGuardRevert(data);
      if (sentence) return new SessionTradeRefused("GUARD_REFUSED", sentence);
    }
    const text = error instanceof Error ? `${error.message} ${(error as any).shortMessage ?? ""}` : String(error);
    // GS013: the Safe ran the call and the call itself failed (for example the exchange rejected it).
    if (text.includes("GS013")) {
      return new SessionTradeRefused("TRADE_WOULD_FAIL", "The exchange would reject this trade (for example the price moved past your slippage limit, or the quote expired). Nothing was sent.");
    }
    return error instanceof Error ? error : new Error(text);
  }
}

// ---- one-time setup transactions the trader's own wallet sends -------------------------------------------

function packMultiSend(calls: Array<{ to: Address; data: Hex }>): Hex {
  return concat(calls.map((call) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, call.to, 0n, BigInt((call.data.length - 2) / 2), call.data])));
}

export interface OwnerSafeTxParams {
  publicClient: PublicClient;
  safeAddress: Address;
  /** The trader's own wallet: an owner of the Safe, and the one that will send this transaction. */
  ownerAddress: Address;
  multiSendCallOnly: Address;
}

/**
 * Wraps calls into ONE Safe transaction that the owner can send straight from their own wallet. A Safe accepts an
 * owner's own transaction without a separate signature step (signature type 1: "the sender approves"), so the trader
 * confirms once in their wallet and pays the gas themselves. Returns what to send: { to, data, value }.
 */
async function ownerBatch(params: OwnerSafeTxParams, calls: Array<{ to: Address; data: Hex }>): Promise<{ to: Address; data: Hex; value: "0x0" }> {
  const owners = (await params.publicClient.readContract({ address: params.safeAddress, abi: safeExecAbi, functionName: "getOwners" })) as readonly Address[];
  if (!owners.some((o) => isAddressEqual(o, params.ownerAddress))) {
    throw new Error(`${params.ownerAddress} is not an owner of Safe ${params.safeAddress}.`);
  }
  const inner = encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packMultiSend(calls)] });
  // Signature type 1: r = the owner's address, s = 0, v = 1.
  const signature = concat([encodeAbiParameters([{ type: "uint256" }], [BigInt(params.ownerAddress)]), toHex(0, { size: 32 }), "0x01"]);
  const data = encodeFunctionData({
    abi: safeExecAbi,
    functionName: "execTransaction",
    args: [params.multiSendCallOnly, 0n, inner, 1, 0n, 0n, 0n, ZERO, ZERO, signature],
  });
  return { to: params.safeAddress, data, value: "0x0" };
}

/** Marks the key as a session key at the Guard and adds it as a Safe owner, keeping the threshold as it is. */
export async function buildEnableSessionKeyTx(params: OwnerSafeTxParams & { guardAddress: Address; sessionKeyAddress: Address }) {
  const threshold = await params.publicClient.readContract({ address: params.safeAddress, abi: safeExecAbi, functionName: "getThreshold" });
  return ownerBatch(params, [
    { to: params.guardAddress, data: encodeFunctionData({ abi: spotGuardSessionAbi, functionName: "addSessionKey", args: [params.sessionKeyAddress] }) },
    { to: params.safeAddress, data: encodeFunctionData({ abi: safeExecAbi, functionName: "addOwnerWithThreshold", args: [params.sessionKeyAddress, threshold] }) },
  ]);
}

/** Takes the key off the Guard's list and removes it as a Safe owner. */
export async function buildDisableSessionKeyTx(params: OwnerSafeTxParams & { guardAddress: Address; sessionKeyAddress: Address }) {
  const [owners, threshold] = await Promise.all([
    params.publicClient.readContract({ address: params.safeAddress, abi: safeExecAbi, functionName: "getOwners" }) as Promise<readonly Address[]>,
    params.publicClient.readContract({ address: params.safeAddress, abi: safeExecAbi, functionName: "getThreshold" }),
  ]);
  const index = owners.findIndex((o) => isAddressEqual(o, params.sessionKeyAddress));
  if (index < 0) throw new Error("The session key is not an owner of this Safe.");
  const previous = index === 0 ? SENTINEL_OWNERS : owners[index - 1]!;
  return ownerBatch(params, [
    { to: params.guardAddress, data: encodeFunctionData({ abi: spotGuardSessionAbi, functionName: "removeSessionKey", args: [params.sessionKeyAddress] }) },
    { to: params.safeAddress, data: encodeFunctionData({ abi: safeExecAbi, functionName: "removeOwner", args: [previous, params.sessionKeyAddress, threshold] }) },
  ]);
}

/** True when the Safe lists the key as an owner AND the Guard recognises it as a session key. Both are needed. */
export async function isSessionKeyActive(publicClient: PublicClient, safeAddress: Address, guardAddress: Address, sessionKeyAddress: Address): Promise<boolean> {
  const [owner, marked] = await Promise.all([
    publicClient.readContract({ address: safeAddress, abi: safeExecAbi, functionName: "isOwner", args: [getAddress(sessionKeyAddress)] }),
    publicClient.readContract({ address: guardAddress, abi: spotGuardSessionAbi, functionName: "isSessionKey", args: [safeAddress, sessionKeyAddress] }),
  ]);
  return Boolean(owner) && Boolean(marked);
}
