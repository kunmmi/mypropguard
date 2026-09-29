import { describe, expect, it } from "vitest";
import { InMemoryExecutionSequencer } from "../src/fake.js";

describe("InMemoryExecutionSequencer", () => {
  it("leases nonces close to the current timestamp, not a small sequential counter", async () => {
    const sequencer = new InMemoryExecutionSequencer();
    const before = Date.now();
    const lease = await sequencer.leaseNonce("acct_1");
    const after = Date.now();

    // Would have failed against the old 1/2/3 counter scheme - confirmed for
    // real that Hyperliquid rejects that outright ("nonce too low").
    expect(lease.nonce).toBeGreaterThanOrEqual(before);
    expect(lease.nonce).toBeLessThanOrEqual(after);
  });

  it("never issues a nonce lower than the previous one for the same account, even called faster than 1ms apart", async () => {
    const sequencer = new InMemoryExecutionSequencer();
    const leases = await Promise.all(Array.from({ length: 50 }, () => sequencer.leaseNonce("acct_2")));
    const nonces = leases.map((l) => l.nonce);

    for (let i = 1; i < nonces.length; i++) {
      expect(nonces[i]).toBeGreaterThan(nonces[i - 1]!);
    }
  });

  it("tracks nonces independently per account", async () => {
    const sequencer = new InMemoryExecutionSequencer();
    const a1 = await sequencer.leaseNonce("acct_a");
    const b1 = await sequencer.leaseNonce("acct_b");
    const a2 = await sequencer.leaseNonce("acct_a");

    expect(a2.nonce).toBeGreaterThan(a1.nonce);
    // acct_b's first lease isn't forced above acct_a's - they're independent sequences.
    expect(b1.accountId).toBe("acct_b");
  });
});
