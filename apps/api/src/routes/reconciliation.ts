import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { reconcileAccountFromVenue } from "@mypropguard/persistence";
import type { AppDeps } from "../app.js";

const reconcileRequestSchema = z.object({ venueAddress: z.string().min(1) });

export function registerReconciliationRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/v1/accounts/:accountId/reconcile", async (request, reply) => {
    if (!deps.venueReader) {
      return reply.status(501).send({
        error: "NOT_IMPLEMENTED",
        message: "No venue reader configured for this server.",
      });
    }

    let body;
    try {
      body = reconcileRequestSchema.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }

    const { accountId } = request.params as { accountId: string };
    const { head } = await reconcileAccountFromVenue(deps.store, deps.venueReader, {
      accountId,
      venueAddress: body.venueAddress,
    });

    return reply.send({
      accountId: head.accountId,
      currentEquity: head.currentEquity.toString(),
      openNotional: head.openNotional.toString(),
      leverage: head.leverage.toString(),
      peakEquity: head.peakEquity.toString(),
    });
  });
}
