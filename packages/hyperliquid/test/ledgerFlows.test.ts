import { describe, expect, it, vi } from "vitest";
import { HyperliquidInfoClient, mapLedgerUpdate, type RawLedgerUpdate } from "../src/infoClient.js";

const ME = "0x85ecf584f25db6f146718b86d493e33c5af72052";
const OTHER = "0xcf3f419d08a5bdc2c6e5fbd9ad70904c5420f95f";

const entry = (delta: RawLedgerUpdate["delta"], time = 1000, hash = "0xhash"): RawLedgerUpdate => ({ time, hash, delta });
const usd = (update: RawLedgerUpdate) => mapLedgerUpdate(update, ME)?.amountUsd.toString() ?? null;

// The shapes below are real entries from Hyperliquid's mainnet ledger.
describe("mapLedgerUpdate", () => {
  it("counts a deposit as money in", () => {
    expect(usd(entry({ type: "deposit", usdc: "495.59" }))).toBe("495.59");
  });

  it("counts a withdrawal, and its fee, as money out", () => {
    expect(usd(entry({ type: "withdraw", usdc: "87.0", fee: "1.0" }))).toBe("-88");
  });

  it("follows the direction of a spot <-> perps transfer", () => {
    expect(usd(entry({ type: "accountClassTransfer", usdc: "0.1", toPerp: true }))).toBe("0.1");
    expect(usd(entry({ type: "accountClassTransfer", usdc: "250", toPerp: false }))).toBe("-250");
  });

  it("follows the direction of a transfer to or from another account", () => {
    expect(usd(entry({ type: "internalTransfer", usdc: "344.23", user: ME, destination: OTHER, fee: "0.0" }))).toBe("-344.23");
    expect(usd(entry({ type: "internalTransfer", usdc: "344.23", user: OTHER, destination: ME, fee: "0.0" }))).toBe("344.23");
    expect(usd(entry({ type: "subAccountTransfer", usdc: "500000.0", user: ME, destination: OTHER }))).toBe("-500000");
    expect(usd(entry({ type: "subAccountTransfer", usdc: "500000.0", user: OTHER, destination: ME }))).toBe("500000");
  });

  it("treats a transfer to oneself as no flow", () => {
    expect(usd(entry({ type: "subAccountTransfer", usdc: "5", user: ME, destination: ME }))).toBeNull();
  });

  it("handles the newer 'send' entry by which side is the perps account", () => {
    const base = { type: "send", token: "USDC", amount: "495.59", usdcValue: "495.59", fee: "0.0" };
    // spot -> perps for this address: money into the perps balance
    expect(usd(entry({ ...base, user: ME, destination: ME, sourceDex: "spot", destinationDex: "" }))).toBe("495.59");
    // perps -> someone else
    expect(usd(entry({ ...base, user: ME, destination: OTHER, sourceDex: "", destinationDex: "spot" }))).toBe("-495.59");
    // someone else -> this address's perps
    expect(usd(entry({ ...base, user: OTHER, destination: ME, sourceDex: "spot", destinationDex: "" }))).toBe("495.59");
    // spot -> spot never touches the perps balance
    expect(usd(entry({ ...base, user: ME, destination: OTHER, sourceDex: "spot", destinationDex: "spot" }))).toBeNull();
    // other tokens are not USDC equity
    expect(usd(entry({ ...base, token: "HYPE", user: ME, destination: ME, sourceDex: "spot", destinationDex: "" }))).toBeNull();
  });

  it("counts vault deposits out and vault withdrawals in", () => {
    expect(usd(entry({ type: "vaultDeposit", usdc: "100.0" }))).toBe("-100");
    expect(usd(entry({ type: "vaultWithdraw", netWithdrawnUsd: "99999.999999" }))).toBe("99999.999999");
  });

  it("ignores entries that are not capital: liquidations, spot transfers, staking, rewards, unknown types", () => {
    expect(usd(entry({ type: "liquidation" }))).toBeNull();
    expect(usd(entry({ type: "spotTransfer", token: "LATINA", amount: "35179.388", usdcValue: "0.0", user: ME, destination: OTHER }))).toBeNull();
    expect(usd(entry({ type: "cStakingTransfer", token: "HYPE", amount: "999.79" }))).toBeNull();
    expect(usd(entry({ type: "gossipPriorityGasAuction", token: "HYPE", amount: "0.98" }))).toBeNull();
    expect(usd(entry({ type: "someFutureType", usdc: "1000000" }))).toBeNull();
  });

  it("ignores a zero-value entry", () => {
    expect(usd(entry({ type: "deposit", usdc: "0.0" }))).toBeNull();
  });

  it("matches the address case-insensitively", () => {
    expect(mapLedgerUpdate(entry({ type: "internalTransfer", usdc: "5", user: ME.toUpperCase().replace("0X", "0x"), destination: OTHER, fee: "0.0" }), ME)?.amountUsd.toString()).toBe("-5");
  });
});

