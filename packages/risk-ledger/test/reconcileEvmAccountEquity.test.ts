import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  RuleType,
  type EvmEquityQuery,
  type EvmGuardRuleSyncer,
  type EvmSafeEquityReader,
  type EvmSafeSnapshot,
  type EvmSafeStateReader,
  type EvmTokenDiscovery,
  type ProtectedAccount,
} from "@mypropguard/domain";
import { InMemoryRiskLedgerStore, buildAccountRiskHead, buildRuleVersion } from "@mypropguard/test-fixtures";
import { EvmAccountNotFoundError, reconcileEvmAccountEquity } from "../src/reconcileEvmAccountEquity.js";

const NATIVE = "0x0000000000000000000000000000000000000000";
const USDT = "0xusdt";

function evmAccount(overrides: Partial<ProtectedAccount> = {}): ProtectedAccount {
  return {
    accountId: "acct_evm_1",
    ownerUserId: "owner_1",
    venue: "bsc-pancakeswap",
    protectionEnabled: false,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    agentWalletId: null,
    agentWalletAddress: null,
    evmOwnerWalletAddress: "0xTRADER",
    evmSafeAddress: "0xSAFE",
    evmChainId: 56,
    ...overrides,
  };
}

/** Reports whatever equity the test sets, and values any flow at a fixed USD amount. */
class FakeEquityReader implements EvmSafeEquityReader {
  equity = new Decimal(0);
  flowValueUsd = new Decimal(0);
  queries: EvmEquityQuery[] = [];
  async getEquityUsd(query: EvmEquityQuery): Promise<Decimal> {
    this.queries.push(query);
    return this.equity;
  }
  async getTokenValueUsd(): Promise<Decimal> {
    return this.flowValueUsd;
  }
}

class FakeStateReader implements EvmSafeStateReader {
  settledBlock = 1000;
  nonce = 5;
  balances: Record<string, bigint> = { [NATIVE]: 10n, [USDT]: 20n };
  withdrawn: Record<string, bigint> = { [NATIVE]: 0n, [USDT]: 0n };
  snapshotCalls: { extraAssets: readonly string[]; blockNumber: number }[] = [];
  failWith: Error | null = null;
  async getSettledBlock(): Promise<number> {
    return this.settledBlock;
  }
  async getSnapshot(input: { extraAssets: readonly string[]; blockNumber: number }): Promise<EvmSafeSnapshot> {
    this.snapshotCalls.push({ extraAssets: input.extraAssets, blockNumber: input.blockNumber });
    if (this.failWith) throw this.failWith;
    const balances = { ...this.balances };
    for (const token of input.extraAssets) if (!(token in balances)) balances[token] = 1n;
    return { blockNumber: input.blockNumber, nonce: this.nonce, balances, withdrawn: { ...this.withdrawn } };
  }
}

class FakeDiscovery implements EvmTokenDiscovery {
  tokens: string[] = [];
  calls = 0;
  failWith: Error | null = null;
  async discoverTokens(): Promise<string[]> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return this.tokens;
  }
}

function guardSyncer(freezeCalls: string[]): EvmGuardRuleSyncer {
  return {
    syncRule: async () => {},
    freezeForToday: async (safeAddress) => {
      freezeCalls.push(safeAddress);
    },
  };
}

function setup(opts: { dailyLoss?: number; typedStartingEquity?: number } = {}) {
  const store = new InMemoryRiskLedgerStore();
  store.seedAccount(evmAccount());
  const typed = new Decimal(opts.typedStartingEquity ?? 10_000);
  store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_evm_1", equityStartOfDay: typed, currentEquity: typed, peakEquity: typed }));
  if (opts.dailyLoss !== undefined) {
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_DAILY_LOSS, opts.dailyLoss, { accountId: "acct_evm_1" })]);
  }
  const reader = new FakeEquityReader();
  const state = new FakeStateReader();
  const discovery = new FakeDiscovery();
  const freezes: string[] = [];
  const run = (now: string, extras: { state?: boolean; discovery?: boolean } = {}) =>
    reconcileEvmAccountEquity(store, { 56: reader }, { 56: guardSyncer(freezes) }, "acct_evm_1", {
      stateReaders: extras.state === false ? undefined : { 56: state },
      tokenDiscoveries: extras.discovery === false ? undefined : { 56: discovery },
      now: new Date(now),
    });
  return { store, reader, state, discovery, freezes, run };
}

const DAY1 = "2026-10-05T10:00:00Z";
const DAY1_LATER = "2026-10-05T14:00:00Z";
const DAY2 = "2026-10-06T00:05:00Z";

