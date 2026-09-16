import { z } from "zod";
import { decimalString, isoDateTime } from "./primitives.js";

export const getProtectionResponseSchema = z.object({
  accountId: z.string(),
  protectionOn: z.boolean(),
  botCanOpenNewTrades: z.boolean(),
  walletNeedsAttention: z.boolean(),
  blockingReason: z.string().nullable(),
  maxLossToday: decimalString,
  lossUsedToday: decimalString,
  lastVerifiedAt: isoDateTime,
});
export type GetProtectionResponse = z.infer<typeof getProtectionResponseSchema>;

export const activateProtectionRequestSchema = z.object({
  accountId: z.string().min(1),
});
export type ActivateProtectionRequest = z.infer<typeof activateProtectionRequestSchema>;

export const activateProtectionResponseSchema = z.object({
  accountId: z.string(),
  protectionOn: z.boolean(),
});
export type ActivateProtectionResponse = z.infer<typeof activateProtectionResponseSchema>;

export const deactivateProtectionRequestSchema = z.object({
  accountId: z.string().min(1),
});
export type DeactivateProtectionRequest = z.infer<typeof deactivateProtectionRequestSchema>;

export const deactivateProtectionResponseSchema = z.object({
  accountId: z.string(),
  protectionOn: z.boolean(),
  drainedOutstandingRisk: z.boolean(),
});
export type DeactivateProtectionResponse = z.infer<typeof deactivateProtectionResponseSchema>;
