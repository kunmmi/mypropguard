import { getAddress, isAddress, isAddressEqual, isHex, type Address, type Hex } from "viem";
import { FloatTradeRefused, checkLoginMessage, type FloatExecutor, type FloatWalletSigner } from "@mypropguard/evm";
import type { FloatRiskGuard } from "./floatRiskGuard.js";
import type { WalletAccountRules } from "./accountRules.js";
import type { FloatStore, FloatTradeKind } from "./floatStore.js";
import type { LinkedSession } from "../oneClick/oneClickStore.js";
import type { RpcReply } from "../oneClick/oneClickRequestHandler.js";

export interface FloatHandlerDeps {
  store: Pick<FloatStore, "get" | "usageToday" | "recordTrade">;
  executor: Pick<FloatExecutor, "execute">;
  signer: Pick<FloatWalletSigner, "personalSign">;
  /**
   * The account's own MyPropGuard rules that also bind this wallet (the trade-frequency and cooldown rules). The
   * tighter of these and the wallet's own limits applies. If they cannot be read, buying is paused (selling is not).
   */
  accountRules?(accountId: string): Promise<WalletAccountRules>;
  /** Enforces the rules that depend on what the wallet is worth. Absent = those rules are not applied. */
  riskGuard?: Pick<FloatRiskGuard, "checkBuy" | "valueSell">;
  now?: () => number;
  /** Per-step timing, printed so slow steps are visible in the host's logs. */
  log?: (message: string) => void;
}

const SIGNATURE_NEVER =
  "This trading wallet does not sign typed data or raw hashes: they are how token permits and off-chain orders move funds with no transaction. Trading does not need one.";

const fail = (code: number, message: string): RpcReply => ({ error: { code, message } });

/**
 * Answers the requests a linked site sends to the account's TRADING wallet (a plain wallet the site can log in with),
 * as opposed to OneClickRequestHandler, which answers for the Safe. Every request re-reads the wallet record, so
 * switching it off or freezing it takes effect on the very next request.
 */
