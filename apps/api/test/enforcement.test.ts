import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { type ClearinghouseState, type VenueStateReader } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

const TRADER = "0xTRADERADDRESS";

function reader(accountValue = 1000): VenueStateReader {
  return {
    getClearinghouseState: async (): Promise<ClearinghouseState> => ({
      accountValue: new Decimal(accountValue),
      totalMarginUsed: new Decimal(0),
      totalNotionalPosition: new Decimal(0),
      withdrawable: new Decimal(accountValue),
      positions: [],
      time: Date.now(),
    }),
  };
}

async function createHlAccount(app: ReturnType<typeof buildApp>, accountId: string, venueAddress?: string) {
  return app.inject({
    method: "POST",
    url: "/v1/accounts",
    payload: {
      accountId,
      ownerUserId: "owner_1",
      initialEquity: "1000",
      initialRules: [{ ruleType: "MAX_DAILY_LOSS", param: "100" }],
      ...(venueAddress ? { venueAddress } : {}),
    },
  });
}

describe("the trader's Hyperliquid address", () => {
  it("is saved when the account is created and comes back in the account list", async () => {
    const app = buildApp({ store: new InMemoryRiskLedgerStore() });
    expect((await createHlAccount(app, "acct_a", TRADER)).statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/v1/accounts?ownerUserId=owner_1" });
    expect(list.json().accounts[0].venueAddress).toBe(TRADER);
  });

  it("is null when none was given", async () => {
    const app = buildApp({ store: new InMemoryRiskLedgerStore() });
    await createHlAccount(app, "acct_b");
    const list = await app.inject({ method: "GET", url: "/v1/accounts?ownerUserId=owner_1" });
    expect(list.json().accounts[0].venueAddress).toBeNull();
  });

  it("is remembered when the owner reconciles with an address, so the watcher can find it later", async () => {
    const app = buildApp({ store: new InMemoryRiskLedgerStore(), venueReader: reader() });
    await createHlAccount(app, "acct_c");

    const response = await app.inject({ method: "POST", url: "/v1/accounts/acct_c/reconcile", payload: { venueAddress: TRADER } });
    expect(response.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/v1/accounts?ownerUserId=owner_1" });
    expect(list.json().accounts[0].venueAddress).toBe(TRADER);
  });
});

describe("GET /v1/accounts/:accountId/enforcement", () => {
  it("reports an unlocked account with nothing recorded", async () => {
    const app = buildApp({ store: new InMemoryRiskLedgerStore(), watcherMode: "log" });
    await createHlAccount(app, "acct_d", TRADER);

    const body = (await app.inject({ method: "GET", url: "/v1/accounts/acct_d/enforcement" })).json();
    expect(body).toMatchObject({ watcherMode: "log", lockedToday: false, lockedDay: null, reason: null, actions: [] });
  });

  it("reports that the watcher is off when the server has it disabled", async () => {
    const app = buildApp({ store: new InMemoryRiskLedgerStore() });
    await createHlAccount(app, "acct_e", TRADER);
    expect((await app.inject({ method: "GET", url: "/v1/accounts/acct_e/enforcement" })).json().watcherMode).toBe("off");
  });

  it("reports a lock, its ceilings, and the recorded actions, newest first", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, watcherMode: "enforce" });
    await createHlAccount(app, "acct_f", TRADER);

    const today = new Date().toISOString().slice(0, 10);
    await store.runExclusive("acct_f", async (ctx) => {
      const head = await ctx.getAccountRiskHead("acct_f");
      await ctx.updateAccountRiskHead({
        ...head,
        enforcement: {
          lockedDay: today,
          reason: "MAX_DAILY_LOSS",
          lockedAtMs: Date.now(),
          ceilings: { BTC: new Decimal("0.5") },
          lastCompliant: null,
        },
      });
    });
    await store.recordEnforcementAction({ accountId: "acct_f", mode: "enforce", kind: "LOCK", detail: { rule: "MAX_DAILY_LOSS" }, result: "INFO" });
    await store.recordEnforcementAction({ accountId: "acct_f", mode: "enforce", kind: "TRIM", coin: "ETH", detail: { plan: "buy 4 ETH reduce-only" }, result: "DONE" });

    const body = (await app.inject({ method: "GET", url: "/v1/accounts/acct_f/enforcement" })).json();
    expect(body).toMatchObject({ watcherMode: "enforce", lockedToday: true, reason: "MAX_DAILY_LOSS", ceilings: { BTC: "0.5" } });
    expect(body.actions.map((a: any) => a.kind)).toEqual(["TRIM", "LOCK"]);
    expect(body.actions[0]).toMatchObject({ coin: "ETH", result: "DONE", mode: "enforce" });
  });

  it("does not report a lock from an earlier day as active", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store, watcherMode: "log" });
    await createHlAccount(app, "acct_g", TRADER);
    await store.runExclusive("acct_g", async (ctx) => {
      const head = await ctx.getAccountRiskHead("acct_g");
      await ctx.updateAccountRiskHead({
        ...head,
        enforcement: { lockedDay: "2020-01-01", reason: "MAX_DAILY_LOSS", lockedAtMs: 1, ceilings: {}, lastCompliant: null },
      });
    });
    expect((await app.inject({ method: "GET", url: "/v1/accounts/acct_g/enforcement" })).json().lockedToday).toBe(false);
  });
});
