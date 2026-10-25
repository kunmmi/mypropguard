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
