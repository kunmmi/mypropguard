import { z } from "zod";
import { RuleType } from "@mypropguard/domain";
import { decimalString } from "./primitives.js";

const ruleTypeEnum = z.enum([
  RuleType.MAX_DAILY_LOSS,
  RuleType.MAX_DRAWDOWN,
  RuleType.MAX_LEVERAGE,
  RuleType.MAX_POSITION_SIZE,
  RuleType.MAX_EXPOSURE,
  RuleType.MAX_TRADE_FREQUENCY,
  RuleType.COOLDOWN,
]);

export const createAccountRequestSchema = z.object({
  accountId: z.string().min(1),
  ownerUserId: z.string().min(1),
  venue: z.string().min(1).default("hyperliquid"),
  initialEquity: decimalString,
  initialRules: z
    .array(
      z.object({
        ruleType: ruleTypeEnum,
        param: decimalString,
      }),
    )
    .default([]),
});
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

export const createAccountResponseSchema = z.object({
  accountId: z.string(),
  protectionOn: z.boolean(),
});
export type CreateAccountResponse = z.infer<typeof createAccountResponseSchema>;
