import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  RuleType,
  type ClearinghouseState,
  type ProtectedAccount,
  type VenueCapitalFlow,
  type VenueEnforcer,
  type VenueOpenOrder,
  type VenueStateReader,
} from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { WatcherMemory, runWatcherCycle, watchAllHyperliquidAccounts, type WatcherDeps, type WatcherMode } from "../src/watcher.js";

const D = (n: number | string) => new Decimal(n);
const T0 = Date.parse("2026-10-07T10:00:00Z");

function account(overrides: Partial<ProtectedAccount> = {}): ProtectedAccount {
  return {
    accountId: "acct_hl",
    ownerUserId: "owner_1",
    venue: "hyperliquid",
    protectionEnabled: true,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    agentWalletId: "wallet_1",
    agentWalletAddress: "0xAGENT",
    evmOwnerWalletAddress: null,
    evmSafeAddress: null,
    evmChainId: null,
    venueAddress: "0xTRADER",
    ...overrides,
  };
}

class FakeVenue implements VenueStateReader {
  accountValue = 1000;
  positions: Array<{ coin: string; size: number; value: number }> = [];
  orders: VenueOpenOrder[] = [];
  flows: VenueCapitalFlow[] = [];
  nowMs = T0;
  failState: Error | null = null;
  stateReads = 0;
  /** Runs in the middle of a check, after the saved state was read and before the result is saved. */
  beforeStateRead: (() => Promise<void>) | null = null;

  async getClearinghouseState(): Promise<ClearinghouseState> {
    this.stateReads++;
    await this.beforeStateRead?.();
    if (this.failState) throw this.failState;
    return {
      accountValue: D(this.accountValue),
      totalMarginUsed: D(0),
      totalNotionalPosition: this.positions.reduce((s, p) => s.plus(Math.abs(p.value)), D(0)),
      withdrawable: D(this.accountValue),
      positions: this.positions.map((p) => ({ coin: p.coin, size: D(p.size), positionValue: D(Math.abs(p.value)), leverage: D(1) })),
      time: this.nowMs,
    };
  }
  async getOpenOrders() {
    return this.orders;
  }
  async getCapitalFlows(_address: string, afterMs: number) {
    return this.flows.filter((f) => f.timeMs > afterMs);
  }
}

class FakeEnforcer implements VenueEnforcer {
  cancels: Array<{ coin: string; oid: number }> = [];
  closes: Array<{ coin: string; isBuy: boolean; size: string }> = [];
  failWith: Error | null = null;
  async cancelOrder(coin: string, oid: number) {
    if (this.failWith) throw this.failWith;
    this.cancels.push({ coin, oid });
  }
  async reduceOnlyClose(input: { coin: string; isBuy: boolean; size: Decimal }) {
    if (this.failWith) throw this.failWith;
    this.closes.push({ coin: input.coin, isBuy: input.isBuy, size: input.size.toString() });
    return { detail: "filled" };
  }
}

function setup(opts: { mode?: WatcherMode; rules?: Array<[RuleType, number]>; hasAgent?: boolean; address?: string | null } = {}) {
  const store = new InMemoryRiskLedgerStore();
  store.seedAccount(account({ venueAddress: opts.address === undefined ? "0xTRADER" : opts.address, agentWalletId: opts.hasAgent === false ? null : "wallet_1" }));
  store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_hl", equityStartOfDay: D(10_000), currentEquity: D(10_000), peakEquity: D(10_000) }));
  store.seedRules(
    "acct_hl",
    (opts.rules ?? [[RuleType.MAX_DAILY_LOSS, 100]]).map(([type, limit], i) => buildRuleVersion(type, limit, { accountId: "acct_hl", id: `r${i}` })),
  );
  const venue = new FakeVenue();
  const enforcer = new FakeEnforcer();
  let nowMs = T0;
  const deps: WatcherDeps = {
    store,
    venueReader: venue,
    enforcerFor: (a) => (a.agentWalletId ? enforcer : undefined),
    mode: opts.mode ?? "enforce",
    now: () => new Date(nowMs),
    memory: new WatcherMemory(),
  };
  const tick = async (advanceMs = 5_000) => {
    nowMs += advanceMs;
    venue.nowMs = nowMs;
    return runWatcherCycle(deps, "acct_hl");
  };
  const head = () => store.runExclusive("acct_hl", (ctx) => ctx.getAccountRiskHead("acct_hl"));
  const actions = () => store.enforcementActions;
  return { store, venue, enforcer, deps, tick, head, actions, setNow: (ms: number) => (nowMs = ms) };
}

