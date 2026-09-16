import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { ReasonCode, RuleType } from "@mypropguard/domain";
import { buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { evaluateProtectionGate } from "../src/protectionGate.js";

describe("evaluateProtectionGate", () => {
  const lastVerifiedAt = new Date("2026-09-16T00:00:00Z");

  it("reports protection off and blocks trading when protection is disabled", () => {
    const result = evaluateProtectionGate({
      accountRiskHead: buildAccountRiskHead(),
      rules: [],
      protectionEnabled: false,
      stateConfidenceVerified: true,
      lastVerifiedAt,
    });

    expect(result.protectionOn).toBe(false);
    expect(result.botCanOpenNewTrades).toBe(false);
    expect(result.blockingReason).toBe(ReasonCode.PROTECTION_OFF);
  });

  it("never shows green protection when account state continuity is unverified", () => {
    const result = evaluateProtectionGate({
      accountRiskHead: buildAccountRiskHead(),
      rules: [],
      protectionEnabled: true,
      stateConfidenceVerified: false,
      lastVerifiedAt,
    });

    expect(result.protectionOn).toBe(true);
    expect(result.botCanOpenNewTrades).toBe(false);
    expect(result.walletNeedsAttention).toBe(true);
    expect(result.blockingReason).toBe(ReasonCode.ACCOUNT_NEEDS_ATTENTION);
  });

  it("blocks new trades once the daily loss budget is exhausted", () => {
    const head = buildAccountRiskHead({ equityStartOfDay: new Decimal(10_000), currentEquity: new Decimal(9_400) });
    const rules = [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500)];

    const result = evaluateProtectionGate({
      accountRiskHead: head,
      rules,
      protectionEnabled: true,
      stateConfidenceVerified: true,
      lastVerifiedAt,
    });

    expect(result.botCanOpenNewTrades).toBe(false);
    expect(result.blockingReason).toBe(ReasonCode.DAILY_LOSS_BUDGET_EXCEEDED);
    expect(result.lossUsedToday.toString()).toBe("600");
    expect(result.maxLossToday.toString()).toBe("500");
  });

  it("allows new trades when protection is on, state is verified, and budget remains", () => {
    const head = buildAccountRiskHead({ equityStartOfDay: new Decimal(10_000), currentEquity: new Decimal(9_900) });
    const rules = [buildRuleVersion(RuleType.MAX_DAILY_LOSS, 500)];

    const result = evaluateProtectionGate({
      accountRiskHead: head,
      rules,
      protectionEnabled: true,
      stateConfidenceVerified: true,
      lastVerifiedAt,
    });

    expect(result.protectionOn).toBe(true);
    expect(result.botCanOpenNewTrades).toBe(true);
    expect(result.blockingReason).toBeNull();
  });
});