export class FloatRequestHandler {
  constructor(private readonly deps: FloatHandlerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async handle(session: LinkedSession, caipChainId: string, request: { method: string; params?: unknown }): Promise<RpcReply> {
    const wallet = await this.deps.store.get(session.accountId);
    if (!wallet || wallet.status !== "active") {
      return fail(4100, "Your MyPropGuard wallet is switched off. Switch it on in MyPropGuard, then connect the site again.");
    }
    const chainId = wallet.chainId;
    const audit = (r: {
      kind: FloatTradeKind;
      result: "SENT" | "REFUSED" | "ERROR";
      code?: string | null;
      message?: string | null;
      to?: string | null;
      token?: string | null;
      value?: bigint | null;
      proceeds?: bigint | null;
      hash?: string | null;
      timings?: { checkMs: number; estimateMs: number; sendMs: number; totalMs: number };
    }) =>
      this.deps.store
        .recordTrade({
          accountId: session.accountId,
          dappName: session.dappName,
          kind: r.kind,
          toAddress: r.to ?? null,
          tokenAddress: r.token ?? null,
          valueWei: r.value ?? null,
          proceedsWei: r.proceeds ?? null,
          txHash: r.hash ?? null,
          result: r.result,
          code: r.code ?? null,
          message: r.message ?? null,
          timings: r.timings,
        })
        .catch(() => undefined);

    switch (request.method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return { result: [getAddress(wallet.address)] };
      case "eth_chainId":
        return { result: `0x${chainId.toString(16)}` };
      case "wallet_switchEthereumChain": {
        const wanted = (request.params as Array<{ chainId?: string }> | undefined)?.[0]?.chainId;
        return wanted && parseInt(wanted, 16) === chainId ? { result: null } : fail(4902, `This wallet trades on chain ${chainId} only.`);
      }

      case "personal_sign": {
        // Standard order is [message, address]; a few older sites send [address, message].
        const p = (request.params as unknown[] | undefined) ?? [];
        const [a, b] = [p[0], p[1]];
        const [message, from] = typeof a === "string" && isAddress(a, { strict: false }) && !(typeof b === "string" && isAddress(b, { strict: false })) ? [b, a] : [a, b];
        if (typeof message !== "string") return fail(-32602, "Missing message.");
        if (typeof from === "string" && isAddress(from, { strict: false }) && !isAddressEqual(from as Address, wallet.address)) {
          return fail(-32602, `The signature was requested for ${from}, but this wallet is ${wallet.address}.`);
        }
        const check = checkLoginMessage(message, { url: session.dappUrl }, getAddress(wallet.address), chainId);
        if (!check.ok) {
          await audit({ kind: "login", result: "REFUSED", code: "LOGIN_REFUSED", message: check.message });
          return fail(4200, check.message);
        }
        try {
          const signature = await this.deps.signer.personalSign(wallet.walletId, check.text);
          await audit({ kind: "login", result: "SENT", message: `signed a ${check.kind} login` });
          return { result: signature };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          await audit({ kind: "login", result: "ERROR", message: text });
          return fail(-32000, `MyPropGuard could not sign the login: ${text.split("\n")[0]}`);
        }
      }

      case "eth_sign":
      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4":
        await audit({ kind: "other", result: "REFUSED", code: "SIGNATURE_REFUSED", message: `${request.method} refused` });
        return fail(4200, SIGNATURE_NEVER);

      case "eth_sendTransaction":
        return this.sendTransaction(session, wallet, caipChainId, request.params, audit);

      default:
        return fail(-32601, `${request.method} is not supported by this MyPropGuard wallet.`);
    }
  }

  private async sendTransaction(
    session: LinkedSession,
    wallet: NonNullable<Awaited<ReturnType<FloatStore["get"]>>>,
    caipChainId: string,
    params: unknown,
    audit: (r: {
      kind: FloatTradeKind;
      result: "SENT" | "REFUSED" | "ERROR";
      code?: string | null;
      message?: string | null;
      to?: string | null;
      token?: string | null;
      value?: bigint | null;
      proceeds?: bigint | null;
      hash?: string | null;
      timings?: { checkMs: number; estimateMs: number; sendMs: number; totalMs: number };
    }) => Promise<void>,
  ): Promise<RpcReply> {
    if (caipChainId !== `eip155:${wallet.chainId}`) return fail(4901, `This wallet trades on chain ${wallet.chainId}, not ${caipChainId}.`);
    const tx = (params as Array<Record<string, unknown>> | undefined)?.[0];
    if (!tx || typeof tx !== "object") return fail(-32602, "Missing transaction.");
    if (typeof tx.from === "string" && isAddress(tx.from, { strict: false }) && !isAddressEqual(tx.from as Address, wallet.address)) {
      return fail(-32602, `The transaction is from ${tx.from}, but this wallet is ${wallet.address}.`);
    }
    if (typeof tx.to !== "string" || !isAddress(tx.to, { strict: false })) return fail(-32602, "Deploying a contract is not supported.");
    const to = getAddress(tx.to);
    const data = tx.data ?? tx.input ?? "0x";
    if (typeof data !== "string" || !isHex(data)) return fail(-32602, "The transaction data is not valid.");
    let value: bigint;
    try {
      value = tx.value === undefined || tx.value === null ? 0n : BigInt(tx.value as string);
    } catch {
      return fail(-32602, "The transaction value is not valid.");
    }

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
          address: getAddress(wallet.address),
          limits: { maxBuysPerDay, cooldownSec, frozen },
          percentOfBalance: { maxBuyPct: wallet.maxBuyPct, dailySpendPct: wallet.dailySpendPct },
        },
        { to, value, data: data as Hex },
        {
          loadUsage: () => this.deps.store.usageToday(wallet.accountId, this.now()),
          beforeBuy: this.deps.riskGuard
            ? (decision) => this.deps.riskGuard!.checkBuy({ accountId: wallet.accountId, address: getAddress(wallet.address) }, valueRules, decision)
            : undefined,
          valueSell: this.deps.riskGuard ? (decision) => this.deps.riskGuard!.valueSell(decision) : undefined,
          // Recorded INSIDE the executor's lock, so the very next trade already sees this one in the day's counters.
          onSent: (decision, hash, timings, meta) =>
            audit({
              kind: decision.kind,
              result: "SENT",
              to,
              token: decision.token ?? null,
              value,
              proceeds: meta.proceedsWei,
              hash,
              message: decision.summary,
              timings: { ...timings, totalMs: this.now() - requestedAt },
            }),
        },
      );
      this.deps.log?.(
        `float ${out.decision.kind} for ${wallet.accountId}: total ${out.timings.totalMs} ms (check ${out.timings.checkMs}, dry-run ${out.timings.estimateMs}, sign+send ${out.timings.sendMs})`,
      );
      return { result: out.hash };
    } catch (error) {
      if (error instanceof FloatTradeRefused) {
        await audit({ kind: value > 0n ? "buy" : "other", result: "REFUSED", code: error.code, message: error.message, to, value });
        return fail(-32000, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      await audit({ kind: value > 0n ? "buy" : "other", result: "ERROR", message, to, value });
      return fail(-32000, `MyPropGuard could not send this trade: ${message.split("\n")[0]}`);
    }
  }
}
