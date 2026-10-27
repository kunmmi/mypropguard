import type pg from "pg";

export type SolanaStatus = "active" | "off";

export interface SolanaWalletRow {
  accountId: string;
  walletId: string;
  address: string;
  status: SolanaStatus;
  /** One buy may use at most this share (percent) of the SOL in the wallet. */
  maxBuyPct: number;
  /** A day's buys may use at most this share (percent) of the SOL the wallet started the day with. */
  dailySpendPct: number;
  maxBuysPerDay: number;
  cooldownSec: number;
  frozen: boolean;
  /** The one address withdrawals go to, or null until the owner sets it. */
  withdrawalAddress: string | null;
  createdAt: Date;
}

export const DEFAULT_SOLANA_MAX_BUY_PCT = 25;
export const DEFAULT_SOLANA_DAILY_SPEND_PCT = 50;
export const DEFAULT_SOLANA_MAX_BUYS_PER_DAY = 10;

export type SolanaRequestKind = "login" | "transaction" | "sweep" | "other";

export interface SolanaRequestRecord {
  accountId: string;
  dappName: string | null;
  kind: SolanaRequestKind;
  method: string;
  result: "SIGNED" | "REFUSED" | "ERROR";
  code?: string | null;
  message?: string | null;
  /** What was asked, readable: the login text, or a decoded transaction. */
  detail?: unknown;
  tradeKind?: "buy" | "sell" | null;
  mint?: string | null;
  /** For a buy: the most SOL it could cost, in lamports. */
  lamports?: bigint | null;
  /** For a sale or a coin handed back: what it returned in lamports (an estimate from the quote taken just before). */
  proceedsLamports?: bigint | null;
  signature?: string | null;
  timings?: { checkMs: number; simulateMs: number; signMs: number; totalMs: number };
}

export interface SolanaRequestView {
  createdAt: Date;
  dappName: string | null;
  kind: SolanaRequestKind;
  method: string;
  result: "SIGNED" | "REFUSED" | "ERROR";
  code: string | null;
  message: string | null;
  detail: unknown;
  tradeKind: "buy" | "sell" | null;
  mint: string | null;
  lamports: string | null;
  signature: string | null;
  totalMs: number | null;
}