describe("runWatcherCycle - what it skips", () => {
  it("skips an account with no Hyperliquid address saved", async () => {
    const { tick } = setup({ address: null });
    expect((await tick()).skipped).toContain("no Hyperliquid address");
  });

  it("skips an account with no watched rules", async () => {
    const { tick } = setup({ rules: [[RuleType.COOLDOWN, 60]] });
    expect((await tick()).skipped).toContain("no watched rules");
  });
});

describe("runWatcherCycle - a daily-loss lock", () => {
  it("does nothing while no rule is broken, and remembers the positions", async () => {
    const { venue, tick, head, enforcer } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    const r = await tick();
    expect(r.locked).toBe(false);
    expect(enforcer.closes).toEqual([]);
    expect((await head()).enforcement?.lastCompliant?.positions.BTC?.toString()).toBe("0.5");
  });

  it("locks when the loss reaches the limit, leaves the open position alone, and records why", async () => {
    const { venue, tick, enforcer, actions, head } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick(); // baseline 1000
    venue.accountValue = 850; // lost 150, limit 100
    const r = await tick();

    expect(r.locked).toBe(true);
    expect(r.newLock?.rule).toBe(RuleType.MAX_DAILY_LOSS);
    expect(enforcer.closes).toEqual([]); // the existing position is NOT closed
    expect(enforcer.cancels).toEqual([]);
    expect(actions().some((a) => a.kind === "LOCK" && a.detail.rule === RuleType.MAX_DAILY_LOSS)).toBe(true);
    expect((await head()).enforcement?.lockedDay).toBe("2026-10-07");
  });

  it("does NOT lock when the drop is a withdrawal: it re-reads the ledger before deciding", async () => {
    const { venue, tick, enforcer, head } = setup();
    await tick(); // baseline 1000
    venue.accountValue = 600; // looks like a $400 loss...
    venue.flows = [{ id: "0xw", timeMs: T0 + 6_000, amountUsd: D(-400) }]; // ...but it was a withdrawal
    const r = await tick();
    expect(r.locked).toBe(false);
    expect(enforcer.closes).toEqual([]);
    expect((await head()).enforcement?.lockedDay).toBeNull();
  });

  it("closes a NEW position the trader opens after the lock, in full", async () => {
    const { venue, tick, enforcer, actions } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick();
    venue.accountValue = 850;
    await tick(); // locks

    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }, { coin: "ETH", size: -4, value: 12_000 }];
    const r = await tick();
    expect(r.executed).toBe(1);
    expect(enforcer.closes).toEqual([{ coin: "ETH", isBuy: true, size: "4" }]); // short 4 -> buy 4 back
    expect(actions().some((a) => a.kind === "TRIM" && a.result === "DONE" && a.coin === "ETH")).toBe(true);
  });

  it("closes only the part added to an existing position", async () => {
    const { venue, tick, enforcer } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick();
    venue.accountValue = 850;
    await tick();
    venue.positions = [{ coin: "BTC", size: 0.8, value: 48_000 }];
    await tick();
    expect(enforcer.closes).toHaveLength(1);
    expect(enforcer.closes[0]).toMatchObject({ coin: "BTC", isBuy: false });
    expect(Number(enforcer.closes[0]!.size)).toBeCloseTo(0.3, 6);
  });

  it("cancels a resting order that would add exposure, and leaves a normal exit alone", async () => {
    const { venue, tick, enforcer } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick();
    venue.accountValue = 850;
    await tick();
    venue.orders = [
      { coin: "BTC", oid: 11, isBuy: true, size: D("0.1"), reduceOnly: false }, // adds
      { coin: "BTC", oid: 12, isBuy: false, size: D("0.2"), reduceOnly: false }, // exit
    ];
    await tick();
    expect(enforcer.cancels).toEqual([{ coin: "BTC", oid: 11 }]);
  });

  it("cancels resting orders on the very cycle the lock is created, not a cycle later", async () => {
    const { venue, tick, enforcer } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick();
    venue.accountValue = 850;
    venue.orders = [{ coin: "ETH", oid: 21, isBuy: true, size: D(2), reduceOnly: false }];
    const r = await tick();
    expect(r.newLock).toBeDefined();
    expect(enforcer.cancels).toEqual([{ coin: "ETH", oid: 21 }]);
  });

  it("lifts the lock at the next UTC day, and the new day's trades are free", async () => {
    const { venue, tick, enforcer, head, setNow } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick();
    venue.accountValue = 850;
    await tick();
    expect((await head()).enforcement?.lockedDay).toBe("2026-10-07");

    setNow(Date.parse("2026-10-08T00:10:00Z"));
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }, { coin: "SOL", size: 100, value: 14_000 }];
    const r = await tick(1000);
    expect(r.unlocked).toBe(true);
    expect(r.locked).toBe(false);
    expect(enforcer.closes).toEqual([]);
  });
});