describe("HyperliquidInfoClient.getCapitalFlows", () => {
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as Response;
  /** Answers by request type, the way Hyperliquid does; `ledger` may be a list or a function of the call number. */
  const router = (opts: { mode?: unknown; ledger: unknown[] | ((call: number) => unknown[]) }) => {
    let ledgerCalls = 0;
    return vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === "userAbstraction") return response(opts.mode ?? "default");
      ledgerCalls++;
      return response(typeof opts.ledger === "function" ? opts.ledger(ledgerCalls) : opts.ledger);
    });
  };
  const ledgerBodies = (fn: ReturnType<typeof router>) =>
    fn.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body))).filter((b) => b.type === "userNonFundingLedgerUpdates");

  it("asks the ledger from just after the cursor and returns only capital flows, oldest first", async () => {
    const fetchImpl = router({
      ledger: [
        entry({ type: "deposit", usdc: "100" }, 2000, "0xa"),
        entry({ type: "liquidation" }, 2500, "0xb"),
        entry({ type: "withdraw", usdc: "40", fee: "1" }, 3000, "0xc"),
      ],
    });
    const flows = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getCapitalFlows(ME, 1500);

    expect(ledgerBodies(fetchImpl)[0]).toEqual({ type: "userNonFundingLedgerUpdates", user: ME, startTime: 1501 });
    expect(flows.map((f) => [f.id, f.timeMs, f.amountUsd.toString()])).toEqual([
      ["0xa", 2000, "100"],
      ["0xc", 3000, "-41"],
    ]);
  });

  it("pages through a long ledger (the API returns at most 2000 entries per call)", async () => {
    const full = Array.from({ length: 2000 }, (_, i) => entry({ type: "deposit", usdc: "1" }, 10_000 + i, `0x${i}`));
    const fetchImpl = router({ ledger: (call) => (call === 1 ? full : [entry({ type: "deposit", usdc: "5" }, 50_000, "0xlast")]) });
    const flows = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getCapitalFlows(ME, 0);

    expect(ledgerBodies(fetchImpl)).toHaveLength(2);
    expect(ledgerBodies(fetchImpl)[1].startTime).toBe(10_000 + 1999 + 1);
    expect(flows).toHaveLength(2001);
  });

  it("throws on an error response so a failed read never looks like 'no flows'", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" }) as Response);
    await expect(new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getCapitalFlows(ME, 0)).rejects.toThrow("429");
  });
});

describe("mapLedgerUpdate - a unified account (spot and perps are one balance)", () => {
  const unified = (update: RawLedgerUpdate) => mapLedgerUpdate(update, ME, "unified")?.amountUsd.toString() ?? null;

  it("ignores a spot <-> perps transfer, which moves nothing in a single combined balance", () => {
    expect(unified(entry({ type: "accountClassTransfer", usdc: "250", toPerp: true }))).toBeNull();
    expect(unified(entry({ type: "accountClassTransfer", usdc: "250", toPerp: false }))).toBeNull();
  });

  it("still counts deposits, withdrawals, vaults and transfers to or from other accounts", () => {
    expect(unified(entry({ type: "deposit", usdc: "898.99" }))).toBe("898.99");
    expect(unified(entry({ type: "withdraw", usdc: "87.0", fee: "1.0" }))).toBe("-88");
    expect(unified(entry({ type: "vaultDeposit", usdc: "100.0" }))).toBe("-100");
    expect(unified(entry({ type: "subAccountTransfer", usdc: "50", user: ME, destination: OTHER }))).toBe("-50");
  });

  it("judges a send only by who the other party is, whichever balance it came from", () => {
    const base = { type: "send", token: "USDC", amount: "10", usdcValue: "10", fee: "0.5" };
    expect(unified(entry({ ...base, user: ME, destination: OTHER, sourceDex: "spot", destinationDex: "" }))).toBe("-10.5");
    expect(unified(entry({ ...base, user: ME, destination: OTHER, sourceDex: "", destinationDex: "spot" }))).toBe("-10.5");
    expect(unified(entry({ ...base, user: OTHER, destination: ME, sourceDex: "", destinationDex: "spot" }))).toBe("10");
    expect(unified(entry({ ...base, user: ME, destination: ME, sourceDex: "spot", destinationDex: "" }))).toBeNull();
  });

  it("counts a token sent to someone else at its USDC value, and ignores a worthless one", () => {
    const base = { type: "spotTransfer", token: "HYPE", amount: "10", fee: "0.0" };
    expect(unified(entry({ ...base, usdcValue: "450.5", user: ME, destination: OTHER }))).toBe("-450.5");
    expect(unified(entry({ ...base, usdcValue: "0.0", user: ME, destination: OTHER }))).toBeNull();
  });
});

