import { describe, expect, it } from "vitest";
import { RuleType } from "@mypropguard/domain";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

async function createAccountWithRule(app: ReturnType<typeof buildApp>, accountId: string) {
  await app.inject({
    method: "POST",
    url: "/v1/accounts",
    payload: {
      accountId,
      ownerUserId: "owner_rules",
      initialEquity: "10000",
      initialRules: [{ ruleType: RuleType.MAX_DAILY_LOSS, param: "500" }],
    },
  });
}

describe("GET /v1/accounts/:accountId/rules", () => {
  it("lists the account's active rules", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_1");

    const response = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_1/rules" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0].ruleType).toBe(RuleType.MAX_DAILY_LOSS);
    expect(body.rules[0].param).toBe("500");
    expect(body.rules[0].isActive).toBe(true);
  });
});

describe("POST /v1/accounts/:accountId/rules", () => {
  it("adds a new rule and it shows up in the list", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_2");

    const addResponse = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_rules_api_2/rules",
      payload: { ruleType: RuleType.MAX_POSITION_SIZE, param: "50000" },
    });

    expect(addResponse.statusCode).toBe(201);
    expect(addResponse.json().rule.ruleType).toBe(RuleType.MAX_POSITION_SIZE);

    const listResponse = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_2/rules" });
    expect(listResponse.json().rules).toHaveLength(2);
  });

  it("rejects a malformed request with 400", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_3");

    const response = await app.inject({
      method: "POST",
      url: "/v1/accounts/acct_rules_api_3/rules",
      payload: { ruleType: "NOT_A_REAL_RULE_TYPE", param: "50000" },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /v1/accounts/:accountId/rules/:ruleId/deactivate", () => {
  it("deactivates a rule so it no longer shows up in the active list", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });
    await createAccountWithRule(app, "acct_rules_api_4");

    const listBefore = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_4/rules" });
    const ruleId = listBefore.json().rules[0].id;

    const deactivateResponse = await app.inject({
      method: "POST",
      url: `/v1/accounts/acct_rules_api_4/rules/${ruleId}/deactivate`,
    });

    expect(deactivateResponse.statusCode).toBe(200);
    expect(deactivateResponse.json()).toEqual({ ruleId, isActive: false });

    const listAfter = await app.inject({ method: "GET", url: "/v1/accounts/acct_rules_api_4/rules" });
    expect(listAfter.json().rules).toHaveLength(0);
  });
});
