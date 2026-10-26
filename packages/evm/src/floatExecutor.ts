import type { Address, Hash, Hex, PublicClient } from "viem";
import {
  checkFloatTransaction,
  type FloatDecision,
  type FloatLimits,
  type FloatPolicyConfig,
  type FloatRefusalCode,
  type FloatTx,
} from "./floatPolicy.js";

/**
 * Signs for the trading wallet. The real one is Privy (the key never touches this server's disk); tests use a local key.
 */
export interface FloatWalletSigner {
  /** Signs and broadcasts one transaction from the wallet, returning its hash. Gas price and nonce are the signer's job. */
  sendTransaction(walletId: string, tx: { to: Address; value: bigint; data: Hex; gas?: bigint }): Promise<Hash>;
  /** Signs a text message (EIP-191 personal_sign). Only ever called after checkLoginMessage approved it. */
  personalSign(walletId: string, message: string): Promise<Hex>;
}

export interface FloatWalletRecord {
  accountId: string;
  walletId: string;
  address: Address;
  limits: FloatLimits;
}

/** What the day looks like so far, read from the trade log by the caller (so it survives a restart). */
export interface FloatUsage {
  buysToday: number;
  spentTodayWei: bigint;
  lastBuyAtSec: number | null;
}

/** A refusal the trader can read. `code` is stable for the UI and the log. */
export class FloatTradeRefused extends Error {
  constructor(
    readonly code: FloatRefusalCode | "WOULD_FAIL",
    message: string,
  ) {
    super(message);
    this.name = "FloatTradeRefused";
  }
}

export interface FloatTimings {
  /** Reading usage + balance and judging the trade. */
  checkMs: number;
  /** The "would this revert?" dry run. */
  estimateMs: number;
  /** Signing and broadcasting. */
  sendMs: number;
  /** Everything, including waiting for an earlier trade on the same wallet. */
  totalMs: number;
}

export interface FloatExecutorDeps {
  publicClient: Pick<PublicClient, "getBalance" | "estimateGas">;
  signer: FloatWalletSigner;
  /** Overrides the venue list or gas reserve; the wallet's own address is always filled in per wallet. */
  policy?: Partial<Omit<FloatPolicyConfig, "floatAddress">>;
  now?: () => number;
}

/** BNB kept back for fees so a buy can never leave the wallet unable to sell. */
export const DEFAULT_GAS_RESERVE_WEI = 2_000_000_000_000_000n; // 0.002 BNB

/** Headroom on the gas estimate: meme-token buys can use a little more gas by the time they land. */
const GAS_HEADROOM_NUM = 120n;
const GAS_HEADROOM_DEN = 100n;

/**
 * Judges, then signs and sends, one transaction proposed by a linked site for the trading wallet.
 *
 * ONE TRADE AT A TIME PER WALLET. Two buys arriving together would both read "0 spent today" and both pass. So the
 * whole sequence — read usage, judge, dry-run, send, record — runs inside a per-wallet lock, and the caller's
 * `onSent` is awaited inside it so the next trade sees this one.
 */
export class FloatExecutor {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly deps: FloatExecutorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async execute(
    wallet: FloatWalletRecord,
    tx: FloatTx,
    io: {
      loadUsage(): Promise<FloatUsage>;
      /**
       * Called inside the lock, after the transaction was accepted by the network and before the next trade is judged,
       * with the timings of every step so far (the total is added by the caller, who knows when the request arrived).
       */
      onSent(decision: Extract<FloatDecision, { ok: true }>, hash: Hash, timings: Omit<FloatTimings, "totalMs">): Promise<void>;
    },
  ): Promise<{ hash: Hash; decision: Extract<FloatDecision, { ok: true }>; timings: FloatTimings }> {
    const requestedAt = this.now();
    return this.withLock(wallet.address.toLowerCase(), async () => {
      const t0 = this.now();
      const [usage, balanceWei] = await Promise.all([io.loadUsage(), this.deps.publicClient.getBalance({ address: wallet.address })]);
      const decision = checkFloatTransaction(
        tx,
        wallet.limits,
        { ...usage, balanceWei, nowSec: Math.floor(this.now() / 1000) },
        { gasReserveWei: DEFAULT_GAS_RESERVE_WEI, ...this.deps.policy, floatAddress: wallet.address },
      );
      const t1 = this.now();
      if (!decision.ok) throw new FloatTradeRefused(decision.code, decision.message);

      // Would four.meme accept this right now? A reverted meme buy still costs gas, so find out before signing.
      let gas: bigint;
      try {
        const estimate = await this.deps.publicClient.estimateGas({ account: wallet.address, to: tx.to, value: tx.value, data: tx.data });
        gas = (estimate * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
      } catch (error) {
        const why = error instanceof Error ? (error as { shortMessage?: string }).shortMessage ?? error.message : String(error);
        throw new FloatTradeRefused("WOULD_FAIL", `four.meme would reject this right now, so nothing was sent and no fee was spent: ${why.split("\n")[0]}`);
      }
      const t2 = this.now();

      const hash = await this.deps.signer.sendTransaction(wallet.walletId, { to: tx.to, value: tx.value, data: tx.data, gas });
      const t3 = this.now();
      await io.onSent(decision, hash, { checkMs: t1 - t0, estimateMs: t2 - t1, sendMs: t3 - t2 });
      return {
        hash,
        decision,
        timings: { checkMs: t1 - t0, estimateMs: t2 - t1, sendMs: t3 - t2, totalMs: this.now() - requestedAt },
      };
    });
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    // A failed earlier trade must not block the next one, so swallow its error for ordering purposes only.
    const run = previous.catch(() => undefined).then(work);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