describe("runWatcherCycle - closing the trade that breaks the rule", () => {
  it("trims a position the moment it pushes total exposure past the limit", async () => {
    const { venue, tick, enforcer } = setup({ rules: [[RuleType.MAX_EXPOSURE, 40_000]] });
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick(); // fine, remembered as compliant
    venue.positions = [{ coin: "BTC", size: 0.8, value: 48_000 }]; // the breaching trade
    const r = await tick();
    expect(r.newLock?.rule).toBe(RuleType.MAX_EXPOSURE);
    expect(enforcer.closes).toHaveLength(1);
    expect(Number(enforcer.closes[0]!.size)).toBeCloseTo(0.3, 6); // back to 0.5
  });
});

describe("runWatcherCycle - log-only mode", () => {
  it("records what it would do and sends nothing", async () => {
    const { venue, tick, enforcer, actions } = setup({ mode: "log" });
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick();
    venue.accountValue = 850;
    await tick();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }, { coin: "ETH", size: -4, value: 12_000 }];
    const r = await tick();

    expect(enforcer.closes).toEqual([]);
    expect(enforcer.cancels).toEqual([]);
    expect(r.executed).toBe(0);
    const trims = actions().filter((a) => a.kind === "TRIM");
    expect(trims).toHaveLength(1);
    expect(trims[0]).toMatchObject({ result: "WOULD_DO", mode: "log", coin: "ETH" });
  });

  it("does not repeat an unchanged plan in the log every few seconds", async () => {
    const { venue, tick, actions } = setup({ mode: "log" });
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick();
    venue.accountValue = 850;
    await tick();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }, { coin: "ETH", size: -4, value: 12_000 }];
    for (let i = 0; i < 6; i++) await tick();
    expect(actions().filter((a) => a.kind === "TRIM")).toHaveLength(1);
  });
});

describe("runWatcherCycle - when something goes wrong", () => {
  async function lockedWithNewPosition(opts: Parameters<typeof setup>[0] = {}) {
    const s = setup(opts);
    s.venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await s.tick();
    s.venue.accountValue = 850;
    await s.tick();
    s.venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }, { coin: "ETH", size: -4, value: 12_000 }];
    return s;
  }

  it("records a failed close with its reason and tries again next cycle", async () => {
    const s = await lockedWithNewPosition();
    s.enforcer.failWith = new Error("Order could not immediately match");
    const first = await s.tick();
    expect(first.failed).toBe(1);
    expect(s.actions().some((a) => a.result === "FAILED" && a.error?.includes("could not immediately match"))).toBe(true);

    s.enforcer.failWith = null;
    const second = await s.tick();
    expect(second.executed).toBe(1);
    expect(s.enforcer.closes).toEqual([{ coin: "ETH", isBuy: true, size: "4" }]);
  });

  it("says so, and does nothing, when the account has no agent wallet to act with", async () => {
    const s = await lockedWithNewPosition({ hasAgent: false });
    const r = await s.tick();
    expect(r.failed).toBe(1);
    expect(s.actions().some((a) => a.result === "FAILED" && a.error?.includes("no approved agent wallet"))).toBe(true);
  });

  it("finds the executor asynchronously, so it can ask the venue which agent wallet is approved", async () => {
    const s = await lockedWithNewPosition();
    let asked = 0;
    s.deps.enforcerFor = async () => {
      asked++;
      await new Promise((r) => setTimeout(r, 1));
      return s.enforcer;
    };
    const r = await s.tick();
    expect(asked).toBe(1);
    expect(r.executed).toBe(1);
  });

  it("sends no more than the per-cycle limit of orders", async () => {
    const s = setup();
    s.deps.maxActionsPerCycle = 2;
    s.venue.positions = [];
    await s.tick();
    s.venue.accountValue = 850;
    await s.tick();
    s.venue.positions = ["A", "B", "C", "D", "E"].map((coin) => ({ coin, size: 1, value: 100 }));
    const r = await s.tick();
    expect(r.planned).toBe(2);
    expect(s.enforcer.closes).toHaveLength(2);
  });

  it("changes nothing when the account cannot be read", async () => {
    const s = setup();
    await s.tick();
    const before = await s.head();
    s.venue.failState = new Error("rate limited");
    await expect(s.tick()).rejects.toThrow("rate limited");
    expect((await s.head()).enforcement).toEqual(before.enforcement);
  });
});

