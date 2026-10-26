import type pg from "pg";

export type SolanaStatus = "active" | "off";

export interface SolanaWalletRow {
  accountId: string;
  walletId: string;
  address: string;
  status: SolanaStatus;
  createdAt: Date;
}

export type SolanaRequestKind = "login" | "transaction" | "other";

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
}

/** Everything the Solana wallet keeps in Postgres (see supabase/migrations/0014_solana_wallet.sql). */
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

  async recordRequest(r: SolanaRequestRecord): Promise<void> {
    await this.pool.query(
      "insert into sol_requests (account_id, dapp_name, kind, method, result, code, message, detail) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [r.accountId, r.dappName, r.kind, r.method, r.result, r.code ?? null, r.message ?? null, r.detail === undefined ? null : JSON.stringify(r.detail)],
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
    }));
  }

  private toWallet(r: any): SolanaWalletRow {
    return { accountId: r.account_id, walletId: r.wallet_id, address: r.wallet_address, status: r.status, createdAt: r.created_at };
  }
}