describe("reconcileEvmAccountEquity - baseline and day rollover", () => {
  it("anchors the baseline to the real equity on the first reconcile, ignoring the typed starting equity, and never freezes on it", async () => {
    const { reader, freezes, run } = setup({ dailyLoss: 5, typedStartingEquity: 10_000 });
    reader.equity = new Decimal(1.5); // the Safe really holds $1.50, not the $10,000 typed at creation

    const head = await run(DAY1);

    expect(head.equityStartOfDay.toString()).toBe("1.5");
    expect(head.currentEquity.toString()).toBe("1.5");
    expect(head.peakEquity.toString()).toBe("1.5");
    expect(freezes).toEqual([]);
  });

  it("keeps the day's baseline on later reconciles the same UTC day and tracks the loss against it", async () => {
    const { reader, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);
    reader.equity = new Decimal(920); // lost 80, under the 100 budget
    const head = await run(DAY1_LATER);

    expect(head.equityStartOfDay.toString()).toBe("1000");
    expect(head.currentEquity.toString()).toBe("920");
    expect(freezes).toEqual([]);
  });

  it("freezes when the loss since the start of the day reaches the budget", async () => {
    const { reader, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);
    reader.equity = new Decimal(850); // lost 150
    await run(DAY1_LATER);
    expect(freezes).toEqual(["0xSAFE"]);
  });

  it("starts a fresh baseline on a new UTC day, so yesterday's loss does not carry over", async () => {
    const { reader, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);
    reader.equity = new Decimal(700);
    await run(DAY1_LATER); // frozen for day 1
    freezes.length = 0;

    const head = await run(DAY2);
    expect(head.equityStartOfDay.toString()).toBe("700");
    expect(head.currentEquity.toString()).toBe("700");
    expect(freezes).toEqual([]);
  });

  it("works without a state reader (degraded): still anchors and rolls the day", async () => {
    const { reader, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(500);
    const first = await run(DAY1, { state: false, discovery: false });
    expect(first.equityStartOfDay.toString()).toBe("500");
    reader.equity = new Decimal(480);
    const second = await run(DAY2, { state: false, discovery: false });
    expect(second.equityStartOfDay.toString()).toBe("480");
  });
});

describe("reconcileEvmAccountEquity - deposits and withdrawals are not profit or loss", () => {
  it("does not treat a withdrawal (recorded by the Guard) as a loss", async () => {
    const { reader, state, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1); // baseline $1000

    state.nonce = 6; // the withdrawal was a Safe transaction
    state.withdrawn = { [NATIVE]: 4n, [USDT]: 0n };
    state.balances = { [NATIVE]: 6n, [USDT]: 20n };
    reader.flowValueUsd = new Decimal(400);
    reader.equity = new Decimal(600); // $400 was withdrawn; nothing was lost
    const head = await run(DAY1_LATER);

    expect(head.currentEquity.toString()).toBe("1000");
    expect(head.evmFlowState?.cumulativeFlowUsd.toString()).toBe("-400");
    expect(freezes).toEqual([]);
  });

  it("does not treat a deposit (balance up, no Safe transaction) as a gain, so it cannot hide a later loss", async () => {
    const { reader, state, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);

    state.balances = { [NATIVE]: 10n, [USDT]: 70n }; // nonce unchanged: 50 USDT arrived from outside
    reader.flowValueUsd = new Decimal(500);
    reader.equity = new Decimal(1500);
    const afterDeposit = await run(DAY1_LATER);
    expect(afterDeposit.currentEquity.toString()).toBe("1000");

    // Later the account really loses $150 of the combined balance.
    state.nonce = 6;
    reader.equity = new Decimal(1350);
    await run("2026-10-05T16:00:00Z");
    expect(freezes).toEqual(["0xSAFE"]);
  });

  it("does not guess a deposit when the Safe ran a transaction in between: a balance increase then is trade proceeds", async () => {
    const { reader, state, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);

    state.nonce = 6; // a sell
    state.balances = { [NATIVE]: 10n, [USDT]: 90n };
    reader.flowValueUsd = new Decimal(999);
    reader.equity = new Decimal(1040);
    const head = await run(DAY1_LATER);

    expect(head.evmFlowState?.cumulativeFlowUsd.toString()).toBe("0");
    expect(head.currentEquity.toString()).toBe("1040");
    expect(freezes).toEqual([]);
  });

  it("still catches a real loss when a withdrawal happened too", async () => {
    const { reader, state, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);

    state.nonce = 6;
    state.withdrawn = { [NATIVE]: 0n, [USDT]: 30n };
    reader.flowValueUsd = new Decimal(300);
    reader.equity = new Decimal(550); // 1000 - 300 withdrawn = 700 expected; 150 was really lost
    await run(DAY1_LATER);
    expect(freezes).toEqual(["0xSAFE"]);
  });

  it("keeps the cumulative flow across days so the new day's baseline stays consistent", async () => {
    const { reader, state, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);

    state.balances = { [NATIVE]: 10n, [USDT]: 40n }; // a deposit of 20 USDT
    reader.flowValueUsd = new Decimal(200);
    reader.equity = new Decimal(1200);
    await run(DAY1_LATER);

    const day2 = await run(DAY2); // no trading, no flow: equity unchanged at 1200
    expect(day2.equityStartOfDay.toString()).toBe("1000");
    expect(day2.currentEquity.toString()).toBe("1000");
    expect(freezes).toEqual([]);
  });

  it("produces no flow for an asset seen for the first time", async () => {
    const { reader, state, discovery, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);

    state.nonce = 6;
    discovery.tokens = ["0xcake"]; // bought; first reading of this token
    reader.flowValueUsd = new Decimal(77);
    const head = await run(DAY1_LATER);
    expect(head.evmFlowState?.cumulativeFlowUsd.toString()).toBe("0");
  });
});

describe("reconcileEvmAccountEquity - which tokens are valued", () => {
  it("values tokens found by discovery, alongside tokens that have a per-token rule", async () => {
    const { store, reader, discovery, run } = setup();
    store.seedRules("acct_evm_1", [
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 500, { accountId: "acct_evm_1", tokenAddress: "0xUSDT", id: "r1" }),
      buildRuleVersion(RuleType.MAX_POSITION_SIZE, 300, { accountId: "acct_evm_1", tokenAddress: "0xUSDT", id: "r2" }),
      buildRuleVersion(RuleType.MAX_TRADE_FREQUENCY, 10, { accountId: "acct_evm_1", id: "r3" }),
    ]);
    discovery.tokens = ["0xCAKE"];
    await run(DAY1);

    expect(reader.queries[0]!.trackedTokens).toEqual(["0xusdt", "0xcake"]);
  });

  it("asks discovery on the first reconcile, and again only after the Safe ran a transaction", async () => {
    const { state, discovery, run } = setup();
    await run(DAY1);
    expect(discovery.calls).toBe(1);

    await run(DAY1_LATER); // nonce unchanged
    expect(discovery.calls).toBe(1);

    state.nonce = 6;
    await run("2026-10-05T16:00:00Z");
    expect(discovery.calls).toBe(2);
  });

  it("remembers discovered tokens on later reconciles", async () => {
    const { reader, discovery, run } = setup();
    discovery.tokens = ["0xCAKE"];
    await run(DAY1);
    discovery.tokens = [];
    await run(DAY1_LATER);

    expect(reader.queries[1]!.trackedTokens).toEqual(["0xcake"]);
  });

  it("reads balances and prices at the settled block, and watches the discovered token in the snapshot", async () => {
    const { reader, state, discovery, run } = setup();
    state.settledBlock = 1234;
    discovery.tokens = ["0xcake"];
    await run(DAY1);

    expect(reader.queries[0]!.blockNumber).toBe(1234);
    expect(state.snapshotCalls.every((c) => c.blockNumber === 1234)).toBe(true);
    expect(state.snapshotCalls.at(-1)!.extraAssets).toEqual(["0xcake"]);
  });

  it("works without token discovery configured, valuing only rule tokens", async () => {
    const { store, reader, run } = setup();
    store.seedRules("acct_evm_1", [buildRuleVersion(RuleType.MAX_POSITION_SIZE, 5, { accountId: "acct_evm_1", tokenAddress: "0xUSDT" })]);
    await run(DAY1, { discovery: false });
    expect(reader.queries[0]!.trackedTokens).toEqual(["0xusdt"]);
  });
});