describe("watchAllHyperliquidAccounts", () => {
  it("watches every Hyperliquid account with an address, and one failure does not stop the others", async () => {
    const s = setup();
    s.store.seedAccount(account({ accountId: "acct_hl_2", venueAddress: "0xOTHER" }));
    s.store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_hl_2" }));
    s.store.seedRules("acct_hl_2", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 50, { accountId: "acct_hl_2", id: "x" })]);
    s.store.seedAccount(account({ accountId: "acct_evm", venue: "bsc-pancakeswap", venueAddress: null }));
    s.store.seedAccount(account({ accountId: "acct_hl_noaddr", venueAddress: null }));

    const calls: string[] = [];
    const reader: VenueStateReader = {
      getClearinghouseState: async (address) => {
        calls.push(address);
        if (address === "0xTRADER") throw new Error("boom");
        return s.venue.getClearinghouseState();
      },
    };
    const sweep = await watchAllHyperliquidAccounts({ ...s.deps, venueReader: reader });

    expect(sweep.errors.map((e) => e.accountId)).toEqual(["acct_hl"]);
    expect(sweep.results.map((r) => r.accountId)).toEqual(["acct_hl_2"]);
    expect([...new Set(calls)].sort()).toEqual(["0xOTHER", "0xTRADER"]); // the EVM and address-less accounts were never read
  });
});

describe("runWatcherCycle - a manual change to the lock state during a check", () => {
  it("is not undone: a lock cleared mid-check stays cleared, and nothing is acted on", async () => {
    const { venue, tick, head, enforcer, store } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    await tick(); // baseline
    venue.accountValue = 850; // lost 150, limit 100
    await tick(); // locked
    expect((await head()).enforcement?.lockedDay).toBe("2026-10-07");

    // Someone clears the lock (the way an operator would, in the database) while a check is running.
    venue.accountValue = 1000; // and the loss is gone, so nothing should lock it again
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }, { coin: "ETH", size: 1, value: 3_000 }]; // a new position this stale check would close
    venue.beforeStateRead = async () => {
      venue.beforeStateRead = null;
      await store.runExclusive("acct_hl", async (ctx) => {
        const h = await ctx.getAccountRiskHead("acct_hl");
        await ctx.updateAccountRiskHead({ ...h, enforcement: null });
      });
    };
    const interrupted = await tick();

    expect(interrupted.skipped).toContain("changed while this check was running");
    expect(enforcer.closes).toEqual([]); // the stale decision to close ETH was dropped
    expect((await head()).enforcement ?? null).toBeNull(); // not written back

    const next = await tick(); // the next check starts from the cleared state
    expect(next.locked).toBe(false);
    expect(enforcer.closes).toEqual([]);
  });

  it("still saves normally when nothing else touched the state", async () => {
    const { venue, tick, head } = setup();
    venue.positions = [{ coin: "BTC", size: 0.5, value: 30_000 }];
    const r = await tick();
    expect(r.skipped).toBeUndefined();
    expect((await head()).enforcement?.lastCompliant?.positions.BTC?.toString()).toBe("0.5");
  });
});

describe("runWatcherCycle - the position-size rule closes the trade and locks nothing", () => {
  it("closes the trade that went over the limit, records a TRIM and no LOCK, and allows the next trade", async () => {
    const { venue, tick, enforcer, actions, head } = setup({ rules: [[RuleType.MAX_POSITION_SIZE, 20]] });
    await tick(); // nothing held yet

    venue.positions = [{ coin: "BTC", size: 0.0003, value: 25 }]; // over $20
    const broke = await tick();
    expect(broke.locked).toBe(false);
    expect(broke.newLock).toBeUndefined();
    expect(enforcer.closes).toEqual([{ coin: "BTC", isBuy: false, size: "0.0003" }]);
    expect(actions().some((a) => a.kind === "LOCK")).toBe(false);
    expect((await head()).enforcement?.lockedDay ?? null).toBeNull();

    venue.positions = []; // the close filled
    await tick();
    venue.positions = [{ coin: "BTC", size: 0.00015, value: 12 }]; // a trade within the limit
    await tick();
    expect(enforcer.closes).toHaveLength(1); // nothing more was closed
  });

  it("lifts a position-size lock that an older version created", async () => {
    const { venue, tick, store, head } = setup({ rules: [[RuleType.MAX_POSITION_SIZE, 20]] });
    venue.positions = [{ coin: "BTC", size: 0.00013, value: 11 }];
    await store.runExclusive("acct_hl", async (ctx) => {
      const h = await ctx.getAccountRiskHead("acct_hl");
      await ctx.updateAccountRiskHead({
        ...h,
        enforcement: { lockedDay: "2026-10-07", reason: "MAX_POSITION_SIZE", lockedAtMs: T0 - 60_000, ceilings: { BTC: D(0) }, lastCompliant: null },
      });
    });
    const r = await tick();
    expect(r.unlocked).toBe(true);
    expect(r.locked).toBe(false);
    expect((await head()).enforcement?.lockedDay ?? null).toBeNull();
  });
});

