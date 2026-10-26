import type pg from "pg";
import type { Address } from "viem";
import type { FloatLimits } from "@mypropguard/evm";

export type FloatStatus = "active" | "off";

export interface FloatWalletRow {
  accountId: string;
  walletId: string;
  address: Address;
  chainId: number;
  status: FloatStatus;
  /** The float the owner chose (wei of BNB). */
  floatWei: bigint;
  limits: FloatLimits;
  createdAt: Date;
}

export type FloatTradeKind = "buy" | "sell" | "approve" | "login" | "sweep" | "other";

export interface FloatTradeRecord {
  accountId: string;
  dappName: string | null;
  kind: FloatTradeKind;
  toAddress: string | null;
  tokenAddress: string | null;
  valueWei: bigint | null;
  txHash: string | null;
  result: "SENT" | "REFUSED" | "ERROR";
  code: string | null;
  message: string | null;
  timings?: { checkMs: number; estimateMs: number; sendMs: number; totalMs: number };
}

export interface FloatTradeView {
  createdAt: Date;
  dappName: string | null;
  kind: FloatTradeKind;
  toAddress: string | null;
  tokenAddress: string | null;
  valueWei: string | null;
  txHash: string | null;
  result: "SENT" | "REFUSED" | "ERROR";
  code: string | null;
  message: string | null;
  totalMs: number | null;
}

/** 00:00 UTC of the day containing `nowMs`: the day the daily limits are counted over. */
export function utcDayStart(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Everything the trading wallet keeps in Postgres (see supabase/migrations/0013_float_wallet.sql). */
export class FloatStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(accountId: string): Promise<FloatWalletRow | undefined> {
    const { rows } = await this.pool.query("select * from evm_float_wallets where account_id = $1", [accountId]);
    return rows[0] && this.toWallet(rows[0]);
  }

  /** The wallet whose address a linked site was given (used to answer eth_accounts). */
  async create(input: {
    accountId: string;
    walletId: string;
    address: string;
    chainId: number;
    floatWei: bigint;
    limits: Omit<FloatLimits, "frozen">;
  }): Promise<void> {
    await this.pool.query(
      `insert into evm_float_wallets
         (account_id, wallet_id, wallet_address, chain_id, float_wei, max_buy_wei, max_buys_per_day, daily_spend_wei, cooldown_sec)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (account_id) do nothing`,
      [
        input.accountId,
        input.walletId,
        input.address,
        input.chainId,
        input.floatWei.toString(),
        input.limits.maxBuyWei.toString(),
        input.limits.maxBuysPerDay,
        input.limits.dailySpendWei.toString(),
        input.limits.cooldownSec,
      ],
    );
  }

  /** Changes the owner's float and limits. Only the fields given change. */
  async updateSettings(
    accountId: string,
    patch: Partial<{ floatWei: bigint } & Omit<FloatLimits, "frozen">>,
  ): Promise<void> {
    await this.pool.query(
      `update evm_float_wallets set
         float_wei = coalesce($2::numeric, float_wei),
         max_buy_wei = coalesce($3::numeric, max_buy_wei),
         max_buys_per_day = coalesce($4::integer, max_buys_per_day),
         daily_spend_wei = coalesce($5::numeric, daily_spend_wei),
         cooldown_sec = coalesce($6::integer, cooldown_sec),
         updated_at = now()
       where account_id = $1`,
      [
        accountId,
        patch.floatWei?.toString() ?? null,
        patch.maxBuyWei?.toString() ?? null,
        patch.maxBuysPerDay ?? null,
        patch.dailySpendWei?.toString() ?? null,
        patch.cooldownSec ?? null,
      ],
    );
  }

  async setFrozen(accountId: string, frozen: boolean): Promise<void> {
    await this.pool.query("update evm_float_wallets set frozen = $2, updated_at = now() where account_id = $1", [accountId, frozen]);
  }

  async setStatus(accountId: string, status: FloatStatus): Promise<void> {
    await this.pool.query("update evm_float_wallets set status = $2, updated_at = now() where account_id = $1", [accountId, status]);
  }

  /** The day's buy count, BNB spent and last buy time, from the trade log. Only SENT buys count. */
  async usageToday(accountId: string, nowMs: number): Promise<{ buysToday: number; spentTodayWei: bigint; lastBuyAtSec: number | null }> {
    const { rows } = await this.pool.query(
      `select count(*)::int as buys,
              coalesce(sum(value_wei), 0)::text as spent,
              (extract(epoch from max(created_at)))::bigint::text as last_at
         from evm_float_trades
        where account_id = $1 and kind = 'buy' and result = 'SENT' and created_at >= $2`,
      [accountId, utcDayStart(nowMs)],
    );
    const r = rows[0] ?? {};
    return { buysToday: Number(r.buys ?? 0), spentTodayWei: BigInt(String(r.spent ?? "0").split(".")[0] || "0"), lastBuyAtSec: r.last_at ? Number(r.last_at) : null };
  }

  async recordTrade(t: FloatTradeRecord): Promise<void> {
    await this.pool.query(
      `insert into evm_float_trades
         (account_id, dapp_name, kind, to_address, token_address, value_wei, tx_hash, result, code, message, check_ms, estimate_ms, send_ms, total_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        t.accountId,
        t.dappName,
        t.kind,
        t.toAddress,
        t.tokenAddress,
        t.valueWei === null ? null : t.valueWei.toString(),
        t.txHash,
        t.result,
        t.code,
        t.message,
        t.timings?.checkMs ?? null,
        t.timings?.estimateMs ?? null,
        t.timings?.sendMs ?? null,
        t.timings?.totalMs ?? null,
      ],
    );
  }

  async listTrades(accountId: string, limit: number): Promise<FloatTradeView[]> {
    const { rows } = await this.pool.query("select * from evm_float_trades where account_id = $1 order by created_at desc, id desc limit $2", [accountId, limit]);
    return rows.map((r) => ({
      createdAt: r.created_at,
      dappName: r.dapp_name,
      kind: r.kind,
      toAddress: r.to_address,
      tokenAddress: r.token_address,
      valueWei: r.value_wei === null ? null : String(r.value_wei).split(".")[0]!,
      txHash: r.tx_hash,
      result: r.result,
      code: r.code,
      message: r.message,
      totalMs: r.total_ms,
    }));
  }

  /** Tokens this wallet has bought, sold or approved: the positions worth showing and sweeping. */
  async knownTokens(accountId: string): Promise<Address[]> {
    const { rows } = await this.pool.query(
      "select distinct token_address from evm_float_trades where account_id = $1 and token_address is not null and result = 'SENT'",
      [accountId],
    );
    return rows.map((r) => r.token_address as Address);
  }

  private toWallet(r: any): FloatWalletRow {
    const big = (v: unknown) => BigInt(String(v).split(".")[0]!);
    return {
      accountId: r.account_id,
      walletId: r.wallet_id,
      address: r.wallet_address,
      chainId: r.chain_id,
      status: r.status,
      floatWei: big(r.float_wei),
      limits: {
        maxBuyWei: big(r.max_buy_wei),
        maxBuysPerDay: r.max_buys_per_day,
        dailySpendWei: big(r.daily_spend_wei),
        cooldownSec: r.cooldown_sec,
        frozen: r.frozen,
      },
      createdAt: r.created_at,
    };
  }
}
