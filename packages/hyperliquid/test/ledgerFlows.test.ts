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

  it("asks the ledger from just after the cursor and returns only capital flows, oldest first", async () => {
    const fetchImpl = vi.fn(async () =>
      response([
        entry({ type: "deposit", usdc: "100" }, 2000, "0xa"),
        entry({ type: "liquidation" }, 2500, "0xb"),
        entry({ type: "withdraw", usdc: "40", fee: "1" }, 3000, "0xc"),
      ]),
    );
    const flows = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getCapitalFlows(ME, 1500);

    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    expect(body).toEqual({ type: "userNonFundingLedgerUpdates", user: ME, startTime: 1501 });
    expect(flows.map((f) => [f.id, f.timeMs, f.amountUsd.toString()])).toEqual([
      ["0xa", 2000, "100"],
      ["0xc", 3000, "-41"],
    ]);
  });

  it("pages through a long ledger (the API returns at most 2000 entries per call)", async () => {
    const full = Array.from({ length: 2000 }, (_, i) => entry({ type: "deposit", usdc: "1" }, 10_000 + i, `0x${i}`));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(full))
      .mockResolvedValueOnce(response([entry({ type: "deposit", usdc: "5" }, 50_000, "0xlast")]));
    const flows = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getCapitalFlows(ME, 0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchImpl.mock.calls[1] as any)[1].body).startTime).toBe(10_000 + 1999 + 1);
    expect(flows).toHaveLength(2001);
  });

  it("throws on an error response so a failed read never looks like 'no flows'", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "rate limited" }) as Response);
    await expect(new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getCapitalFlows(ME, 0)).rejects.toThrow("429");
  });
});
