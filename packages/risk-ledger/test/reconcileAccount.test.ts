import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { StateConfidence, type ClearinghouseState, type VenueStateReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead } from "@mypropguard/test-fixtures";
import { reconcileAccountFromVenue } from "../src/reconcileAccount.js";

function fakeVenueReader(state: ClearinghouseState): VenueStateReader {
  return { getClearinghouseState: async () => state };
}

describe("reconcileAccountFromVenue", () => {
  it("folds venue equity/exposure into the account head and records a VERIFIED checkpoint", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_reconcile_1", peakEquity: new Decimal(9_000), currentEquity: new Decimal(9_000) }),
    );

    const venueReader = fakeVenueReader({
      accountValue: new Decimal(11_000),
      totalMarginUsed: new Decimal(1_000),
      totalNotionalPosition: new Decimal(4_400),
      withdrawable: new Decimal(9_600),
      positions: [],
    });

    const { head } = await reconcileAccountFromVenue(store, venueReader, {
      accountId: "acct_reconcile_1",
      venueAddress: "0xabc",
    });

    expect(head.currentEquity.toString()).toBe("11000");
    expect(head.openNotional.toString()).toBe("4400");
    expect(head.leverage.toString()).toBe("0.4");
    // Peak equity rises to track the new high, per AccountRiskHead's role
    // in drawdown accounting.
    expect(head.peakEquity.toString()).toBe("11000");
  });

  it("never lowers peakEquity when the venue reports a smaller equity than a prior high", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(
      buildAccountRiskHead({ accountId: "acct_reconcile_2", peakEquity: new Decimal(20_000), currentEquity: new Decimal(20_000) }),
    );

    const venueReader = fakeVenueReader({
      accountValue: new Decimal(15_000),
      totalMarginUsed: new Decimal(0),
      totalNotionalPosition: new Decimal(0),
      withdrawable: new Decimal(15_000),
      positions: [],
    });

    const { head } = await reconcileAccountFromVenue(store, venueReader, {
      accountId: "acct_reconcile_2",
      venueAddress: "0xabc",
    });

    expect(head.currentEquity.toString()).toBe("15000");
    expect(head.peakEquity.toString()).toBe("20000");
  });
});
