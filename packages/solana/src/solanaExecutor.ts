import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { inspectTransaction } from "./txInspect.js";
import {
  DEFAULT_MAX_PRIORITY_FEE_LAMPORTS,
  DEFAULT_SOLANA_GAS_RESERVE_LAMPORTS,
  checkSolanaTransaction,
  type SolanaDecision,
  type SolanaLimits,
  type SolanaPolicyConfig,
  type SolanaRefusalCode,
} from "./solanaPolicy.js";
import type { SolanaRpc } from "./rpc.js";

/** Signs for the wallet. The real one is Privy (the key never touches this server's disk); tests use a local key. */
export interface SolanaWalletSigner {
  /** Signs a base64 transaction, returning the signed transaction as base64. Only ever called after the policy approved it. */
  signTransaction(walletId: string, transactionBase64: string): Promise<string>;
}

export interface SolanaWalletRecord {
  accountId: string;
  walletId: string;
  address: string;
  limits: { maxBuysPerDay: number; cooldownSec: number; frozen: boolean };
  /** Amount limits as a share of what the wallet holds, so they follow deposits and withdrawals. */
  percentOfBalance: { maxBuyPct: number; dailySpendPct: number };
}

/** What the day looks like so far, read from the trade log by the caller (so it survives a restart). */
export interface SolanaUsage {
  buysToday: number;
  spentTodayLamports: bigint;
  lastBuyAtSec: number | null;
}

/** A refusal the trader can read. `code` is stable for the UI and the log. */
export class SolanaTradeRefused extends Error {
  constructor(
    readonly code: SolanaRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "SolanaTradeRefused";
  }
}

export interface SolanaTimings {
  /** Reading the transaction, usage and balance, and judging it. */
  checkMs: number;
  /** The "would this fail?" simulation. */
  simulateMs: number;
  /** Signing (and sending, when asked). */
  signMs: number;
  totalMs: number;
}

export interface SolanaExecutorDeps {
  rpc: Pick<SolanaRpc, "getBalance" | "simulate" | "sendRaw">;
  signer: SolanaWalletSigner;
  policy?: Partial<Omit<SolanaPolicyConfig, "wallet">>;
  now?: () => number;
}

type Ok = Extract<SolanaDecision, { ok: true }>;

/**
 * Judges, simulates, then signs (and optionally sends) one transaction a linked Solana site proposed for the wallet.
 *
 * ONE TRADE AT A TIME PER WALLET: two buys arriving together would both read "0 spent today" and both pass, so the whole
 * sequence runs inside a per-wallet lock and the caller's `onDone` is awaited inside it.
 */
export class SolanaExecutor {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly deps: SolanaExecutorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async execute(
    wallet: SolanaWalletRecord,
    transactionBase64: string,
    mode: "sign" | "signAndSend",
    io: {
      loadUsage(): Promise<SolanaUsage>;
      /** Rules that depend on what the wallet is worth. Returns a refusal or null. Throwing means "could not check": the buy is stopped. */
      beforeBuy?(decision: Ok, balanceLamports: bigint): Promise<{ code: SolanaRefusalCode; message: string } | null>;
      /** What a sell should return, asked alongside the simulation. For the books only; never blocks. */
      valueSell?(decision: Ok): Promise<bigint | null>;
      /** Called inside the lock once the transaction is signed (and sent), before the next trade is judged. */
      onDone(decision: Ok, result: { signature: string; signedBase64: string }, timings: Omit<SolanaTimings, "totalMs">, meta: { proceedsLamports: bigint | null }): Promise<void>;
    },
  ): Promise<{ signature: string; signedBase64: string; decision: Ok; timings: SolanaTimings }> {
    const requestedAt = this.now();
    return this.withLock(wallet.address, async () => {
      const t0 = this.now();

      let inspected;
      try {
        inspected = inspectTransaction(transactionBase64);
      } catch (error) {
        throw new SolanaTradeRefused("UNKNOWN_INSTRUCTION", error instanceof Error ? error.message : "That transaction could not be read.");
      }

      const [usage, balanceLamports] = await Promise.all([io.loadUsage(), this.deps.rpc.getBalance(wallet.address)]);
      const share = wallet.percentOfBalance;
      const limits: SolanaLimits = {
        ...wallet.limits,
        maxBuyLamports: (balanceLamports * BigInt(share.maxBuyPct)) / 100n,
        dailySpendLamports: ((balanceLamports + usage.spentTodayLamports) * BigInt(share.dailySpendPct)) / 100n,
      };
      const decision = checkSolanaTransaction(
        inspected,
        limits,
        { ...usage, balanceLamports, nowSec: Math.floor(this.now() / 1000) },
        { gasReserveLamports: DEFAULT_SOLANA_GAS_RESERVE_LAMPORTS, maxPriorityFeeLamports: DEFAULT_MAX_PRIORITY_FEE_LAMPORTS, ...this.deps.policy, wallet: wallet.address },
      );
      if (!decision.ok) throw new SolanaTradeRefused(decision.code, decision.message);

      if (decision.kind === "buy" && io.beforeBuy) {
        let refusal: { code: SolanaRefusalCode; message: string } | null;
        try {
          refusal = await io.beforeBuy(decision, balanceLamports);
        } catch {
          throw new SolanaTradeRefused("VALUE_UNAVAILABLE", "Could not check your loss limits right now, so this buy was not signed. Selling still works. Try again in a moment.");
        }
        if (refusal) throw new SolanaTradeRefused(refusal.code, refusal.message);
      }
      const t1 = this.now();

      // Would the exchange accept this right now? A failed transaction still costs a fee, so find out before signing.
      let proceedsLamports: bigint | null = null;
      try {
        const [simulation, valued] = await Promise.all([
          this.deps.rpc.simulate(transactionBase64),
          decision.kind === "sell" && io.valueSell ? io.valueSell(decision).catch(() => null) : Promise.resolve(null),
        ]);
        proceedsLamports = valued;
        if (simulation.err) {
          const why = simulation.logs.filter((l) => /error|failed|insufficient|slippage|exceeded/i.test(l)).pop() ?? JSON.stringify(simulation.err);
          throw new SolanaTradeRefused("WOULD_FAIL", `The exchange would reject this right now, so nothing was signed and no fee was spent: ${why.slice(0, 200)}`);
        }
      } catch (error) {
        if (error instanceof SolanaTradeRefused) throw error;
        const why = error instanceof Error ? error.message : String(error);
        throw new SolanaTradeRefused("WOULD_FAIL", `Could not check this trade against the network, so it was not signed: ${why.split("\n")[0]}`);
      }
      const t2 = this.now();

      const signedBase64 = await this.deps.signer.signTransaction(wallet.walletId, transactionBase64);
      let signature = bs58.encode(VersionedTransaction.deserialize(Buffer.from(signedBase64, "base64")).signatures[0] ?? new Uint8Array(64));
      if (mode === "signAndSend") signature = await this.deps.rpc.sendRaw(signedBase64);
      const t3 = this.now();

      await io.onDone(decision, { signature, signedBase64 }, { checkMs: t1 - t0, simulateMs: t2 - t1, signMs: t3 - t2 }, { proceedsLamports });
      return { signature, signedBase64, decision, timings: { checkMs: t1 - t0, simulateMs: t2 - t1, signMs: t3 - t2, totalMs: this.now() - requestedAt } };
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
