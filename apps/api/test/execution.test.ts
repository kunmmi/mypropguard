import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import { FakeSignerGateway, InMemoryExecutionSequencer } from "@mypropguard/execution";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { buildApp } from "../src/app.js";

describe("POST /v1/execution/dry-run", () => {
  it("runs risk + reservation + fake signing for an order within limits", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_exec_1" }));
    store.seedRules("acct_exec_1", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    const app = buildApp({ store, executionSequencer: new InMemoryExecutionSequencer(), signer: new FakeSignerGateway() });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_intent_1",
        accountId: "acct_exec_1",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mock).toBe(true);
    expect(body.decision.outcome).toBe("ALLOW");
    expect(body.mockSignedAction.mockSignerAddress).toMatch(/^0xFAKE/);
  });

  it("does not sign anything for a BLOCKed decision", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_exec_2", openNotional: new Decimal(100_000) }));
    store.seedRules("acct_exec_2", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 100_000)]);

    const app = buildApp({ store, executionSequencer: new InMemoryExecutionSequencer(), signer: new FakeSignerGateway() });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: {
        clientIntentId: "exec_intent_2",
        accountId: "acct_exec_2",
        coin: "BTC",
        side: "BUY",
        size: "1",
        price: "50000",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.decision.outcome).toBe("BLOCK");
    expect(body.mockSignedAction).toBeNull();
  });

  it("returns 501 when no fake signer is configured", async () => {
    const store = new InMemoryRiskLedgerStore();
    const app = buildApp({ store });

    const response = await app.inject({
      method: "POST",
      url: "/v1/execution/dry-run",
      payload: { clientIntentId: "x", accountId: "acct_none", coin: "BTC", side: "BUY", size: "1", price: "1" },
    });

    expect(response.statusCode).toBe(501);
  });
});