describe("reconcileEvmAccountEquity - failures never freeze an account on a half-read", () => {
  it("writes nothing and never freezes when the chain read fails", async () => {
    const { store, reader, state, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);

    state.failWith = new Error("rpc down");
    reader.equity = new Decimal(0); // would look like a total loss if the read were trusted
    await expect(run(DAY1_LATER)).rejects.toThrow("rpc down");

    const head = await store.runExclusive("acct_evm_1", (ctx) => ctx.getAccountRiskHead("acct_evm_1"));
    expect(head.currentEquity.toString()).toBe("1000");
    expect(freezes).toEqual([]);
  });

  it("fails the whole reconcile when token discovery fails, rather than valuing an incomplete portfolio", async () => {
    const { reader, state, discovery, freezes, run } = setup({ dailyLoss: 100 });
    reader.equity = new Decimal(1000);
    await run(DAY1);

    state.nonce = 6;
    discovery.failWith = new Error("Moralis down");
    reader.equity = new Decimal(300);
    await expect(run(DAY1_LATER)).rejects.toThrow("Moralis down");
    expect(freezes).toEqual([]);
  });
});

describe("reconcileEvmAccountEquity - guards", () => {
  it("throws EvmAccountNotFoundError for a non-EVM account", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount({ accountId: "acct_hl", evmSafeAddress: null, evmChainId: null }));
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_hl" }));
    await expect(reconcileEvmAccountEquity(store, { 56: new FakeEquityReader() }, undefined, "acct_hl")).rejects.toThrow(
      EvmAccountNotFoundError,
    );
  });

  it("throws EvmAccountNotFoundError when no equity reader is configured for the account's chain", async () => {
    const store = new InMemoryRiskLedgerStore();
    store.seedAccount(evmAccount());
    store.seedAccountRiskHead(buildAccountRiskHead({ accountId: "acct_evm_1" }));
    await expect(reconcileEvmAccountEquity(store, { 1: new FakeEquityReader() }, undefined, "acct_evm_1")).rejects.toThrow(
      EvmAccountNotFoundError,
    );
  });
});
