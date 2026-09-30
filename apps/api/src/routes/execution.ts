import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { Decimal } from "decimal.js";
import { DecisionOutcome, OrderSide, type ProposedOrder } from "@mypropguard/domain";
import { recordVenueOrderId, releaseReservation, reserveOrder } from "@mypropguard/risk-ledger";
import { authorizeAndSignOrder, BlockedDecisionError } from "@mypropguard/execution";
import { resolveOrderSubmitterForAccount, resolveSignerForAccount, type AppDeps } from "../app.js";

const orderRequestSchema = z.object({
  clientIntentId: z.string().min(1),
  accountId: z.string().min(1),
  coin: z.string().min(1),
  side: z.enum([OrderSide.BUY, OrderSide.SELL]),
  size: z.string(),
  price: z.string(),
  reduceOnly: z.boolean().default(false),
});

function parseOrderRequest(body: unknown) {
  const parsed = orderRequestSchema.parse(body);
  const proposedOrder: ProposedOrder = {
    clientIntentId: parsed.clientIntentId,
    coin: parsed.coin,
    side: parsed.side,
    size: new Decimal(parsed.size),
    price: new Decimal(parsed.price),
    reduceOnly: parsed.reduceOnly,
  };
  return { accountId: parsed.accountId, proposedOrder };
}

export function registerExecutionRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * ALWAYS a true dry run, regardless of server config. Runs the real risk
   * engine + reservation, then - if not BLOCKed and a signer is configured -
   * the real canonicalize -> nonce lease -> exact-hash authorization -> sign
   * pipeline. Never calls orderSubmitter, even if the server has one
   * configured (ENABLE_VENUE_SUBMISSION). Safe for any UI to call on a
   * "check" or "preview" button without knowing or caring how the server
   * is configured - this route's name is a promise, not just a description.
   *
   * A previous version of this route did call orderSubmitter, making its
   * behavior depend on server config a caller couldn't see - the dashboard's
   * "Check order" button could have silently placed a real trade once
   * ENABLE_VENUE_SUBMISSION was ever turned on anywhere. Use POST
   * /v1/execution/submit for the endpoint that can actually reach a venue.
   */
  app.post("/v1/execution/dry-run", async (request, reply) => {
    if (!deps.executionSequencer || !deps.hasher) {
      return reply.status(501).send({
        error: "NOT_IMPLEMENTED",
        message: "No execution sequencer/hasher/signer configured for this server (Phase 3 scaffold not enabled).",
      });
    }

    let parsed;
    try {
      parsed = parseOrderRequest(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }
    const { accountId, proposedOrder } = parsed;

    const signer = await resolveSignerForAccount(deps, accountId);
    if (!signer) {
      return reply.status(501).send({
        error: "NOT_IMPLEMENTED",
        message: "No execution sequencer/hasher/signer configured for this server (Phase 3 scaffold not enabled).",
      });
    }

    const { decision, reservation } = await reserveOrder(deps.store, {
      accountId,
      proposedOrder,
      currentPositionSize: new Decimal(0),
    });

    if (decision.outcome === DecisionOutcome.BLOCK || !reservation) {
      return reply.send({
        mock: true,
        decision: { outcome: decision.outcome, reasonCode: decision.reasonCode, message: decision.message },
        mockSignedAction: null,
      });
    }

    try {
      const { signed } = await authorizeAndSignOrder(deps.executionSequencer, deps.hasher, signer, {
        accountId,
        proposedOrder,
        decision,
        reservation,
      });

      return reply.send({
        // Always true: this route never submits anywhere, regardless of
        // server config or which signer (fake or real) produced the signature.
        mock: true,
        decision: { outcome: decision.outcome, reasonCode: decision.reasonCode, message: decision.message },
        mockSignedAction: {
          connectionId: signed.authorization.connectionId,
          mockSignature: signed.signature,
          mockSignerAddress: signed.signerAddress,
          expiresAt: signed.authorization.expiresAt.toISOString(),
        },
        orderId: reservation.id,
      });
    } catch (error) {
      // Signing failed after the reservation already committed real budget
      // against this account - release it so a failed signature doesn't
      // permanently count as a real trade against the daily-loss/exposure budget.
      await releaseReservation(deps.store, accountId, reservation.id);

      if (error instanceof BlockedDecisionError) {
        return reply.status(409).send({ error: "BLOCKED" });
      }
      throw error;
    }
  });

  /**
   * The endpoint that can actually reach a venue. Same risk check +
   * reservation + sign pipeline as dry-run, then - only if orderSubmitter is
   * configured (ENABLE_VENUE_SUBMISSION) - submits and records the real
   * venue order id. Named for what it does: this one can move real money
   * when the server is configured for it. Any UI calling this must make
   * that unmistakable to whoever clicks the button.
   */
  app.post("/v1/execution/submit", async (request, reply) => {
    if (!deps.executionSequencer || !deps.hasher) {
      return reply.status(501).send({
        error: "NOT_IMPLEMENTED",
        message: "No execution sequencer/hasher/signer configured for this server (Phase 3 scaffold not enabled).",
      });
    }

    let parsed;
    try {
      parsed = parseOrderRequest(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }
    const { accountId, proposedOrder } = parsed;

    const signer = await resolveSignerForAccount(deps, accountId);
    if (!signer) {
      return reply.status(501).send({
        error: "NOT_IMPLEMENTED",
        message: "No execution sequencer/hasher/signer configured for this server (Phase 3 scaffold not enabled).",
      });
    }

    const { decision, reservation } = await reserveOrder(deps.store, {
      accountId,
      proposedOrder,
      currentPositionSize: new Decimal(0),
    });

    if (decision.outcome === DecisionOutcome.BLOCK || !reservation) {
      return reply.send({
        submitted: false,
        decision: { outcome: decision.outcome, reasonCode: decision.reasonCode, message: decision.message },
        signedAction: null,
        venueOrderId: null,
      });
    }

    try {
      const { signed, action } = await authorizeAndSignOrder(deps.executionSequencer, deps.hasher, signer, {
        accountId,
        proposedOrder,
        decision,
        reservation,
      });

      const orderSubmitter = await resolveOrderSubmitterForAccount(deps, accountId);
      let venueOrderId: string | null = null;
      if (orderSubmitter) {
        const submitted = await orderSubmitter.submit(signed, action);
        venueOrderId = submitted.venueOrderId;
        await recordVenueOrderId(deps.store, accountId, reservation.id, venueOrderId);
      }

      return reply.send({
        submitted: venueOrderId !== null,
        decision: { outcome: decision.outcome, reasonCode: decision.reasonCode, message: decision.message },
        signedAction: {
          connectionId: signed.authorization.connectionId,
          signature: signed.signature,
          signerAddress: signed.signerAddress,
          expiresAt: signed.authorization.expiresAt.toISOString(),
        },
        orderId: reservation.id,
        venueOrderId,
      });
    } catch (error) {
      // Signing or submission failed after the reservation already
      // committed real budget against this account - release it so a
      // failed signature or a rejected submission (signer refusal, network
      // error, expired authorization, venue rejection) doesn't permanently
      // count as a real trade against the daily-loss/exposure budget.
      await releaseReservation(deps.store, accountId, reservation.id);

      if (error instanceof BlockedDecisionError) {
        return reply.status(409).send({ error: "BLOCKED" });
      }
      throw error;
    }
  });
}
