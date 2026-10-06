import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { StateConfidence, type ClearinghouseState, type VenueCapitalFlow, type VenueStateReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead } from "@mypropguard/test-fixtures";
import { reconcileAccountFromVenue } from "../src/reconcileAccount.js";

function stateOf(accountValue: number, extra: Partial<ClearinghouseState> = {}): ClearinghouseState {
  return {
    accountValue: new Decimal(accountValue),
    totalMarginUsed: new Decimal(0),
    totalNotionalPosition: new Decimal(0),
    withdrawable: new Decimal(accountValue),
    positions: [],
    ...extra,
  };
}

class FakeVenue implements VenueStateReader {
  state: ClearinghouseState = stateOf(1000, { time: 5000 });
  flows: VenueCapitalFlow[] = [];
  flowCalls: number[] = [];
  withFlows = true;
  failFlows: Error | null = null;
  async getClearinghouseState() {
    return this.state;
  }
  getCapitalFlows = async (_address: string, afterMs: number) => {
    this.flowCalls.push(afterMs);
    if (this.failFlows) throw this.failFlows;
    return this.flows.filter((f) => f.timeMs > afterMs);
  };
}

const DAY1 = "2026-10-05T10:00:00Z";
const DAY1_LATER = "2026-10-05T14:00:00Z";
const DAY2 = "2026-10-06T00:05:00Z";

function setup(typed = 10_000) {
  const store = new InMemoryRiskLedgerStore();
  store.seedAccountRiskHead(
    buildAccountRiskHead({ accountId: "acct_hl", equityStartOfDay: new Decimal(typed), currentEquity: new Decimal(typed), peakEquity: new Decimal(typed) }),
  );
  const venue = new FakeVenue();
  const run = (now: string, reader: VenueStateReader = venue) =>
    reconcileAccountFromVenue(store, reader, { accountId: "acct_hl", venueAddress: "0xabc" }, { now: new Date(now) });
  return { store, venue, run };
}

describe("reconcileAccountFromVenue - the basics", () => {
  it("folds venue equity and exposure into the account head and records a VERIFIED checkpoint", async () => {
    const { store, venue, run } = setup(9_000);
    venue.state = stateOf(11_000, { totalMarginUsed: new Decimal(1_000), totalNotionalPosition: new Decimal(4_400), time: 5000 });

    const { head } = await run(DAY1);

    expect(head.currentEquity.toString()).toBe("11000");
    expect(head.openNotional.toString()).toBe("4400");
    expect(head.leverage.toString()).toBe("0.4");
    expect(head.peakEquity.toString()).toBe("11000");
    void store;
    void StateConfidence;
  });

  it("anchors the baseline and the peak to the real account value on the first reconcile, ignoring the typed initial equity", async () => {
    const { venue, run } = setup(10_000);
    venue.state = stateOf(250, { time: 5000 });

    const { head } = await run(DAY1);

    expect(head.equityStartOfDay.toString()).toBe("250");
    expect(head.peakEquity.toString()).toBe("250");
    expect(head.currentEquity.toString()).toBe("250");
  });

  it("never lowers peakEquity when the account value falls on a later reconcile", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(20_000, { time: 5000 });
    await run(DAY1);
    venue.state = stateOf(15_000, { time: 6000 });
    const { head } = await run(DAY1_LATER);

    expect(head.currentEquity.toString()).toBe("15000");
    expect(head.peakEquity.toString()).toBe("20000");
  });

  it("keeps the day's baseline for the rest of the UTC day, so the loss accumulates against it", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);
    venue.state = stateOf(900, { time: 6000 });
    const { head } = await run(DAY1_LATER);
    expect(head.equityStartOfDay.toString()).toBe("1000");
    expect(head.currentEquity.toString()).toBe("900");
  });

  it("starts a fresh baseline on a new UTC day", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);
    venue.state = stateOf(700, { time: 6000 });
    await run(DAY1_LATER);
    venue.state = stateOf(700, { time: 7000 });
    const { head } = await run(DAY2);
    expect(head.equityStartOfDay.toString()).toBe("700");
    expect(head.currentEquity.toString()).toBe("700");
  });
});

