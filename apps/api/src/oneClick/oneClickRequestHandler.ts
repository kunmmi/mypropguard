import { getAddress, isAddress, isAddressEqual, isHex, type Address, type Hash, type Hex } from "viem";
import { SessionTradeRefused, type SessionTrade } from "@mypropguard/evm";
import type { LinkedSession, OneClickRecord } from "./oneClickStore.js";

/** What the handler needs from the executor (the real one is packages/evm's SafeSessionExecutor). */
export interface TradeExecutor {
  execute(trade: SessionTrade): Promise<Hash>;
}

export interface OneClickHandlerDeps {
  store: {
    get(accountId: string): Promise<OneClickRecord | undefined>;
    getSession(topic: string): Promise<LinkedSession | undefined>;
    recordTrade(trade: {
      accountId: string;
      dappName: string | null;
      toAddress: string | null;
      valueWei: string | null;
      txHash: string | null;
      result: "SENT" | "REFUSED" | "ERROR";
      message: string | null;
    }): Promise<void>;
  };
  findAccount(accountId: string): Promise<{ evmSafeAddress?: string | null; evmChainId?: number | null } | undefined | null>;
  /** The executor for each chain id the server is set up for. */
  executors: Record<number, TradeExecutor>;
  /** Answers requests on links to a trading ("float") wallet instead of the Safe. Absent = those links are refused. */
  float?: { handle(session: LinkedSession, caipChainId: string, request: { method: string; params?: unknown }): Promise<RpcReply> };
  /** Answers requests on links to a Solana wallet. Absent = those links are refused. */
  solana?: { handle(session: LinkedSession, caipChainId: string, request: { method: string; params?: unknown }): Promise<RpcReply> };
}

const KNOWN_SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve",
  "0x39509351": "increaseAllowance",
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0xa22cb465": "setApprovalForAll",
  "0x42842e0e": "safeTransferFrom",
  "0xb88d4fde": "safeTransferFrom",
  "0xd0e30db0": "deposit",
  "0x2e1a7d4d": "withdraw",
  "0x3593564c": "execute",
};

/** A short, safe description of a call for the trader and the log: what it is, and for an approval, to whom. */
export function summarizeCall(to: string, data: string): string {
  const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : "no data";
  const name = KNOWN_SELECTORS[selector];
  let detail = name ? `${name} (${selector})` : selector;
  if ((selector === "0x095ea7b3" || selector === "0x39509351") && data.length >= 74) {
    detail += ` for spender 0x${data.slice(34, 74)}`;
  }
  return `${detail} on ${to}`;
}

export type RpcReply = { result: unknown } | { error: { code: number; message: string } };

const UNSUPPORTED_SIGNING =
  "MyPropGuard protected accounts cannot sign messages. This site asked for a signature, which a Safe cannot give without opening a way around the limits. Trading does not need one.";

function fail(code: number, message: string): RpcReply {
  return { error: { code, message } };
}

