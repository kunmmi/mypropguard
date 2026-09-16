import { z } from "zod";
import { OrderSide } from "@mypropguard/domain";
import { decimalString, isoDateTime } from "./primitives.js";

const orderSide = z.enum([OrderSide.BUY, OrderSide.SELL]);

export const createOrderRequestSchema = z.object({
  clientIntentId: z.string().min(1),
  accountId: z.string().min(1),
  coin: z.string().min(1),
  side: orderSide,
  size: decimalString,
  price: decimalString,
  orderStyle: z.enum(["MARKET", "LIMIT"]),
  reduceOnly: z.boolean().default(false),
  protectiveExit: z
    .object({
      stopPrice: decimalString,
    })
    .nullable()
    .default(null),
});
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

export const orderResultStatus = z.enum(["ACCEPTED", "RESIZED", "BLOCKED", "PENDING"]);

export const createOrderResponseSchema = z.object({
  orderId: z.string(),
  status: orderResultStatus,
  approvedSize: decimalString.nullable(),
  reasonCode: z.string(),
  message: z.string(),
  protection: z.object({
    protectionOn: z.boolean(),
    botCanOpenNewTrades: z.boolean(),
  }),
});
export type CreateOrderResponse = z.infer<typeof createOrderResponseSchema>;

export const cancelOrderRequestSchema = z.object({
  orderId: z.string().min(1),
});
export type CancelOrderRequest = z.infer<typeof cancelOrderRequestSchema>;

export const cancelOrderResponseSchema = z.object({
  orderId: z.string(),
  status: z.enum(["CANCELED", "NOT_FOUND", "REJECTED"]),
  reasonCode: z.string(),
});
export type CancelOrderResponse = z.infer<typeof cancelOrderResponseSchema>;

export const getOrderResponseSchema = z.object({
  orderId: z.string(),
  status: orderResultStatus,
  venueOrderId: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  result: z.enum(["PENDING", "COMMITTED", "OUTCOME_UNKNOWN"]),
  createdAt: isoDateTime,
});
export type GetOrderResponse = z.infer<typeof getOrderResponseSchema>;
