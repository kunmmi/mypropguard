import { describe, expect, it } from "vitest";
import { forwardingService, type LinkService } from "../src/oneClick/forwardingService.js";

describe("the link service that waits for the real one", () => {
  function rig() {
    const calls: Array<[string, unknown[]]> = [];
    const real: LinkService = {
      pair: async (...a) => void calls.push(["pair", a]),
      disconnect: async (...a) => void calls.push(["disconnect", a]),
      disconnectAccount: async (...a) => void calls.push(["disconnectAccount", a]),
    };
    return { calls, service: forwardingService(async () => real) };
  }

  it("passes the kind of link through, so a trading wallet link is not made a Safe link", async () => {
    const { service, calls } = rig();
    await service.pair("acct", "wc:abc", "float");
    await service.pair("acct", "wc:def");
    expect(calls).toEqual([
      ["pair", ["acct", "wc:abc", "float"]],
      ["pair", ["acct", "wc:def"]],
    ]);
  });

  it("passes the kind through when ending every link of one kind", async () => {
    const { service, calls } = rig();
    await service.disconnectAccount("acct", "float");
    await service.disconnectAccount("acct");
    await service.disconnect("topic-1");
    expect(calls).toEqual([
      ["disconnectAccount", ["acct", "float"]],
      ["disconnectAccount", ["acct"]],
      ["disconnect", ["topic-1"]],
    ]);
  });

  it("waits for the real service, and reports why when it is not available", async () => {
    const service = forwardingService(async () => {
      throw new Error("still starting");
    });
    await expect(service.pair("acct", "wc:x", "float")).rejects.toThrow("still starting");
  });
});