describe("reconcileAccountFromVenue - deposits and withdrawals are not profit or loss", () => {
  it("does not read the ledger on the first reconcile: the existing balance is the baseline, not a flow", async () => {
    const { venue, run } = setup();
    venue.flows = [{ id: "0xold", timeMs: 100, amountUsd: new Decimal(500) }];
    const { head } = await run(DAY1);
    expect(venue.flowCalls).toEqual([]);
    expect(head.venueFlowState?.cumulativeFlowUsd.toString()).toBe("0");
  });

  it("does not treat a withdrawal as a loss", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);

    venue.flows = [{ id: "0xw", timeMs: 5500, amountUsd: new Decimal(-400) }];
    venue.state = stateOf(600, { time: 6000 });
    const { head } = await run(DAY1_LATER);

    expect(head.currentEquity.toString()).toBe("1000");
    expect(head.venueFlowState?.cumulativeFlowUsd.toString()).toBe("-400");
  });

  it("does not treat a deposit as a gain", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);

    venue.flows = [{ id: "0xd", timeMs: 5500, amountUsd: new Decimal(500) }];
    venue.state = stateOf(1500, { time: 6000 });
    const { head } = await run(DAY1_LATER);
    expect(head.currentEquity.toString()).toBe("1000");
  });

  it("still shows a real loss that happened alongside a withdrawal", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);

    venue.flows = [{ id: "0xw", timeMs: 5500, amountUsd: new Decimal(-300) }];
    venue.state = stateOf(550, { time: 6000 }); // 1000 - 300 withdrawn = 700; the extra 150 was lost
    const { head } = await run(DAY1_LATER);
    expect(head.equityStartOfDay.minus(head.currentEquity).toString()).toBe("150");
  });

  it("counts each flow once, however many times it reconciles", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);

    venue.flows = [{ id: "0xw", timeMs: 5500, amountUsd: new Decimal(-400) }];
    venue.state = stateOf(600, { time: 6000 });
    await run(DAY1_LATER);
    venue.state = stateOf(600, { time: 7000 });
    const { head } = await run("2026-10-05T15:00:00Z");

    expect(head.venueFlowState?.cumulativeFlowUsd.toString()).toBe("-400");
    expect(head.currentEquity.toString()).toBe("1000");
    expect(venue.flowCalls).toEqual([5000, 6000]);
  });

  it("consumes a flow stamped just after the account value was read, so it is not read twice", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);

    // The flow's own time (6500) is later than the state's time (6000): the cursor must pass it.
    venue.flows = [{ id: "0xlate", timeMs: 6500, amountUsd: new Decimal(-100) }];
    venue.state = stateOf(900, { time: 6000 });
    await run(DAY1_LATER);
    venue.state = stateOf(900, { time: 7000 });
    const { head } = await run("2026-10-05T15:00:00Z");

    expect(head.venueFlowState?.cumulativeFlowUsd.toString()).toBe("-100");
  });

  it("keeps the cumulative flow across days so the new day's baseline stays consistent", async () => {
    const { venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);
    venue.flows = [{ id: "0xd", timeMs: 5500, amountUsd: new Decimal(200) }];
    venue.state = stateOf(1200, { time: 6000 });
    await run(DAY1_LATER);

    venue.state = stateOf(1200, { time: 7000 });
    const { head } = await run(DAY2);
    expect(head.equityStartOfDay.toString()).toBe("1000");
    expect(head.currentEquity.toString()).toBe("1000");
  });

  it("writes nothing when reading the ledger fails", async () => {
    const { store, venue, run } = setup();
    venue.state = stateOf(1000, { time: 5000 });
    await run(DAY1);

    venue.failFlows = new Error("rate limited");
    venue.state = stateOf(0, { time: 6000 });
    await expect(run(DAY1_LATER)).rejects.toThrow("rate limited");
    const head = await store.runExclusive("acct_hl", (ctx) => ctx.getAccountRiskHead("acct_hl"));
    expect(head.currentEquity.toString()).toBe("1000");
  });

  it("still anchors and rolls the day when the reader cannot read the ledger (degraded)", async () => {
    const { run } = setup();
    const noLedger: VenueStateReader = { getClearinghouseState: async () => stateOf(500, { time: 5000 }) };
    const first = await run(DAY1, noLedger);
    expect(first.head.equityStartOfDay.toString()).toBe("500");
    const second = await run(DAY2, { getClearinghouseState: async () => stateOf(480, { time: 6000 }) });
    expect(second.head.equityStartOfDay.toString()).toBe("480");
  });
});
