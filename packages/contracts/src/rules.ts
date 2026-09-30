import { z } from "zod";
import { decimalString, isoDateTime } from "./primitives.js";
import { ruleTypeEnum } from "./accounts.js";

export const ruleVersionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  ruleType: ruleTypeEnum,
  param: decimalString,
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
