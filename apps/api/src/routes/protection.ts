import type { FastifyInstance } from "fastify";
import {
  activateProtectionResponseSchema,
  deactivateProtectionResponseSchema,
  getProtectionResponseSchema,
  type ActivateProtectionResponse,
  type DeactivateProtectionResponse,
  type GetProtectionResponse,
} from "@mypropguard/contracts";
import { activateProtection, deactivateProtection, getProtectionStatus } from "@mypropguard/persistence";
import type { AppDeps } from "../app.js";

export function registerProtectionRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/v1/protection/:accountId", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const gate = await getProtectionStatus(deps.store, accountId);

    const response: GetProtectionResponse = {
      accountId,
      protectionOn: gate.protectionOn,
      botCanOpenNewTrades: gate.botCanOpenNewTrades,
      walletNeedsAttention: gate.walletNeedsAttention,
      blockingReason: gate.blockingReason,
      maxLossToday: gate.maxLossToday.toString(),
      lossUsedToday: gate.lossUsedToday.toString(),
      lastVerifiedAt: gate.lastVerifiedAt.toISOString(),
    };

    return reply.send(getProtectionResponseSchema.parse(response));
  });

  app.post("/v1/protection/activate", async (request, reply) => {
    const { accountId } = request.body as { accountId: string };
    const result = await activateProtection(deps.store, accountId);
    const response: ActivateProtectionResponse = { accountId, protectionOn: result.protectionOn };
    return reply.send(activateProtectionResponseSchema.parse(response));
  });

  app.post("/v1/protection/deactivate", async (request, reply) => {
    const { accountId } = request.body as { accountId: string };
    const result = await deactivateProtection(deps.store, accountId);
    const response: DeactivateProtectionResponse = {
      accountId,
      protectionOn: result.protectionOn,
      drainedOutstandingRisk: result.drainedOutstandingRisk,
    };
    return reply.send(deactivateProtectionResponseSchema.parse(response));
  });
}
