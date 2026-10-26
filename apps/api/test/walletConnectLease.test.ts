import { describe, expect, it } from "vitest";
import { WalletConnectLease, handOver, type LeaseStore } from "../src/oneClick/walletConnectLease.js";

/** The same rule as the SQL: the row can be taken by its owner, or by anyone once it has run out. */
function memoryStore() {
  let row: { owner: string; expiresAt: number } | undefined;
  const store: LeaseStore = {
    async tryAcquire(owner, nowMs, ttlMs) {
      if (!row || row.owner === owner || row.expiresAt < nowMs) {
        row = { owner, expiresAt: nowMs + ttlMs };
        return true;
      }
      return false;
    },
    async release(owner) {
      if (row?.owner === owner) row = { owner, expiresAt: 0 };
    },
  };
  return store;
}

function clock() {
  let now = 1_000_000;
  const waiters: Array<() => void> = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      waiters.splice(0).forEach((wake) => wake());
    },
    // A sleep that only ends when the test moves the clock, so waiting copies stay waiting.
    sleep: () => new Promise<void>((resolve) => waiters.push(resolve)),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("WalletConnectLease", () => {
  it("is taken at once when nobody holds it", async () => {
    const c = clock();
    const lease = new WalletConnectLease(memoryStore(), { now: c.now, sleep: c.sleep });
    await lease.acquire();
    expect(lease.isHeld()).toBe(true);
    await lease.release();
  });

  it("makes a second copy wait while the first holds it, and hands over the moment the first lets go", async () => {
    const c = clock();
    const store = memoryStore();
    const messages: string[] = [];
    const oldCopy = new WalletConnectLease(store, { now: c.now, sleep: c.sleep });
    const newCopy = new WalletConnectLease(store, { now: c.now, sleep: c.sleep, log: (m) => messages.push(m) });
    await oldCopy.acquire();

    let newHasIt = false;
    void newCopy.acquire().then(() => (newHasIt = true));
    await settle();
    expect(newHasIt).toBe(false);
    expect(messages[0]).toContain("waiting");

    c.advance(3_000);
    await settle();
    expect(newHasIt).toBe(false); // still held by the old copy

    await oldCopy.release();
    c.advance(3_000);
    await settle();
    expect(newHasIt).toBe(true);
    expect(newCopy.isHeld()).toBe(true);
    await newCopy.release();
  });

  it("frees a lease whose owner was killed without releasing it, once its time runs out", async () => {
    const c = clock();
    const store = memoryStore();
    const killed = new WalletConnectLease(store, { now: c.now, sleep: c.sleep, ttlMs: 30_000 });
    await killed.acquire(); // ...and then the process disappears

    const next = new WalletConnectLease(store, { now: c.now, sleep: c.sleep, ttlMs: 30_000 });
    let nextHasIt = false;
    void next.acquire().then(() => (nextHasIt = true));
    await settle();

    c.advance(20_000);
    await settle();
    expect(nextHasIt).toBe(false); // not yet out of time

    c.advance(11_000);
    await settle();
    expect(nextHasIt).toBe(true);
    await next.release();
  });

  it("two copies never both hold it", async () => {
    const c = clock();
    const store = memoryStore();
    const a = new WalletConnectLease(store, { now: c.now, sleep: c.sleep });
    const b = new WalletConnectLease(store, { now: c.now, sleep: c.sleep });
    await a.acquire();
    const second = b.acquire();
    c.advance(3_000);
    await settle();
    expect(a.isHeld() && b.isHeld()).toBe(false);
    await a.release();
    c.advance(3_000);
    await second;
    expect(b.isHeld()).toBe(true);
    expect(a.isHeld()).toBe(false);
    await b.release();
  });
});

