import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { InMemoryRiskLedgerStore } from "@mypropguard/test-fixtures";
import { listAccounts } from "../src/listAccounts.js";

describe("listAccounts", () => {
  it("returns only accounts owned by the requested user", async () => {
    const store = new InMemoryRiskLedgerStore();
    await store.createAccount({ accountId: "acct_a", ownerUserId: "owner_1", venue: "hyperliquid", initialEquity: new Decimal(1_000), initialRules: [] });
    await store.createAccount({ accountId: "acct_b", ownerUserId: "owner_1", venue: "hyperliquid", initialEquity: new Decimal(2_000), initialRules: [] });
    await store.createAccount({ accountId: "acct_c", ownerUserId: "owner_2", venue: "hyperliquid", initialEquity: new Decimal(3_000), initialRules: [] });

    const owner1Accounts = await listAccounts(store, "owner_1");
    expect(owner1Accounts).toHaveLength(2);
    expect(owner1Accounts.map((a) => a.accountId).sort()).toEqual(["acct_a", "acct_b"]);

    const owner2Accounts = await listAccounts(store, "owner_2");
    expect(owner2Accounts).toHaveLength(1);
    expect(owner2Accounts[0]!.accountId).toBe("acct_c");
  });

  it("returns an empty list for an owner with no accounts", async () => {
    const store = new InMemoryRiskLedgerStore();
    expect(await listAccounts(store, "nobody")).toEqual([]);
  });

  it("round-trips a provisioned agent wallet", async () => {
    const store = new InMemoryRiskLedgerStore();
    await store.createAccount({
      accountId: "acct_with_wallet",
      ownerUserId: "owner_wallet",
      venue: "hyperliquid",
      initialEquity: new Decimal(1_000),
      initialRules: [],
      agentWalletId: "wallet_1",
      agentWalletAddress: "0xabc",
    });

    const accounts = await listAccounts(store, "owner_wallet");
    expect(accounts[0]!.agentWalletId).toBe("wallet_1");
    expect(accounts[0]!.agentWalletAddress).toBe("0xabc");
  });

  it("leaves agent wallet fields null when not provided (offline scaffold)", async () => {
    const store = new InMemoryRiskLedgerStore();
    await store.createAccount({
      accountId: "acct_no_wallet",
      ownerUserId: "owner_no_wallet",
      venue: "hyperliquid",
      initialEquity: new Decimal(1_000),
      initialRules: [],
    });

    const accounts = await listAccounts(store, "owner_no_wallet");
    expect(accounts[0]!.agentWalletId).toBeNull();
    expect(accounts[0]!.agentWalletAddress).toBeNull();
  });
});
