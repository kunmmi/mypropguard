import { z } from "zod";
import { DecisionOutcome, RuleType } from "@mypropguard/domain";
import { decimalString, isoDateTime } from "./primitives.js";

export const decisionArtifactSchema = z.object({
  outcome: z.enum([DecisionOutcome.ALLOW, DecisionOutcome.RESIZE, DecisionOutcome.BLOCK]),
  approvedSize: decimalString.nullable(),
  reasonCode: z.string(),
  message: z.string(),
  ruleType: z
    .enum([
      RuleType.MAX_DAILY_LOSS,
      RuleType.MAX_DRAWDOWN,
      RuleType.MAX_LEVERAGE,
      RuleType.MAX_POSITION_SIZE,
      RuleType.MAX_EXPOSURE,
      RuleType.MAX_TRADE_FREQUENCY,
      RuleType.COOLDOWN,
    ])
    .nullable(),
  evaluatedAt: isoDateTime,
});
export type DecisionArtifactDto = z.infer<typeof decisionArtifactSchema>;

export const protectionGateResultSchema = z.object({
  protectionOn: z.boolean(),
  botCanOpenNewTrades: z.boolean(),
  walletNeedsAttention: z.boolean(),
  blockingReason: z.string().nullable(),
  maxLossToday: decimalString,
  lossUsedToday: decimalString,
  lastVerifiedAt: isoDateTime,
});
export type ProtectionGateResultDto = z.infer<typeof protectionGateResultSchema>;

/**
 * Structural placeholder for the Phase 3 exact-hash authorization object.
 * Not wired to a real signer in Phase 0/1 — defined now so the contract is
 * frozen and downstream packages can compile against it.
 */
export const actionAuthorizationSchema = z.object({
  reservationId: z.string(),
  accountId: z.string(),
  canonicalActionHash: z.string().nullable(),
  issuedAt: isoDateTime,
  expiresAt: isoDateTime,
});
export type ActionAuthorizationDto = z.infer<typeof actionAuthorizationSchema>;