describe("HyperliquidInfoClient - unified accounts", () => {
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as Response;
  const PERPS_ZERO = { marginSummary: { accountValue: "0.0", totalMarginUsed: "0.0", totalNtlPos: "0.0" }, withdrawable: "0.0", assetPositions: [], time: 123 };

  function venue(opts: { mode: unknown; portfolio?: unknown }) {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === "userAbstraction") return response(opts.mode);
      if (body.type === "portfolio") return response(opts.portfolio ?? []);
      return response(PERPS_ZERO);
    });
  }
  const portfolioOf = (...values: string[]) => [
    ["day", { accountValueHistory: values.map((v, i) => [1000 + i, v]) }],
    ["perpDay", { accountValueHistory: [[1000, "0.0"]] }],
  ];

  it("reads a unified account's equity from Hyperliquid's own portfolio figure, not the perps view that shows 0", async () => {
    const fetchImpl = venue({ mode: "unifiedAccount", portfolio: portfolioOf("880.5", "898.999373") });
    const state = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getClearinghouseState(ME);
    expect(state.accountValue.toString()).toBe("898.999373");
    expect(state.accountMode).toBe("unified");
  });

  it("treats portfolio margin the same way", async () => {
    const fetchImpl = venue({ mode: "portfolioMargin", portfolio: portfolioOf("1500") });
    expect((await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getClearinghouseState(ME)).accountValue.toString()).toBe("1500");
  });

  it("keeps the perps value for a standard account and does not ask for the portfolio", async () => {
    const fetchImpl = venue({ mode: "default", portfolio: portfolioOf("999") });
    const state = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getClearinghouseState(ME);
    expect(state.accountValue.toString()).toBe("0");
    expect(state.accountMode).toBe("standard");
    expect(fetchImpl.mock.calls.some((c) => JSON.parse(String((c[1] as RequestInit).body)).type === "portfolio")).toBe(false);
  });

  it("falls back to the perps value when a unified account has no portfolio history yet", async () => {
    const fetchImpl = venue({ mode: "unifiedAccount", portfolio: [["day", { accountValueHistory: [] }]] });
    expect((await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getClearinghouseState(ME)).accountValue.toString()).toBe("0");
  });

  it("asks for the account mode once and remembers it", async () => {
    const fetchImpl = venue({ mode: "unifiedAccount", portfolio: portfolioOf("5") });
    const client = new HyperliquidInfoClient({ fetchImpl: fetchImpl as any });
    await client.getClearinghouseState(ME);
    await client.getClearinghouseState(ME);
    const modeCalls = fetchImpl.mock.calls.filter((c) => JSON.parse(String((c[1] as RequestInit).body)).type === "userAbstraction");
    expect(modeCalls).toHaveLength(1);
  });

  it("reads the ledger with the unified rules for a unified account", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.type === "userAbstraction") return response("unifiedAccount");
      return response([
        entry({ type: "accountClassTransfer", usdc: "500", toPerp: true }, 2000, "0xa"),
        entry({ type: "deposit", usdc: "898.99" }, 3000, "0xb"),
      ]);
    });
    const flows = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getCapitalFlows(ME, 0);
    expect(flows.map((f) => [f.id, f.amountUsd.toString()])).toEqual([["0xb", "898.99"]]);
  });
});

describe("HyperliquidInfoClient.getApprovedAgents", () => {
  const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as Response;

  it("lists the agent wallets approved for the account, lowercased, skipping expired approvals", async () => {
    const fetchImpl = vi.fn(async () =>
      response([
        { name: "Propguard", address: "0x761B7b7565713a2D26cd34383a3880F9dBD098Ab", validUntil: Date.now() + 86_400_000 },
        { name: "Old", address: "0xAAAA000000000000000000000000000000000001", validUntil: Date.now() - 1000 },
        { name: "No expiry", address: "0xBBBB000000000000000000000000000000000002" },
      ]),
    );
    const agents = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getApprovedAgents(ME);
    expect(agents).toEqual(["0x761b7b7565713a2d26cd34383a3880f9dbd098ab", "0xbbbb000000000000000000000000000000000002"]);
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)).toEqual({ type: "extraAgents", user: ME });
  });

  it("returns an empty list when the account has none", async () => {
    const fetchImpl = vi.fn(async () => response([]));
    expect(await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getApprovedAgents(ME)).toEqual([]);
  });
});
