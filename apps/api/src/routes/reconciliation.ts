import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { EvmAccountNotFoundError, reconcileAccountFromVenue, reconcileEvmAccountEquity } from "@mypropguard/risk-ledger";
import { assertAccountOwnership, type AppDeps } from "../app.js";

const reconcileRequestSchema = z.object({ venueAddress: z.string().min(1) });

export function registerReconciliationRoutes(app: FastifyInstance, deps: AppDeps): void {
  // The EVM-chain equivalent of /reconcile below - no venueAddress needed, since the account's
  // own evmSafeAddress/evmChainId already say what to read and where.
  app.post("/v1/accounts/:accountId/reconcile-evm", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;

    let head;
    try {
      head = await reconcileEvmAccountEquity(
        deps.store,
        deps.evmEquityReaders,
        deps.evmGuardSyncers,
        accountId,
        { stateReaders: deps.evmStateReaders, tokenDiscoveries: deps.evmTokenDiscoveries },
      );
    } catch (error) {
      if (error instanceof EvmAccountNotFoundError) {
        return reply.status(501).send({ error: "NOT_IMPLEMENTED", message: error.message });
      }
      throw error;
    }

    return reply.send({
      accountId: head.accountId,
      currentEquity: head.currentEquity.toString(),
      peakEquity: head.peakEquity.toString(),
    });
  });

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
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;

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
