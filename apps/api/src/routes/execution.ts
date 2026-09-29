import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { Decimal } from "decimal.js";
import { DecisionOutcome, OrderSide, type ProposedOrder } from "@mypropguard/domain";
import { releaseReservation, reserveOrder } from "@mypropguard/risk-ledger";
import { authorizeAndSignOrder, BlockedDecisionError } from "@mypropguard/execution";
import type { AppDeps } from "../app.js";

const dryRunRequestSchema = z.object({
  clientIntentId: z.string().min(1),
  accountId: z.string().min(1),
  coin: z.string().min(1),
  side: z.enum([OrderSide.BUY, OrderSide.SELL]),
  size: z.string(),
  price: z.string(),
  reduceOnly: z.boolean().default(false),
});

/**
 * PHASE 3 SCAFFOLD — NOT REAL EXECUTION.
 *
 * Runs the real risk engine + reservation, then (if not BLOCKed) the
 * canonicalize -> nonce lease -> exact-hash authorization -> sign pipeline
 * against a FAKE signer with a PLACEHOLDER hash. Nothing here is submitted
 * to Hyperliquid or any venue, and the "signature" cannot be used for
 * anything real. This exists to prove the pipeline shape before a real
 * signer vendor and venue wire-format are wired in.
 */
export function registerExecutionRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/v1/execution/dry-run", async (request, reply) => {
    if (!deps.executionSequencer || !deps.signer || !deps.hasher) {
      return reply.status(501).send({
        error: "NOT_IMPLEMENTED",
        message: "No execution sequencer/hasher/signer configured for this server (Phase 3 scaffold not enabled).",
      });
    }

    let body;
    try {
      body = dryRunRequestSchema.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }

    const proposedOrder: ProposedOrder = {
      clientIntentId: body.clientIntentId,
      coin: body.coin,
      side: body.side,
      size: new Decimal(body.size),
      price: new Decimal(body.price),
      reduceOnly: body.reduceOnly,
    };

    const { decision, reservation } = await reserveOrder(deps.store, {
      accountId: body.accountId,
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
      const signed = await authorizeAndSignOrder(deps.executionSequencer, deps.hasher, deps.signer, {
        accountId: body.accountId,
        proposedOrder,
        decision,
        reservation,
      });

      return reply.send({
        mock: true,
        decision: { outcome: decision.outcome, reasonCode: decision.reasonCode, message: decision.message },
        mockSignedAction: {
          connectionId: signed.authorization.connectionId,
          mockSignature: signed.signature,
          mockSignerAddress: signed.signerAddress,
          expiresAt: signed.authorization.expiresAt.toISOString(),
        },
      });
    } catch (error) {
      // Signing failed after the reservation already committed real budget
      // against this account - release it so a failed signature (signer
      // refusal, network error, expired authorization) doesn't permanently
      // count as a real trade against the daily-loss/exposure budget.
      await releaseReservation(deps.store, body.accountId, reservation.id);

      if (error instanceof BlockedDecisionError) {
        return reply.status(409).send({ error: "BLOCKED" });
      }
      throw error;
    }
  });
}