/** 00:00 UTC of the day containing `nowMs`: the day the daily limits are counted over. */
export function solanaDayStart(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const big = (v: unknown): bigint => BigInt(String(v ?? "0").split(".")[0] || "0");

/** Everything the Solana wallet keeps in Postgres (see supabase/migrations/0014 and 0015). */
export class SolanaStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(accountId: string): Promise<SolanaWalletRow | undefined> {
    const { rows } = await this.pool.query("select * from sol_wallets where account_id = $1", [accountId]);
    return rows[0] && this.toWallet(rows[0]);
  }

  async create(input: { accountId: string; walletId: string; address: string }): Promise<void> {
    await this.pool.query(
      "insert into sol_wallets (account_id, wallet_id, wallet_address) values ($1, $2, $3) on conflict (account_id) do nothing",
      [input.accountId, input.walletId, input.address],
    );
  }

  async setStatus(accountId: string, status: SolanaStatus): Promise<void> {
    await this.pool.query("update sol_wallets set status = $2, updated_at = now() where account_id = $1", [accountId, status]);
  }

  async setFrozen(accountId: string, frozen: boolean): Promise<void> {
    await this.pool.query("update sol_wallets set frozen = $2, updated_at = now() where account_id = $1", [accountId, frozen]);
  }

  /** Changes the owner's limits. Only the fields given change. */
  async updateSettings(accountId: string, patch: Partial<{ maxBuyPct: number; dailySpendPct: number; maxBuysPerDay: number; cooldownSec: number }>): Promise<void> {
    await this.pool.query(
      `update sol_wallets set
         max_buy_pct = coalesce($2::integer, max_buy_pct),
         daily_spend_pct = coalesce($3::integer, daily_spend_pct),
         max_buys_per_day = coalesce($4::integer, max_buys_per_day),
         cooldown_sec = coalesce($5::integer, cooldown_sec),
         updated_at = now()
       where account_id = $1`,
      [accountId, patch.maxBuyPct ?? null, patch.dailySpendPct ?? null, patch.maxBuysPerDay ?? null, patch.cooldownSec ?? null],
    );
  }

  async setWithdrawalAddress(accountId: string, address: string): Promise<void> {
    await this.pool.query("update sol_wallets set withdrawal_address = $2, updated_at = now() where account_id = $1", [accountId, address]);
  }

  async recordRequest(r: SolanaRequestRecord): Promise<void> {
    await this.pool.query(
      `insert into sol_requests
         (account_id, dapp_name, kind, method, result, code, message, detail, trade_kind, mint, lamports, proceeds_lamports, signature, check_ms, simulate_ms, sign_ms, total_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        r.accountId,
        r.dappName,
        r.kind,
        r.method,
        r.result,
        r.code ?? null,
        r.message ?? null,
        r.detail === undefined ? null : JSON.stringify(r.detail),
        r.tradeKind ?? null,
        r.mint ?? null,
        r.lamports === null || r.lamports === undefined ? null : r.lamports.toString(),
        r.proceedsLamports === null || r.proceedsLamports === undefined ? null : r.proceedsLamports.toString(),
        r.signature ?? null,
        r.timings?.checkMs ?? null,
        r.timings?.simulateMs ?? null,
        r.timings?.signMs ?? null,
        r.timings?.totalMs ?? null,
      ],
    );
  }

  async listRequests(accountId: string, limit: number): Promise<SolanaRequestView[]> {
    const { rows } = await this.pool.query("select * from sol_requests where account_id = $1 order by created_at desc, id desc limit $2", [accountId, limit]);
    return rows.map((r) => ({
      createdAt: r.created_at,
      dappName: r.dapp_name,
      kind: r.kind,
      method: r.method,
      result: r.result,
      code: r.code,
      message: r.message,
      detail: r.detail ?? null,
      tradeKind: r.trade_kind ?? null,
      mint: r.mint ?? null,
      lamports: r.lamports === null || r.lamports === undefined ? null : String(r.lamports).split(".")[0]!,
      signature: r.signature ?? null,
      totalMs: r.total_ms ?? null,
    }));
  }

  /** The day's buy count, SOL committed and last buy time, from the log. Only buys that were signed count. */
  async usageToday(accountId: string, nowMs: number): Promise<{ buysToday: number; spentTodayLamports: bigint; lastBuyAtSec: number | null }> {
    const { rows } = await this.pool.query(
      `select count(*)::int as buys,
              coalesce(sum(lamports), 0)::text as spent,
              (extract(epoch from max(created_at)))::bigint::text as last_at
         from sol_requests
        where account_id = $1 and trade_kind = 'buy' and result = 'SIGNED' and created_at >= $2`,
      [accountId, solanaDayStart(nowMs)],
    );
    const r = rows[0] ?? {};
    return { buysToday: Number(r.buys ?? 0), spentTodayLamports: big(r.spent), lastBuyAtSec: r.last_at ? Number(r.last_at) : null };
  }

  /** Coins this wallet has bought or sold: the positions worth showing, valuing and withdrawing. */
  async knownMints(accountId: string): Promise<string[]> {
    const { rows } = await this.pool.query("select distinct mint from sol_requests where account_id = $1 and mint is not null and result = 'SIGNED'", [accountId]);
    return rows.map((r) => r.mint as string);
  }

  /** Per coin: what its buys cost and what its sales (and coins handed back) returned. */
  async mintFlows(accountId: string): Promise<Array<{ mint: string; costLamports: bigint; proceedsLamports: bigint }>> {
    const { rows } = await this.pool.query(
      `select mint,
              coalesce(sum(case when trade_kind = 'buy' then lamports end), 0)::text as cost,
              coalesce(sum(case when trade_kind = 'sell' or kind = 'sweep' then proceeds_lamports end), 0)::text as proceeds
         from sol_requests
        where account_id = $1 and mint is not null and result = 'SIGNED'
        group by mint`,
      [accountId],
    );
    return rows.map((r) => ({ mint: r.mint as string, costLamports: big(r.cost), proceedsLamports: big(r.proceeds) }));
  }

  async getRiskState(accountId: string): Promise<{ day: string | null; dayStartPnlLamports: bigint; peakEquityLamports: bigint }> {
    const { rows } = await this.pool.query("select to_char(day, 'YYYY-MM-DD') as day, day_start_pnl_lamports::text as p, peak_equity_lamports::text as e from sol_risk where account_id = $1", [accountId]);
    const r = rows[0];
    return r ? { day: r.day ?? null, dayStartPnlLamports: big(r.p), peakEquityLamports: big(r.e) } : { day: null, dayStartPnlLamports: 0n, peakEquityLamports: 0n };
  }

  async saveRiskState(accountId: string, state: { day: string; dayStartPnlLamports: bigint; peakEquityLamports: bigint }): Promise<void> {
    await this.pool.query(
      `insert into sol_risk (account_id, day, day_start_pnl_lamports, peak_equity_lamports) values ($1, $2, $3, $4)
       on conflict (account_id) do update set day = excluded.day, day_start_pnl_lamports = excluded.day_start_pnl_lamports, peak_equity_lamports = excluded.peak_equity_lamports, updated_at = now()`,
      [accountId, state.day, state.dayStartPnlLamports.toString(), state.peakEquityLamports.toString()],
    );
  }

  /** Forgets the wallet's high-water mark, e.g. after the owner took money out, so a withdrawal is not read as a loss. */
  async resetPeak(accountId: string): Promise<void> {
    await this.pool.query("update sol_risk set peak_equity_lamports = 0, updated_at = now() where account_id = $1", [accountId]);
  }

  private toWallet(r: any): SolanaWalletRow {
    return {
      accountId: r.account_id,
      walletId: r.wallet_id,
      address: r.wallet_address,
      status: r.status,
      maxBuyPct: r.max_buy_pct,
      dailySpendPct: r.daily_spend_pct,
      maxBuysPerDay: r.max_buys_per_day,
      cooldownSec: r.cooldown_sec,
      frozen: r.frozen,
      withdrawalAddress: r.withdrawal_address ?? null,
      createdAt: r.created_at,
    };
  }
}
