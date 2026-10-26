import bs58 from "bs58";
import { SOLANA_MAINNET_CAIP2, checkSolanaLoginMessage, describeTransaction, inspectTransaction, type InspectedTransaction } from "@mypropguard/solana";
import type { LinkedSession } from "../oneClick/oneClickStore.js";
import type { RpcReply } from "../oneClick/oneClickRequestHandler.js";
import type { SolanaRequestKind, SolanaStore } from "./solanaStore.js";

export interface SolanaHandlerDeps {
  store: Pick<SolanaStore, "get" | "recordRequest">;
  /** Signs a message the owner's rules approved. Message and signature are base64 (Privy's format). */
  signer: { signMessage(walletId: string, messageBase64: string): Promise<string> };
  log?: (message: string) => void;
}

const fail = (code: number, message: string): RpcReply => ({ error: { code, message } });

/** Why transactions are not signed yet. Shown to the site, and to the owner in the activity list. */
const NOT_SWITCHED_ON =
  "MyPropGuard's Solana wallet does not sign trades yet. It recorded what this site asked for so the rules can be built around it. Nothing was signed and no money moved.";

/**
 * Answers the requests a linked site sends to the account's Solana wallet.
 *
 * FIRST VERSION: it links the site, tells it the wallet's address, signs its login (readable text for a site it knows,
 * never a transaction in disguise), and for every transaction request it READS the transaction, records what it does,
 * and refuses. No transaction is signed until the rules for trading are in place. Every request re-reads the wallet
 * record, so switching it off takes effect on the very next request.
 */
export class SolanaRequestHandler {
  constructor(private readonly deps: SolanaHandlerDeps) {}

  async handle(session: LinkedSession, caipChainId: string, request: { method: string; params?: unknown }): Promise<RpcReply> {
    const wallet = await this.deps.store.get(session.accountId);
    if (!wallet || wallet.status !== "active") {
      return fail(4100, "Your MyPropGuard Solana wallet is switched off. Switch it on in MyPropGuard, then connect the site again.");
    }
    if (caipChainId !== SOLANA_MAINNET_CAIP2) return fail(4901, `This wallet works on Solana mainnet only, not ${caipChainId}.`);

    const record = (r: { kind: SolanaRequestKind; result: "SIGNED" | "REFUSED" | "ERROR"; code?: string; message?: string; detail?: unknown }) =>
      this.deps.store.recordRequest({ accountId: session.accountId, dappName: session.dappName, method: request.method, ...r }).catch(() => undefined);

    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "solana_getAccounts":
      case "solana_requestAccounts":
        return { result: [{ pubkey: wallet.address }] };

      case "solana_signMessage": {
        if (typeof params.pubkey === "string" && params.pubkey !== wallet.address) {
          return fail(-32602, `The signature was requested for ${params.pubkey}, but this wallet is ${wallet.address}.`);
        }
        if (typeof params.message !== "string") return fail(-32602, "Missing message.");
        let bytes: Uint8Array;
        try {
          bytes = bs58.decode(params.message);
        } catch {
          return fail(-32602, "The message is not valid.");
        }
        const check = checkSolanaLoginMessage(bytes, { url: session.dappUrl });
        if (!check.ok) {
          await record({ kind: "login", result: "REFUSED", code: "LOGIN_REFUSED", message: check.message, detail: { text: check.preview } });
          return fail(4200, check.message);
        }
        try {
          const signature = await this.deps.signer.signMessage(wallet.walletId, Buffer.from(bytes).toString("base64"));
          await record({ kind: "login", result: "SIGNED", message: "signed a login", detail: { text: check.text } });
          return { result: { signature: bs58.encode(Buffer.from(signature, "base64")) } };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          await record({ kind: "login", result: "ERROR", message: text, detail: { text: check.text } });
          return fail(-32000, `MyPropGuard could not sign the login: ${text.split("\n")[0]}`);
        }
      }

      case "solana_signTransaction":
      case "solana_signAndSendTransaction":
        return this.refuseTransactions(record, [params.transaction]);

      case "solana_signAllTransactions":
        return this.refuseTransactions(record, Array.isArray(params.transactions) ? params.transactions : []);

      default:
        return fail(-32601, `${request.method} is not supported by this MyPropGuard wallet.`);
    }
  }

  /** Reads each transaction, records what it does, and refuses all of them (see the class comment). */
  private async refuseTransactions(
    record: (r: { kind: SolanaRequestKind; result: "REFUSED" | "ERROR"; code?: string; message?: string; detail?: unknown }) => Promise<void>,
    transactions: unknown[],
  ): Promise<RpcReply> {
    if (transactions.length === 0 || transactions.some((t) => typeof t !== "string")) return fail(-32602, "Missing transaction.");
    const read: Array<InspectedTransaction | { unreadable: string }> = [];
    for (const raw of transactions as string[]) {
      try {
        read.push(inspectTransaction(raw));
      } catch (error) {
        read.push({ unreadable: error instanceof Error ? error.message : "could not be read" });
      }
    }
    const first = read[0]!;
    const summary = "unreadable" in first ? `could not read the transaction (${first.unreadable})` : describeTransaction(first);
    this.deps.log?.(`solana transaction request recorded and refused: ${summary}`);
    await record({ kind: "transaction", result: "REFUSED", code: "TRADING_NOT_ENABLED", message: summary, detail: { transactions: read } });
    return fail(4200, NOT_SWITCHED_ON);
  }
}