/** The wallet methods exposed to linked exchanges. */
export const SUPPORTED_METHODS = ["eth_sendTransaction", "eth_accounts", "eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "personal_sign", "eth_signTypedData", "eth_signTypedData_v4", "eth_sign"] as const;

/**
 * Answers the requests a linked exchange sends to the trader's "wallet". The one that matters is
 * eth_sendTransaction: it is signed by the account's session key and sent, if the account is still switched on.
 * Every request looks the account up afresh, so switching one-click trading off takes effect on the very next trade.
 */
export class OneClickRequestHandler {
  constructor(private readonly deps: OneClickHandlerDeps) {}

  async handle(topic: string, caipChainId: string, request: { method: string; params?: unknown }): Promise<RpcReply> {
    const session = await this.deps.store.getSession(topic);
    if (!session) return fail(4100, "This link to MyPropGuard is no longer active. Link the site again from the MyPropGuard dashboard.");
    if (session.kind === "solana") {
      return this.deps.solana ? this.deps.solana.handle(session, caipChainId, request) : fail(4100, "Solana wallets are not set up on this server.");
    }
    if (session.kind === "float") {
      return this.deps.float ? this.deps.float.handle(session, caipChainId, request) : fail(4100, "Trading wallets are not set up on this server.");
    }

    const [account, record] = await Promise.all([this.deps.findAccount(session.accountId), this.deps.store.get(session.accountId)]);
    if (!account?.evmSafeAddress || !account.evmChainId) return fail(4100, "This MyPropGuard account has no protected Safe.");
    const safe = getAddress(account.evmSafeAddress);
    const chainId = account.evmChainId;

    switch (request.method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return { result: [safe] };
      case "eth_chainId":
        return { result: `0x${chainId.toString(16)}` };
      case "wallet_switchEthereumChain": {
        const wanted = (request.params as Array<{ chainId?: string }> | undefined)?.[0]?.chainId;
        return wanted && parseInt(wanted, 16) === chainId ? { result: null } : fail(4902, `This account trades on chain ${chainId} only.`);
      }
      case "personal_sign":
      case "eth_sign":
      case "eth_signTypedData":
      case "eth_signTypedData_v4":
        return fail(4200, UNSUPPORTED_SIGNING);
      case "eth_sendTransaction":
        return this.sendTransaction(session, record, safe, chainId, caipChainId, request.params);
      default:
        return fail(-32601, `${request.method} is not supported by MyPropGuard.`);
    }
  }

  private async sendTransaction(
    session: LinkedSession,
    record: OneClickRecord | undefined,
    safe: Address,
    chainId: number,
    caipChainId: string,
    params: unknown,
  ): Promise<RpcReply> {
    const audit = (result: "SENT" | "REFUSED" | "ERROR", message: string | null, tx?: { to?: string; value?: bigint }, txHash?: string) =>
      this.deps.store
        .recordTrade({
          accountId: session.accountId,
          dappName: session.dappName,
          toAddress: tx?.to ?? null,
          valueWei: tx?.value !== undefined ? tx.value.toString() : null,
          txHash: txHash ?? null,
          result,
          message,
        })
        .catch(() => undefined);

    if (!record || record.status !== "enabled") {
      const message = "One-click trading is switched off for this account. Switch it on in MyPropGuard first.";
      await audit("REFUSED", message);
      return fail(4100, message);
    }
    if (caipChainId !== `eip155:${chainId}`) return fail(4901, `This account trades on chain ${chainId}, not ${caipChainId}.`);
    const executor = this.deps.executors[chainId];
    if (!executor) return fail(4900, `One-click trading is not set up on chain ${chainId}.`);

    const tx = (params as Array<Record<string, unknown>> | undefined)?.[0];
    if (!tx || typeof tx !== "object") return fail(-32602, "Missing transaction.");
    if (typeof tx.from === "string" && isAddress(tx.from, { strict: false }) && !isAddressEqual(tx.from as Address, safe)) {
      return fail(-32602, `The transaction is from ${tx.from}, but this account is ${safe}.`);
    }
    if (typeof tx.to !== "string" || !isAddress(tx.to, { strict: false })) return fail(-32602, "Deploying a contract is not supported.");
    const to = getAddress(tx.to);
    const dataField = tx.data ?? tx.input ?? "0x";
    if (typeof dataField !== "string" || !isHex(dataField)) return fail(-32602, "The transaction data is not valid.");
    let value: bigint;
    try {
      value = tx.value === undefined || tx.value === null ? 0n : BigInt(tx.value as string);
    } catch {
      return fail(-32602, "The transaction value is not valid.");
    }

    try {
      const hash = await executor.execute({
        safeAddress: safe,
        sessionWalletId: record.sessionWalletId,
        sessionWalletAddress: getAddress(record.sessionWalletAddress),
        to,
        value,
        data: dataField as Hex,
      });
      await audit("SENT", null, { to, value }, hash);
      return { result: hash };
    } catch (error) {
      if (error instanceof SessionTradeRefused) {
        // Say which call was refused, so an unexpected refusal can be understood from the dashboard alone.
        const message = `${error.message} [${summarizeCall(to, dataField)}]`;
        await audit("REFUSED", message, { to, value });
        return fail(-32000, message);
      }
      const message = error instanceof Error ? error.message : String(error);
      await audit("ERROR", message, { to, value });
      return fail(-32000, `MyPropGuard could not send this trade: ${message.split("\n")[0]}`);
    }
  }
}
