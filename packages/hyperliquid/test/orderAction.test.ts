import { describe, expect, it } from "vitest";
import { buildOrderAction } from "../src/orderAction.js";

describe("buildOrderAction", () => {
  it("builds fields in the exact order Hyperliquid's schema expects (order-sensitive for hashing)", () => {
    const action = buildOrderAction({
      assetIndex: 5,
      isBuy: true,
      price: "1234.5",
      size: "0.25",
      reduceOnly: true,
      tif: "Ioc",
    });

    expect(Object.keys(action)).toEqual(["type", "orders", "grouping"]);
    const order = (action.orders as Record<string, unknown>[])[0]!;
    expect(Object.keys(order)).toEqual(["a", "b", "p", "s", "r", "t"]);
    expect(order).toEqual({
      a: 5,
      b: true,
      p: "1234.5",
      s: "0.25",
      r: true,
      t: { limit: { tif: "Ioc" } },
    });
  });

  it("appends cloid last when provided", () => {
    const action = buildOrderAction({
      assetIndex: 0,
      isBuy: false,
      price: "1",
      size: "1",
      reduceOnly: false,
      tif: "Gtc",
      cloid: "0xabc0000000000000000000000000000000",
    });

    const order = (action.orders as Record<string, unknown>[])[0]!;
    expect(Object.keys(order)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
  });

  it("never uses JS numbers for price/size (precision)", () => {
    const action = buildOrderAction({
      assetIndex: 0,
      isBuy: true,
      price: "0.1",
      size: "0.30000000000000004", // classic float-imprecision trap
      reduceOnly: false,
      tif: "Gtc",
    });

    const order = (action.orders as Record<string, unknown>[])[0]!;
    expect(typeof order.p).toBe("string");
    expect(typeof order.s).toBe("string");
    expect(order.s).toBe("0.30000000000000004");
  });
});
