import type pg from "pg";
import { safeJsonParse, safeJsonStringify } from "@walletconnect/safe-json";

/**
 * WalletConnect's key-value storage on Postgres. By default it writes to a file on the server's disk, which a
 * redeploy wipes, and every linked exchange would have to be linked again after each deploy.
 */
export class PgWalletConnectStorage {
  constructor(private readonly pool: pg.Pool) {}

  async getKeys(): Promise<string[]> {
    const { rows } = await this.pool.query<{ key: string }>("select key from walletconnect_kv");
    return rows.map((row) => row.key);
  }

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const { rows } = await this.pool.query<{ key: string; value: string }>("select key, value from walletconnect_kv");
    return rows.map((row) => [row.key, safeJsonParse(row.value) as T]);
  }

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    const { rows } = await this.pool.query<{ value: string }>("select value from walletconnect_kv where key = $1", [key]);
    return rows[0] ? (safeJsonParse(rows[0].value) as T) : undefined;
  }

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    await this.pool.query(
      "insert into walletconnect_kv (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()",
      [key, safeJsonStringify(value)],
    );
  }

  async removeItem(key: string): Promise<void> {
    await this.pool.query("delete from walletconnect_kv where key = $1", [key]);
  }
}