describe("handOver — closing order on shutdown", () => {
  const recorder = () => {
    const calls: string[] = [];
    return { calls, lease: { release: async () => void calls.push("release lease") } };
  };

  it("closes the WalletConnect connection BEFORE it lets go of the lease", async () => {
    const { calls, lease } = recorder();
    await handOver(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20)); // closing takes a moment
      calls.push("close connection");
    }, lease);
    expect(calls).toEqual(["close connection", "release lease"]);
  });

  it("still releases the lease when closing the connection fails", async () => {
    const { calls, lease } = recorder();
    await handOver(async () => {
      throw new Error("relay unreachable");
    }, lease);
    expect(calls).toEqual(["release lease"]);
  });

  it("still releases the lease when the service never finished starting (nothing to close)", async () => {
    const { calls, lease } = recorder();
    await handOver(() => undefined, lease);
    expect(calls).toEqual(["release lease"]);
  });
});

describe("WalletConnectLease — standing down", () => {
  /** A store whose answers the test controls, with a call log. */
  function scripted() {
    const calls: string[] = [];
    let mode: "ours" | "taken" | "down" = "ours";
    const store: LeaseStore = {
      async tryAcquire(owner) {
        calls.push(`tryAcquire:${owner.slice(0, 4)}`);
        if (mode === "down") throw new Error("connection refused");
        return mode === "ours";
      },
      async release() {},
    };
    return { store, calls, set: (m: typeof mode) => (mode = m) };
  }
  const opts = (c: ReturnType<typeof clock>, onLost: () => void, log: string[] = []) => ({
    ttlMs: 30_000,
    pollMs: 1_000_000, // no background timer ticks; the test drives renew() itself
    now: c.now,
    sleep: c.sleep,
    log: (m: string) => log.push(m),
    onLost,
  });

  it("stands down when another copy has taken the lease: onLost fires once, and it stops renewing", async () => {
    const c = clock();
    const s = scripted();
    let lost = 0;
    const lease = new WalletConnectLease(s.store, opts(c, () => void lost++));
    await lease.acquire();
    s.set("taken");
    await lease.renew();
    expect(lost).toBe(1);
    expect(lease.isHeld()).toBe(false);
    const before = s.calls.length;
    await lease.renew(); // a copy that stood down must not fight for the lease again
    await lease.renew();
    expect(s.calls.length).toBe(before);
    expect(lost).toBe(1);
  });

  it("rides out a short database outage: still held, and nothing is shut down", async () => {
    const c = clock();
    const s = scripted();
    let lost = 0;
    const lease = new WalletConnectLease(s.store, opts(c, () => void lost++));
    await lease.acquire();
    s.set("down");
    c.advance(10_000);
    await lease.renew();
    c.advance(10_000);
    await lease.renew(); // 20s of silence, ttl is 30s: nobody else can have the lease yet
    expect(lease.isHeld()).toBe(true);
    expect(lost).toBe(0);
  });

  it("stands down once the database has been silent for a whole time-to-live", async () => {
    const c = clock();
    const s = scripted();
    const log: string[] = [];
    let lost = 0;
    const lease = new WalletConnectLease(s.store, opts(c, () => void lost++, log));
    await lease.acquire();
    s.set("down");
    c.advance(30_000);
    await lease.renew();
    expect(lease.isHeld()).toBe(false);
    expect(lost).toBe(1);
    expect(log.some((m) => m.includes("another copy may own it now"))).toBe(true);
  });

  it("a successful renewal restarts the silence clock, so a flaky database does not add up", async () => {
    const c = clock();
    const s = scripted();
    let lost = 0;
    const lease = new WalletConnectLease(s.store, opts(c, () => void lost++));
    await lease.acquire();
    for (let round = 0; round < 4; round++) {
      s.set("down");
      c.advance(20_000);
      await lease.renew(); // 20s down...
      s.set("ours");
      c.advance(5_000);
      await lease.renew(); // ...then confirmed again: the clock restarts
    }
    expect(lease.isHeld()).toBe(true);
    expect(lost).toBe(0);
  });

  it("a failing onLost is logged and does not throw out of the timer", async () => {
    const c = clock();
    const s = scripted();
    const log: string[] = [];
    const lease = new WalletConnectLease(s.store, opts(c, () => { throw new Error("stop failed"); }, log));
    await lease.acquire();
    s.set("taken");
    await expect(lease.renew()).resolves.toBeUndefined();
    expect(log.some((m) => m.includes("standing down failed: stop failed"))).toBe(true);
  });
});
