import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import { buildAccountRiskHead } from "@mypropguard/test-fixtures";
import { PgRiskLedgerStore } from "../src/postgres/pgRiskLedgerStore.js";
import { rowToAccountRiskHead } from "../src/postgres/mappers.js";

/** A pool whose connection records every query, so the SQL can be checked without a database. */
function fakePool() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as any;
  return { pool, queries };
}

async function runUpdate(head: ReturnType<typeof buildAccountRiskHead>) {
  const { pool, queries } = fakePool();
  await new PgRiskLedgerStore(pool).runExclusive(head.accountId, (ctx) => ctx.updateAccountRiskHead(head));
  return queries.find((q) => q.sql.includes("UPDATE account_risk_heads"))!;
}

describe("PgRiskLedgerStore.updateAccountRiskHead", () => {
  it("does not touch evm_flow_state for a head that has none (so it works before migration 0009)", async () => {
    const update = await runUpdate(buildAccountRiskHead({ accountId: "acct_hl" }));
    expect(update.sql).not.toContain("evm_flow_state");
    expect(update.params).toHaveLength(10);
  });

  it("writes evm_flow_state as JSON when the head carries it", async () => {
    const update = await runUpdate(
      buildAccountRiskHead({
        accountId: "acct_evm",
        evmFlowState: {
          day: "2026-10-05",
          cursorBlock: 123,
          cumulativeFlowUsd: new Decimal("-1.5"),
          knownTokens: ["0xcake"],
          lastNonce: 7,
          lastBalances: { "0x0000000000000000000000000000000000000000": "100" },
          lastWithdrawn: { "0x0000000000000000000000000000000000000000": "5" },
        },
      }),
    );
    expect(update.sql).toContain("evm_flow_state = $11::jsonb");
    expect(JSON.parse(update.params[10] as string)).toEqual({
      day: "2026-10-05",
      cursorBlock: 123,
      cumulativeFlowUsd: "-1.5",
      knownTokens: ["0xcake"],
      lastNonce: 7,
      lastBalances: { "0x0000000000000000000000000000000000000000": "100" },
      lastWithdrawn: { "0x0000000000000000000000000000000000000000": "5" },
    });
  });

  it("clears evm_flow_state when the head explicitly has none (column exists, account never used it)", async () => {
    const update = await runUpdate(buildAccountRiskHead({ accountId: "acct_hl", evmFlowState: null }));
    expect(update.sql).toContain("evm_flow_state = $11::jsonb");
    expect(update.params[10]).toBeNull();
  });
});

describe("rowToAccountRiskHead and evm_flow_state", () => {
  const baseRow = {
    account_id: "a",
    equity_start_of_day: "1",
    current_equity: "1",
    realized_pnl_today: "0",
    peak_equity: "1",
    current_drawdown: "0",
    open_notional: "0",
    leverage: "0",
    trade_count_today: 0,
    last_trade_at: null,
    version: 1,
  };

  it("reads the state back, including big balances as strings", () => {
    const head = rowToAccountRiskHead({
      ...baseRow,
      evm_flow_state: {
        day: "2026-10-05",
        cursorBlock: 9,
        cumulativeFlowUsd: "2.5",
        knownTokens: ["0xcake"],
        lastNonce: 3,
        lastBalances: { "0x0": "123456789012345678901234567890" },
        lastWithdrawn: { "0x0": "0" },
      },
    });
    expect(head.evmFlowState?.cumulativeFlowUsd.toString()).toBe("2.5");
    expect(head.evmFlowState?.lastBalances["0x0"]).toBe("123456789012345678901234567890");
    expect(head.evmFlowState?.lastNonce).toBe(3);
  });

  it("is undefined when the column does not exist yet, and null when it exists but is empty", () => {
    expect(rowToAccountRiskHead(baseRow).evmFlowState).toBeUndefined();
    expect(rowToAccountRiskHead({ ...baseRow, evm_flow_state: null }).evmFlowState).toBeNull();
  });
});
