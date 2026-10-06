import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";
import { HyperliquidEnforcer, formatCloseSize, formatCloseTargetPrice } from "../src/enforcer.js";
import { HyperliquidInfoClient, mapOpenOrder } from "../src/infoClient.js";

const SIGNATURE = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as `0x${string}`;

const META = { universe: [{ name: "BTC", szDecimals: 5 }, { name: "ETH", szDecimals: 4 }, { name: "SOL", szDecimals: 2 }] };
const MIDS = { BTC: "86641.5", ETH: "3000.25", SOL: "142.375" };

function build(opts: { exchangeResponse?: unknown; exchangeStatus?: number; slippageBps?: number } = {}) {
  const exchangeBodies: any[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).includes("/info")) {
      return { ok: true, status: 200, json: async () => (body.type === "meta" ? META : MIDS), text: async () => "" } as Response;
    }
    exchangeBodies.push(body);
    return {
      ok: (opts.exchangeStatus ?? 200) < 400,
      status: opts.exchangeStatus ?? 200,
      json: async () => opts.exchangeResponse ?? { status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 77 } }] } } },
      text: async () => "boom",
    } as Response;
  });
  const signTypedData = vi.fn(async () => SIGNATURE);
  const enforcer = new HyperliquidEnforcer({
    privyClient: { signTypedData } as any,
    walletId: "wallet_1",
    isTestnet: true,
    slippageBps: opts.slippageBps,
    infoUrl: "https://hl.test/info",
    exchangeClientOptions: { baseUrl: "https://hl.test/exchange", fetchImpl: fetchImpl as any },
    fetchImpl: fetchImpl as any,
  });
  return { enforcer, exchangeBodies, signTypedData, fetchImpl };
}

describe("formatCloseSize", () => {
  it("rounds down to the asset's size decimals, so it never closes more than asked", () => {
    expect(formatCloseSize(new Decimal("0.123456789"), 5)).toBe("0.12345");
    expect(formatCloseSize(new Decimal("4"), 2)).toBe("4");
    expect(formatCloseSize(new Decimal("1.999"), 2)).toBe("1.99");
  });
  it("returns null when nothing is left after rounding", () => {
    expect(formatCloseSize(new Decimal("0.000004"), 5)).toBeNull();
    expect(formatCloseSize(new Decimal("0"), 5)).toBeNull();
  });
});

describe("formatCloseTargetPrice", () => {
  it("prices a buy above the mid and a sell below it, rounded in the aggressive direction", () => {
    // BTC: szDecimals 5 => at most 1 decimal and 5 significant figures
    expect(formatCloseTargetPrice(new Decimal("86641.5"), true, 500, 5)).toBe("90974"); // 90973.575 -> 5 sig figs, rounded up
    expect(formatCloseTargetPrice(new Decimal("86641.5"), false, 500, 5)).toBe("82309"); // 82309.425 -> 5 sig figs, down
  });
  it("respects the decimals Hyperliquid allows for a low-priced coin", () => {
    // SOL: szDecimals 2 => at most 4 decimals, 5 significant figures
    expect(formatCloseTargetPrice(new Decimal("142.375"), true, 500, 2)).toBe("149.5");
    expect(formatCloseTargetPrice(new Decimal("0.123456"), false, 500, 0)).toBe("0.11728");
  });
  it("never produces a buy price below the mid or a sell price above it, whatever the rounding", () => {
    for (const mid of ["0.00012345", "1.2345", "98765.4321", "250000.5"]) {
      const m = new Decimal(mid);
      expect(new Decimal(formatCloseTargetPrice(m, true, 100, 3)).gte(m)).toBe(true);
      expect(new Decimal(formatCloseTargetPrice(m, false, 100, 3)).lte(m)).toBe(true);
    }
  });
});

