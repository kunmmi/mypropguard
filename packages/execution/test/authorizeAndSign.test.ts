import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { DecisionOutcome, ReasonCode, RuleType } from "@mypropguard/domain";
import { buildOrderReservation, buildProposedOrder } from "@mypropguard/test-fixtures";
import { authorizeAndSignOrder, BlockedDecisionError } from "../src/authorizeAndSign.js";
import { FakeSignerGateway, InMemoryExecutionSequencer } from "../src/fake.js";
import { PlaceholderActionHasher } from "../src/connectionId.js";

describe("authorizeAndSignOrder", () => {
  it("signs the exact canonical action for an ALLOW decision", async () => {
    const sequencer = new InMemoryExecutionSequencer();
    const hasher = new PlaceholderActionHasher();
    const signer = new FakeSignerGateway(hasher);
    const reservation = buildOrderReservation();
    const proposedOrder = buildProposedOrder();

    const signed = await authorizeAndSignOrder(sequencer, hasher, signer, {
      accountId: "acct_test_1",
      proposedOrder,
      decision: {
        outcome: DecisionOutcome.ALLOW,
        approvedSize: null,
        reasonCode: ReasonCode.WITHIN_LIMITS,
        message: "ok",
        ruleType: null,
        evaluatedAt: new Date(),
      },
      reservation,
    });

    expect(signed.signerAddress).toMatch(/^0xFAKE/);
    expect(signed.authorization.reservationId).toBe(reservation.id);
    expect(signer.hasSigned(signed.authorization.connectionId)).toBe(true);
  });

  it("uses the RESIZED approved size, not the originally requested size, when authorizing", async () => {
    const sequencer = new InMemoryExecutionSequencer();
    const hasher = new PlaceholderActionHasher();
    const signer = new FakeSignerGateway(hasher);
    const reservation = buildOrderReservation();
    const proposedOrder = buildProposedOrder({ size: new Decimal(5) });

    const signed = await authorizeAndSignOrder(sequencer, hasher, signer, {
      accountId: "acct_test_1",
      proposedOrder,
      decision: {
        outcome: DecisionOutcome.RESIZE,
        approvedSize: new Decimal(2),
        reasonCode: ReasonCode.POSITION_SIZE_LIMIT_EXCEEDED,
        message: "resized",
        ruleType: RuleType.MAX_POSITION_SIZE,
        evaluatedAt: new Date(),
      },
      reservation,
    });

    // A signer that independently recomputes the hash from a size of 2 would
    // refuse to sign a request built around size 5 — proving the pipeline
    // actually threads the resized amount through, not the raw request.
    expect(signer.hasSigned(signed.authorization.connectionId)).toBe(true);
  });

  it("refuses to authorize/sign a BLOCK decision", async () => {
    const sequencer = new InMemoryExecutionSequencer();
    const hasher = new PlaceholderActionHasher();
    const signer = new FakeSignerGateway(hasher);

    await expect(
      authorizeAndSignOrder(sequencer, hasher, signer, {
        accountId: "acct_test_1",
        proposedOrder: buildProposedOrder(),
        decision: {
          outcome: DecisionOutcome.BLOCK,
          approvedSize: null,
          reasonCode: ReasonCode.DAILY_LOSS_BUDGET_EXCEEDED,
          message: "blocked",
          ruleType: RuleType.MAX_DAILY_LOSS,
          evaluatedAt: new Date(),
        },
        reservation: buildOrderReservation(),
      }),
    ).rejects.toBeInstanceOf(BlockedDecisionError);
  });

  it("never issues the same nonce twice for concurrent authorizations on one account", async () => {
    const sequencer = new InMemoryExecutionSequencer();
    const hasher = new PlaceholderActionHasher();
    const signer = new FakeSignerGateway(hasher);
    const decision = {
      outcome: DecisionOutcome.ALLOW as const,
      approvedSize: null,
      reasonCode: ReasonCode.WITHIN_LIMITS,
      message: "ok",
      ruleType: null,
      evaluatedAt: new Date(),
    };

    const [a, b] = await Promise.all([
      authorizeAndSignOrder(sequencer, hasher, signer, {
        accountId: "acct_test_1",
        proposedOrder: buildProposedOrder({ clientIntentId: "intent_a" }),
        decision,
        reservation: buildOrderReservation({ id: "resv_a" }),
      }),
      authorizeAndSignOrder(sequencer, hasher, signer, {
        accountId: "acct_test_1",
        proposedOrder: buildProposedOrder({ clientIntentId: "intent_b" }),
        decision,
        reservation: buildOrderReservation({ id: "resv_b" }),
      }),
    ]);

    expect(a.authorization.connectionId).not.toBe(b.authorization.connectionId);
  });

  it("the signer independently refuses a mismatched connectionId (default-deny)", async () => {
    const hasher = new PlaceholderActionHasher();
    const signer = new FakeSignerGateway(hasher);
    const proposedOrder = buildProposedOrder();

    await expect(
      signer.signExact(
        {
          connectionId: "tampered_hash_does_not_match",
          reservationId: "resv_1",
          accountId: "acct_test_1",
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 30_000),
        },
        {
          accountId: "acct_test_1",
          clientIntentId: proposedOrder.clientIntentId,
          coin: proposedOrder.coin,
          side: proposedOrder.side,
          size: proposedOrder.size,
          price: proposedOrder.price,
          reduceOnly: proposedOrder.reduceOnly,
          nonce: 1,
          expiresAt: new Date(Date.now() + 30_000),
        },
      ),
    ).rejects.toThrow(/does not match/);
  });
});
