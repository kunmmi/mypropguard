import { randomUUID } from "node:crypto";
import type pg from "pg";

/** The key of the lease row. WalletConnect's own storage never sees keys with this prefix (see PgWalletConnectStorage). */
export const LEASE_KEY = "mypropguard:walletconnect-lease";

export interface LeaseStore {
  /** Takes the lease, or renews it if this owner already holds it. True when this owner holds it afterwards. */
  tryAcquire(owner: string, nowMs: number, ttlMs: number): Promise<boolean>;
  release(owner: string): Promise<void>;
}

/**
 * The lease on Postgres. Plain SQL on one row, so it also works behind a connection pooler (a session-level advisory
 * lock does not). The row says who holds it and until when. A lease that was not renewed in time is up for grabs, which
 * is what frees it when a server is killed without getting to say goodbye.
 */
export class PgLeaseStore implements LeaseStore {
  constructor(private readonly pool: pg.Pool) {}

  async tryAcquire(owner: string, nowMs: number, ttlMs: number): Promise<boolean> {
    const { rows } = await this.pool.query(
      `insert into walletconnect_kv (key, value, updated_at)
       values ($1, $2, now())
       on conflict (key) do update
         set value = excluded.value, updated_at = now()
         where (walletconnect_kv.value::jsonb ->> 'owner') = $3
            or (walletconnect_kv.value::jsonb ->> 'expiresAt')::bigint < $4::bigint
       returning key`,
      [LEASE_KEY, JSON.stringify({ owner, expiresAt: nowMs + ttlMs }), owner, nowMs],
    );
    return rows.length === 1;
  }

  async release(owner: string): Promise<void> {
    await this.pool.query(
      `update walletconnect_kv set value = $2, updated_at = now()
       where key = $1 and (value::jsonb ->> 'owner') = $3`,
      [LEASE_KEY, JSON.stringify({ owner, expiresAt: 0 }), owner],
    );
  }
}

export interface LeaseOptions {
  ttlMs?: number;
  /** How often to look for the lease while waiting for it, and to renew it once held. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /**
   * Called once if this copy stops holding the lease after it had it: another copy took it, or the database could not
   * be reached for a whole time-to-live (after which this copy can no longer show that it still owns the connection).
   * The caller must stop using WalletConnect. The lease is not reclaimed afterwards: a copy that stood down stays down.
   */
  onLost?: () => void | Promise<void>;
}

/**
 * Makes sure only one copy of the server owns the WalletConnect connection at a time.
 *
 * A host that deploys without downtime runs the old and the new copy side by side for a while. Two copies sharing one
 * WalletConnect identity and one set of saved state overwrite each other, and the links that survive are broken. So the
 * new copy waits here until the old one has let go (it releases the lease when told to stop, or its lease runs out
 * if it was killed), and only then loads the saved state and connects.
 */
export class WalletConnectLease {
  readonly owner = randomUUID();
  private readonly ttlMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly onLost: (() => void | Promise<void>) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private held = false;
  /** When the lease was last confirmed as ours. Only a successful acquire or renewal moves it. */
  private lastConfirmedAt = 0;

  constructor(
    private readonly store: LeaseStore,
    options: LeaseOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.pollMs = options.pollMs ?? 3_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => undefined);
    this.onLost = options.onLost;
  }

  /** Resolves once this copy holds the lease, and keeps renewing it in the background from then on. */
  async acquire(): Promise<void> {
    let waitedLogged = false;
    for (;;) {
      if (await this.store.tryAcquire(this.owner, this.now(), this.ttlMs)) break;
      if (!waitedLogged) {
        this.log("another copy of the server owns the WalletConnect connection; waiting for it to let go");
        waitedLogged = true;
      }
      await this.sleep(this.pollMs);
    }
    this.held = true;
    this.lastConfirmedAt = this.now();
    this.timer = setInterval(() => void this.renew(), this.pollMs * 3);
    this.timer.unref?.();
    this.log("this copy of the server now owns the WalletConnect connection");
  }

  /**
   * Renews the lease. Runs on a timer once the lease is held; public so a test can drive it without waiting.
   *
   * Two ways to lose the lease, and both mean this copy must stop using WalletConnect:
   *  - another copy now owns it (the database says so);
   *  - the database has not confirmed it for a whole time-to-live. By then another copy is allowed to take it, and this
   *    copy cannot tell whether it has. Carrying on would risk two copies on one identity, so it stands down.
   */
  async renew(): Promise<void> {
    if (!this.held) return;
    try {
      if (await this.store.tryAcquire(this.owner, this.now(), this.ttlMs)) {
        this.lastConfirmedAt = this.now();
        return;
      }
      await this.lose("LOST the WalletConnect lease to another copy of the server");
    } catch (error) {
      const silentMs = this.now() - this.lastConfirmedAt;
      this.log(`could not renew the WalletConnect lease: ${error instanceof Error ? error.message : error}`);
      if (silentMs >= this.ttlMs) {
        await this.lose(`could not confirm the WalletConnect lease for ${Math.round(silentMs / 1000)}s, so another copy may own it now`);
      }
    }
  }

  private async lose(reason: string): Promise<void> {
    if (!this.held) return;
    this.held = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log(`${reason}; this copy is standing down from WalletConnect`);
    try {
      await this.onLost?.();
    } catch (error) {
      this.log(`standing down failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  isHeld(): boolean {
    return this.held;
  }

  /** Lets go at once so the next copy does not have to wait for the lease to run out. */
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.held = false;
    try {
      await this.store.release(this.owner);
    } catch {
      // The lease runs out by itself within its time-to-live.
    }
  }
}

/**
 * What a server does when told to stop: close the WalletConnect connection FIRST, and only then let go of the lease.
 *
 * The order is the point. The lease is what keeps two copies from sharing one WalletConnect identity, and the new
 * copy takes it on its very next check. If the lease were released while this copy's relay connection was still
 * open, the new copy could connect while this one still held the relay: two clients on one identity, the exact
 * situation the lease exists to prevent. Releasing last means the new copy can never overlap with an open connection.
 *
 * The lease is released even if closing the connection fails, so a hiccup there can never leave the next copy
 * waiting out the whole time-to-live.
 */
export async function handOver(
  closeConnection: () => Promise<void> | undefined,
  lease: Pick<WalletConnectLease, "release">,
): Promise<void> {
  try {
    await closeConnection();
  } catch {
    // Already closed, or the relay is unreachable: either way there is nothing more to close.
  } finally {
    await lease.release();
  }
}
