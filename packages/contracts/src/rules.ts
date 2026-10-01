import { z } from "zod";
import { decimalString, isoDateTime } from "./primitives.js";
import { ruleTypeEnum } from "./accounts.js";

export const ruleVersionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  ruleType: ruleTypeEnum,
  param: decimalString,
  /** Which ERC-20 token param limits per-trade spend in - only set for MAX_POSITION_SIZE on EVM spot venues. */
  tokenAddress: z.string().nullable().optional(),
  effectiveFrom: isoDateTime,
  isActive: z.boolean(),
  createdAt: isoDateTime,
});
export type RuleVersionResponse = z.infer<typeof ruleVersionSchema>;

export const listRulesResponseSchema = z.object({
  rules: z.array(ruleVersionSchema),
});
export type ListRulesResponse = z.infer<typeof listRulesResponseSchema>;

export const addRuleRequestSchema = z.object({
  ruleType: ruleTypeEnum,
  param: decimalString,
  /** Required when ruleType is MAX_POSITION_SIZE on an EVM spot venue (bsc-pancakeswap, ethereum-uniswap). */
  tokenAddress: z.string().min(1).optional(),
});
export type AddRuleRequest = z.infer<typeof addRuleRequestSchema>;

export const addRuleResponseSchema = z.object({
  rule: ruleVersionSchema,
});
export type AddRuleResponse = z.infer<typeof addRuleResponseSchema>;

export const deactivateRuleResponseSchema = z.object({
  ruleId: z.string(),
  isActive: z.literal(false),
});
export type DeactivateRuleResponse = z.infer<typeof deactivateRuleResponseSchema>;
