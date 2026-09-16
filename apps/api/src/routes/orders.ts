import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Decimal } from "decimal.js";
import {
  cancelOrderRequestSchema,
  createOrderRequestSchema,
  createOrderResponseSchema,
  type CreateOrderResponse,
} from "@mypropguard/contracts";
import { DecisionOutcome, type ProposedOrder } from "@mypropguard/domain";
import { reserveOrder } from "@mypropguard/persistence";
import type { AppDeps } from "../app.js";

function outcomeToStatus(outcome: string): CreateOrderResponse["status"] {
  if (outcome === DecisionOutcome.ALLOW) return "ACCEPTED";
  if (outcome === DecisionOutcome.RESIZE) return "RESIZED";
  return "BLOCKED";
}

export function registerOrderRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/v1/orders", async (request, reply) => {
    let body;
    try {
      body = createOrderRequestSchema.parse(request.body);
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

    // Phase 0/1 has no live position feed yet (Phase 2): every account is
    // projected as flat. Sizeable-rule caps still apply correctly against
    // openNotional; only per-coin reduce/flip classification is unavailable
    // until real position state exists.
    const { decision, reservation } = await reserveOrder(deps.store, {
      accountId: body.accountId,
      proposedOrder,
      currentPositionSize: new Decimal(0),
    });

    const status = outcomeToStatus(decision.outcome);
    const response: CreateOrderResponse = {
      orderId: reservation?.id ?? `blocked_${body.clientIntentId}`,
      status,
      approvedSize: decision.approvedSize ? decision.approvedSize.toString() : status === "ACCEPTED" ? body.size : null,
      reasonCode: decision.reasonCode,
      message: decision.message,
      protection: {
        protectionOn: true,
        botCanOpenNewTrades: status !== "BLOCKED",
      },
    };

    return reply.send(createOrderResponseSchema.parse(response));
  });

  app.post("/v1/orders/:orderId/cancel", async (request, reply) => {
    cancelOrderRequestSchema.parse({ orderId: (request.params as { orderId: string }).orderId });
    // Cancelling a live venue order requires Phase 2/3 execution/reconciliation.
    return reply.status(501).send({
      error: "NOT_IMPLEMENTED",
      message: "Order cancellation requires live venue execution (Phase 2/3), not yet built.",
    });
  });

  app.get("/v1/orders/:orderId", async (_request, reply) => {
    // Order lifecycle/venue state tracking requires Phase 2/3 execution.
    return reply.status(501).send({
      error: "NOT_IMPLEMENTED",
      message: "Order status tracking requires live venue execution (Phase 2/3), not yet built.",
    });
  });
}
