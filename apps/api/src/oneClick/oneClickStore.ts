import type pg from "pg";

export type OneClickStatus = "pending" | "enabled" | "revoked";

export interface OneClickRecord {
  accountId: string;
  sessionWalletId: string;
  sessionWalletAddress: string;
  status: OneClickStatus;
  createdAt: Date;
  enabledAt: Date | null;
}

/** What a link is to: the account's Safe (one-click trading) or its trading wallet (the "float" wallet). */
export type LinkKind = "safe" | "float";

export interface LinkedSession {
  topic: string;
  accountId: string;
  kind: LinkKind;
  dappName: string | null;
  dappUrl: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface OneClickTrade {
  createdAt: Date;
  dappName: string | null;
  toAddress: string | null;
  valueWei: string | null;
  txHash: string | null;
  result: "SENT" | "REFUSED" | "ERROR";
  message: string | null;
}

/** Everything one-click trading keeps in Postgres (see supabase/migrations/0012_one_click_trading.sql). */
export class OneClickStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(accountId: string): Promise<OneClickRecord | undefined> {
    const { rows } = await this.pool.query("select * from evm_one_click where account_id = $1", [accountId]);
    const r = rows[0];
    return (
      r && {
        accountId: r.account_id,
        sessionWalletId: r.session_wallet_id,
        sessionWalletAddress: r.session_wallet_address,
        status: r.status,
        createdAt: r.created_at,
        enabledAt: r.enabled_at,
      }
    );
  }

  async createPending(accountId: string, walletId: string, walletAddress: string): Promise<void> {
    await this.pool.query(
      "insert into evm_one_click (account_id, session_wallet_id, session_wallet_address, status) values ($1, $2, $3, 'pending') on conflict (account_id) do nothing",
      [accountId, walletId, walletAddress],
    );
  }

  async setStatus(accountId: string, status: OneClickStatus): Promise<void> {
    await this.pool.query(
      "update evm_one_click set status = $2::text, enabled_at = case when $2::text = 'enabled' then now() else enabled_at end where account_id = $1",
      [accountId, status],
    );
  }

  async addSession(session: Omit<LinkedSession, "createdAt" | "kind"> & { kind?: LinkKind }): Promise<void> {
    await this.pool.query(
      "insert into evm_wc_sessions (topic, account_id, dapp_name, dapp_url, expires_at, kind) values ($1, $2, $3, $4, $5, $6) on conflict (topic) do update set expires_at = excluded.expires_at",
      [session.topic, session.accountId, session.dappName, session.dappUrl, session.expiresAt, session.kind ?? "safe"],
    );
  }

  async getSession(topic: string): Promise<LinkedSession | undefined> {
    const { rows } = await this.pool.query("select * from evm_wc_sessions where topic = $1", [topic]);
    return rows[0] && this.toSession(rows[0]);
  }

  async listSessions(accountId: string): Promise<LinkedSession[]> {
    const { rows } = await this.pool.query("select * from evm_wc_sessions where account_id = $1 order by created_at desc", [accountId]);
    return rows.map((r) => this.toSession(r));
  }

  async listAllSessionTopics(): Promise<string[]> {
    const { rows } = await this.pool.query("select topic from evm_wc_sessions");
    return rows.map((r) => r.topic as string);
  }

  async removeSession(topic: string): Promise<void> {
    await this.pool.query("delete from evm_wc_sessions where topic = $1", [topic]);
  }

  async recordTrade(trade: {
    accountId: string;
    dappName: string | null;
    toAddress: string | null;
    valueWei: string | null;
    txHash: string | null;
    result: "SENT" | "REFUSED" | "ERROR";
    message: string | null;
  }): Promise<void> {
    await this.pool.query(
      "insert into evm_one_click_trades (account_id, dapp_name, to_address, value_wei, tx_hash, result, message) values ($1, $2, $3, $4, $5, $6, $7)",
      [trade.accountId, trade.dappName, trade.toAddress, trade.valueWei, trade.txHash, trade.result, trade.message],
    );
  }

  async listTrades(accountId: string, limit: number): Promise<OneClickTrade[]> {
    const { rows } = await this.pool.query("select * from evm_one_click_trades where account_id = $1 order by created_at desc limit $2", [accountId, limit]);
    return rows.map((r) => ({
      createdAt: r.created_at,
      dappName: r.dapp_name,
      toAddress: r.to_address,
      valueWei: r.value_wei,
      txHash: r.tx_hash,
      result: r.result,
      message: r.message,
    }));
  }

  private toSession(r: any): LinkedSession {
    return { topic: r.topic, accountId: r.account_id, kind: r.kind ?? "safe", dappName: r.dapp_name, dappUrl: r.dapp_url, createdAt: r.created_at, expiresAt: r.expires_at };
  }
}