describe("HyperliquidEnforcer.reduceOnlyClose", () => {
  it("places a reduce-only immediate-or-cancel order for the right asset, side, size and price, signed by the account's wallet", async () => {
    const { enforcer, exchangeBodies, signTypedData } = build();
    const result = await enforcer.reduceOnlyClose({ coin: "ETH", isBuy: false, size: new Decimal("1.23456") });

    expect(exchangeBodies).toHaveLength(1);
    const body = exchangeBodies[0];
    expect(body.action.type).toBe("order");
    const order = body.action.orders[0];
    expect(order).toMatchObject({ a: 1, b: false, s: "1.2345", r: true, t: { limit: { tif: "Ioc" } } });
    expect(Number(order.p)).toBeLessThan(3000.25); // a sell is priced below the mid so it fills
    expect(signTypedData).toHaveBeenCalledWith("wallet_1", expect.anything());
    expect(body.signature).toEqual({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 });
    expect(result.detail).toContain("sell 1.2345 ETH reduce-only IOC");
  });

  it("buys back a short with a buy priced above the mid", async () => {
    const { enforcer, exchangeBodies } = build();
    await enforcer.reduceOnlyClose({ coin: "BTC", isBuy: true, size: new Decimal("0.5") });
    const order = exchangeBodies[0].action.orders[0];
    expect(order).toMatchObject({ a: 0, b: true, r: true });
    expect(Number(order.p)).toBeGreaterThan(86641.5);
  });

  it("does nothing, and sends nothing, when the size rounds to zero", async () => {
    const { enforcer, exchangeBodies } = build();
    const result = await enforcer.reduceOnlyClose({ coin: "BTC", isBuy: false, size: new Decimal("0.000001") });
    expect(exchangeBodies).toHaveLength(0);
    expect(result.detail).toContain("nothing to close");
  });

  it("fails loudly when Hyperliquid rejects the order, so the watcher records it and retries", async () => {
    const { enforcer } = build({
      exchangeResponse: { status: "ok", response: { type: "order", data: { statuses: [{ error: "Reduce only order would increase position." }] } } },
    });
    await expect(enforcer.reduceOnlyClose({ coin: "ETH", isBuy: false, size: new Decimal("1") })).rejects.toThrow("increase position");
  });

  it("fails on an unknown asset instead of guessing an index", async () => {
    const { enforcer } = build();
    await expect(enforcer.reduceOnlyClose({ coin: "NOPE", isBuy: false, size: new Decimal("1") })).rejects.toThrow("Unknown Hyperliquid asset");
  });

  it("can never be made to open a position: every order it builds is reduce-only", async () => {
    const { enforcer, exchangeBodies } = build();
    for (const isBuy of [true, false]) await enforcer.reduceOnlyClose({ coin: "SOL", isBuy, size: new Decimal("5") });
    expect(exchangeBodies.every((b) => b.action.orders[0].r === true)).toBe(true);
  });

  it("reads the asset list once and reuses it", async () => {
    const { enforcer, fetchImpl } = build();
    await enforcer.reduceOnlyClose({ coin: "ETH", isBuy: false, size: new Decimal("1") });
    await enforcer.reduceOnlyClose({ coin: "ETH", isBuy: false, size: new Decimal("1") });
    const metaCalls = fetchImpl.mock.calls.filter(([, init]) => JSON.parse(String((init as RequestInit).body)).type === "meta");
    expect(metaCalls).toHaveLength(1);
  });
});

describe("HyperliquidEnforcer.cancelOrder", () => {
  it("sends a cancel for that asset and order id", async () => {
    const { enforcer, exchangeBodies } = build({ exchangeResponse: { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } } });
    await enforcer.cancelOrder("BTC", 566842483586);
    expect(exchangeBodies[0].action).toEqual({ type: "cancel", cancels: [{ a: 0, o: 566842483586 }] });
  });
});

describe("open orders", () => {
  it("maps Hyperliquid's frontendOpenOrders shape", () => {
    expect(mapOpenOrder({ coin: "BTC", side: "A", sz: "1.5855", oid: 566842483586, reduceOnly: false })).toEqual({
      coin: "BTC",
      oid: 566842483586,
      isBuy: false,
      size: new Decimal("1.5855"),
      reduceOnly: false,
    });
    expect(mapOpenOrder({ coin: "ETH", side: "B", sz: "2", oid: 1, reduceOnly: true })).toMatchObject({ isBuy: true, reduceOnly: true });
  });

  it("reads them through the info client", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ coin: "BTC", side: "B", sz: "0.1", oid: 5, reduceOnly: false }], text: async () => "" }) as Response);
    const orders = await new HyperliquidInfoClient({ fetchImpl: fetchImpl as any }).getOpenOrders("0xabc");
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)).toEqual({ type: "frontendOpenOrders", user: "0xabc" });
    expect(orders).toHaveLength(1);
  });
});
