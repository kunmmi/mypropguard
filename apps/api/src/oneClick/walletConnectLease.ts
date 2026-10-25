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
  private timer: NodeJS.Timeout | undefined;
  private held = false;

  constructor(
    private readonly store: LeaseStore,
    options: LeaseOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30_000;
    this.pollMs = options.pollMs ?? 3_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => undefined);
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
    this.timer = setInterval(() => void this.renew(), this.pollMs * 3);
    this.timer.unref?.();
    this.log("this copy of the server now owns the WalletConnect connection");
  }

  private async renew(): Promise<void> {
    try {
      if (!(await this.store.tryAcquire(this.owner, this.now(), this.ttlMs))) {
        this.log("LOST the WalletConnect lease to another copy of the server");
        this.held = false;
      }
    } catch (error) {
      this.log(`could not renew the WalletConnect lease: ${error instanceof Error ? error.message : error}`);
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
