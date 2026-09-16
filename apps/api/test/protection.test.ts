import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

describe("GET/POST /v1/protection", () => {
  it("reports protection off before activation", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_p1" }));
    const app = buildApp({ store });

    const response = await app.inject({ method: "GET", url: "/v1/protection/acct_p1" });
    expect(response.statusCode).toBe(200);
    expect(response.json().protectionOn).toBe(false);
  });

  it("activation turns protection on, but Phase 0/1 must still refuse new trades until state is verified", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_p2" }));
    store.seedRules("acct_p2", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500)]);
    const app = buildApp({ store });

    const activate = await app.inject({
      method: "POST",
      url: "/v1/protection/activate",
      payload: { accountId: "acct_p2" },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json().protectionOn).toBe(true);

    const status = await app.inject({ method: "GET", url: "/v1/protection/acct_p2" });
    const body = status.json();
    expect(body.protectionOn).toBe(true);
    // No live venue state ingestion exists yet (Phase 2), so the gate must
    // never claim the bot can safely trade.
    expect(body.botCanOpenNewTrades).toBe(false);
    expect(body.walletNeedsAttention).toBe(true);
  });

  it("deactivation turns protection back off", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_p3" }));
    store.seedProtectionEnabled("acct_p3", true);
    const app = buildApp({ store });

    const deactivate = await app.inject({
      method: "POST",
      url: "/v1/protection/deactivate",
      payload: { accountId: "acct_p3" },
    });

    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().protectionOn).toBe(false);
  });
});
