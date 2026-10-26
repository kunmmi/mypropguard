import bs58 from "bs58";
import {
  SOLANA_MAINNET_CAIP2,
  SolanaTradeRefused,
  checkSolanaLoginMessage,
  describeTransaction,
  inspectTransaction,
  type InspectedTransaction,
  type SolanaExecutor,
} from "@mypropguard/solana";
import type { LinkedSession } from "../oneClick/oneClickStore.js";
import type { RpcReply } from "../oneClick/oneClickRequestHandler.js";
import type { WalletAccountRules } from "../float/accountRules.js";
import type { SolanaRiskGuard } from "./solanaRiskGuard.js";
import type { SolanaRequestKind, SolanaStore } from "./solanaStore.js";

export interface SolanaHandlerDeps {
  store: Pick<SolanaStore, "get" | "recordRequest" | "usageToday">;
  /** Signs a message the owner's rules approved. Message and signature are base64 (Privy's format). */
  signer: { signMessage(walletId: string, messageBase64: string): Promise<string> };
  /** Judges, simulates, signs and sends trades. Absent, or `tradingEnabled` false: transactions are recorded and refused. */
  executor?: Pick<SolanaExecutor, "execute">;
  /** The safety switch for signing trades at all (ENABLE_SOLANA_TRADING). Off: every transaction is read, recorded, refused. */
  tradingEnabled?: boolean;
  /** The account's own rules that also bind this wallet. The tighter of these and the wallet's own limits applies. */
  accountRules?(accountId: string): Promise<WalletAccountRules>;
  /** Enforces the rules that depend on what the wallet is worth. Absent = those rules are not applied. */
  riskGuard?: Pick<SolanaRiskGuard, "checkBuy" | "valueSell">;
  now?: () => number;
  log?: (message: string) => void;
}

const fail = (code: number, message: string): RpcReply => ({ error: { code, message } });

const NOT_SWITCHED_ON =
  "MyPropGuard's Solana wallet does not sign trades yet. It recorded what this site asked for so the rules can be built around it. Nothing was signed and no money moved.";

type Record_ = (r: {
  kind: SolanaRequestKind;
  result: "SIGNED" | "REFUSED" | "ERROR";
  code?: string;
  message?: string;
  detail?: unknown;
  tradeKind?: "buy" | "sell";
  mint?: string;
  lamports?: bigint | null;
  proceedsLamports?: bigint | null;
  signature?: string;
  timings?: { checkMs: number; simulateMs: number; signMs: number; totalMs: number };
}) => Promise<void>;

/**
 * Answers the requests a linked site sends to the account's Solana wallet: tells it the wallet's address, signs its login
 * (readable text for a site it knows, never a transaction in disguise), and judges every transaction before anything is
 * signed (packages/solana). Every request re-reads the wallet record, so switching it off or pausing it takes effect on the
 * very next request.
 */
export class SolanaRequestHandler {
  constructor(private readonly deps: SolanaHandlerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async handle(session: LinkedSession, caipChainId: string, request: { method: string; params?: unknown }): Promise<RpcReply> {
    const wallet = await this.deps.store.get(session.accountId);
    if (!wallet || wallet.status !== "active") {
      return fail(4100, "Your MyPropGuard Solana wallet is switched off. Switch it on in MyPropGuard, then connect the site again.");
    }
    if (caipChainId !== SOLANA_MAINNET_CAIP2) return fail(4901, `This wallet works on Solana mainnet only, not ${caipChainId}.`);

    const record: Record_ = (r) =>
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
      case "solana_signAndSendTransaction": {
        if (typeof params.transaction !== "string") return fail(-32602, "Missing transaction.");
        return this.trade(session, wallet, params.transaction, request.method === "solana_signAndSendTransaction" ? "signAndSend" : "sign", record);
      }

      case "solana_signAllTransactions": {
        const list = Array.isArray(params.transactions) ? params.transactions : [];
        if (list.length === 0 || list.some((t) => typeof t !== "string")) return fail(-32602, "Missing transaction.");
        if (list.length > 1) {
          // Signing several at once could leave some signed and some refused; trades are taken one at a time.
          await this.recordUnreadable(list as string[], record, "BATCH_REFUSED", "More than one transaction at once. Send them one at a time.");
          return fail(4200, "This wallet signs one trade at a time. Send them one by one.");
        }
        const out = await this.trade(session, wallet, list[0] as string, "sign", record);
        return "error" in out ? out : { result: { transactions: [(out.result as { transaction: string }).transaction] } };
      }

      default:
        return fail(-32601, `${request.method} is not supported by this MyPropGuard wallet.`);
    }
  }

