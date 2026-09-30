import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { Decimal } from "decimal.js";
import {
  cancelOrderRequestSchema,
  cancelOrderResponseSchema,
  createOrderRequestSchema,
  createOrderResponseSchema,
  getOrderResponseSchema,
  type CancelOrderResponse,
  type CreateOrderResponse,
  type GetOrderResponse,
} from "@mypropguard/contracts";
import { DecisionOutcome, OrderReservationStatus, type ProposedOrder } from "@mypropguard/domain";
import { releaseReservation, reserveOrder } from "@mypropguard/risk-ledger";
import {
  assertAccountOwnership,
  resolveOrderCancellerForAccount,
  resolveOrderLifecycleReaderForAccount,
  type AppDeps,
} from "../app.js";

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
    if (!(await assertAccountOwnership(deps, request, reply, body.accountId))) return;

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
    const { orderId } = cancelOrderRequestSchema.parse({ orderId: (request.params as { orderId: string }).orderId });

    const reservation = await deps.store.findReservationById(orderId);
    if (!reservation) {
      const response: CancelOrderResponse = { orderId, status: "NOT_FOUND", reasonCode: "RESERVATION_NOT_FOUND" };
      return reply.status(404).send(cancelOrderResponseSchema.parse(response));
    }
    if (!(await assertAccountOwnership(deps, request, reply, reservation.accountId))) return;

    if (reservation.status !== OrderReservationStatus.HELD) {
      const response: CancelOrderResponse = {
        orderId,
        status: "REJECTED",
        reasonCode: `ALREADY_${reservation.status}`,
      };
      return reply.status(409).send(cancelOrderResponseSchema.parse(response));
    }

    // Never reached a venue (blocked before submission, or the offline
    // scaffold) - nothing to cancel on-chain, just release the local hold.
    if (!reservation.venueOrderId) {
      await releaseReservation(deps.store, reservation.accountId, reservation.id);
      const response: CancelOrderResponse = { orderId, status: "CANCELED", reasonCode: "NEVER_SUBMITTED" };
      return reply.send(cancelOrderResponseSchema.parse(response));
    }

    const orderCanceller = await resolveOrderCancellerForAccount(deps, reservation.accountId);
    if (!orderCanceller) {
      return reply.status(501).send({
        error: "NOT_IMPLEMENTED",
        message: "No order canceller configured for this server (ENABLE_REAL_SIGNER not set).",
      });
    }

    try {
      await orderCanceller.cancelOrder(reservation.coin, reservation.venueOrderId);
    } catch {
      const response: CancelOrderResponse = { orderId, status: "REJECTED", reasonCode: "VENUE_REJECTED_CANCEL" };
      return reply.status(502).send(cancelOrderResponseSchema.parse(response));
    }

    await releaseReservation(deps.store, reservation.accountId, reservation.id);
    const response: CancelOrderResponse = { orderId, status: "CANCELED", reasonCode: "CANCELED_ON_VENUE" };
    return reply.send(cancelOrderResponseSchema.parse(response));
  });

  const getOrderQuerySchema = z.object({ venueAddress: z.string().min(1).optional() });

  app.get("/v1/orders/:orderId", async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const { venueAddress } = getOrderQuerySchema.parse(request.query);

    const reservation = await deps.store.findReservationById(orderId);
    if (!reservation) {
      return reply.status(404).send({ error: "NOT_FOUND", message: `No order found for id ${orderId}` });
    }
    if (!(await assertAccountOwnership(deps, request, reply, reservation.accountId))) return;

    // Every reservation that exists was created from an ALLOW/RESIZE
    // decision (reserveOrder never reserves for a BLOCK) - which of the two
    // isn't tracked post-creation, so "ACCEPTED" is the most specific
    // honest answer available from stored state alone.
    const base = { orderId: reservation.id, status: "ACCEPTED" as const, createdAt: reservation.createdAt.toISOString() };

    if (!reservation.venueOrderId) {
      const response: GetOrderResponse = { ...base, venueOrderId: null, venueClientOrderId: null, result: "PENDING" };
      return reply.send(getOrderResponseSchema.parse(response));
    }

    const orderLifecycleReader = await resolveOrderLifecycleReaderForAccount(deps, reservation.accountId);
    if (!orderLifecycleReader || !venueAddress) {
      const response: GetOrderResponse = {
        ...base,
        venueOrderId: reservation.venueOrderId,
        venueClientOrderId: reservation.clientIntentId,
        result: "OUTCOME_UNKNOWN",
      };
      return reply.send(getOrderResponseSchema.parse(response));
    }

    const liveStatus = await orderLifecycleReader.getOrderStatus(venueAddress, reservation.venueOrderId);
    const response: GetOrderResponse = {
      ...base,
      venueOrderId: reservation.venueOrderId,
      venueClientOrderId: reservation.clientIntentId,
      result: liveStatus.status === "UNKNOWN" ? "OUTCOME_UNKNOWN" : "COMMITTED",
    };
    return reply.send(getOrderResponseSchema.parse(response));
  });
}