  private async trade(
    session: LinkedSession,
    wallet: NonNullable<Awaited<ReturnType<SolanaStore["get"]>>>,
    transactionBase64: string,
    mode: "sign" | "signAndSend",
    record: Record_,
  ): Promise<RpcReply> {
    let inspected: InspectedTransaction | { unreadable: string };
    try {
      inspected = inspectTransaction(transactionBase64);
    } catch (error) {
      inspected = { unreadable: error instanceof Error ? error.message : "could not be read" };
    }
    const summary = "unreadable" in inspected ? `could not read the transaction (${inspected.unreadable})` : describeTransaction(inspected);

    // The safety switch: with trading off, everything is read, recorded and refused, as in the first version.
    if (!this.deps.tradingEnabled || !this.deps.executor) {
      this.deps.log?.(`solana transaction recorded and refused (trading off): ${summary}`);
      await record({ kind: "transaction", result: "REFUSED", code: "TRADING_NOT_ENABLED", message: summary, detail: { transactions: [inspected] } });
      return fail(4200, NOT_SWITCHED_ON);
    }

    // The account's own rules also bind this wallet: the tighter limit wins. If they cannot be read, buying pauses
    // (selling does not).
    let frozen = wallet.frozen;
    let maxBuysPerDay = wallet.maxBuysPerDay;
    let cooldownSec = wallet.cooldownSec;
    let valueRules: WalletAccountRules["value"] = {};
    if (this.deps.accountRules) {
      try {
        const rules = await this.deps.accountRules(wallet.accountId);
        valueRules = rules.value;
        if (rules.maxTradesPerDay !== undefined) maxBuysPerDay = Math.min(maxBuysPerDay, rules.maxTradesPerDay);
        if (rules.cooldownSec !== undefined) cooldownSec = Math.max(cooldownSec, rules.cooldownSec);
      } catch {
        frozen = true;
      }
    }

    const requestedAt = this.now();
    try {
      const out = await this.deps.executor.execute(
        {
          accountId: wallet.accountId,
          walletId: wallet.walletId,
          address: wallet.address,
          limits: { maxBuysPerDay, cooldownSec, frozen },
          percentOfBalance: { maxBuyPct: wallet.maxBuyPct, dailySpendPct: wallet.dailySpendPct },
        },
        transactionBase64,
        mode,
        {
          loadUsage: () => this.deps.store.usageToday(wallet.accountId, this.now()),
          beforeBuy: this.deps.riskGuard ? (d) => this.deps.riskGuard!.checkBuy({ accountId: wallet.accountId, address: wallet.address }, valueRules, d) : undefined,
          valueSell: this.deps.riskGuard ? (d) => this.deps.riskGuard!.valueSell(d) : undefined,
          // Recorded INSIDE the executor's lock, so the very next trade already sees this one in the day's counters.
          onDone: (decision, result, timings, meta) =>
            record({
              kind: "transaction",
              result: "SIGNED",
              message: `${decision.summary}${mode === "signAndSend" ? " (sent)" : ""}`,
              tradeKind: decision.kind,
              mint: decision.mint,
              lamports: decision.kind === "buy" ? decision.spendLamports : null,
              proceedsLamports: meta.proceedsLamports,
              signature: result.signature,
              timings: { ...timings, totalMs: this.now() - requestedAt },
              detail: { transactions: [inspected] },
            }),
        },
      );
      this.deps.log?.(
        `solana ${out.decision.kind} for ${wallet.accountId}: total ${out.timings.totalMs} ms (check ${out.timings.checkMs}, simulate ${out.timings.simulateMs}, sign${mode === "signAndSend" ? "+send" : ""} ${out.timings.signMs})`,
      );
      return { result: mode === "signAndSend" ? { signature: out.signature } : { signature: out.signature, transaction: out.signedBase64 } };
    } catch (error) {
      if (error instanceof SolanaTradeRefused) {
        await record({ kind: "transaction", result: "REFUSED", code: error.code, message: error.message, detail: { transactions: [inspected] } });
        return fail(-32000, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      await record({ kind: "transaction", result: "ERROR", message, detail: { transactions: [inspected] } });
      return fail(-32000, `MyPropGuard could not sign this trade: ${message.split("\n")[0]}`);
    }
  }

  private async recordUnreadable(list: string[], record: Record_, code: string, message: string): Promise<void> {
    const read = list.map((t) => {
      try {
        return inspectTransaction(t);
      } catch (error) {
        return { unreadable: error instanceof Error ? error.message : "could not be read" };
      }
    });
    await record({ kind: "transaction", result: "REFUSED", code, message, detail: { transactions: read } });
  }
}
