import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Decimal } from "decimal.js";
import { RuleType } from "@mypropguard/domain";
import {
  addRuleRequestSchema,
  addRuleResponseSchema,
  deactivateRuleResponseSchema,
  listRulesResponseSchema,
  type AddRuleResponse,
  type DeactivateRuleResponse,
  type ListRulesResponse,
} from "@mypropguard/contracts";
import { addRule, deactivateRule, listRules } from "@mypropguard/risk-ledger";
import { assertAccountOwnership, type AppDeps } from "../app.js";

/** Rule types the EVM spot Guards (PancakeSwap/Uniswap) actually understand how to enforce on-chain. */
const EVM_SYNCABLE_RULE_TYPES: readonly string[] = [RuleType.MAX_POSITION_SIZE, RuleType.MAX_TRADE_FREQUENCY];

export function registerRuleRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/v1/accounts/:accountId/rules", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;

    const rules = await listRules(deps.store, accountId);

    const response: ListRulesResponse = {
      rules: rules.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        ruleType: r.ruleType,
        param: r.param.toString(),
        tokenAddress: r.tokenAddress,
        effectiveFrom: r.effectiveFrom.toISOString(),
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
      })),
    };
    return reply.send(listRulesResponseSchema.parse(response));
  });

  app.post("/v1/accounts/:accountId/rules", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;

    let body;
    try {
      body = addRuleRequestSchema.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }

    const account = await deps.store.findAccountById(accountId);
    const isEvmSafeAccount = Boolean(account?.evmSafeAddress && account.evmChainId != null);

    // The spot Guards' setTokenLimit is per-token - a MAX_POSITION_SIZE rule on an EVM Safe
    // account is meaningless without knowing which token it limits.
    if (body.ruleType === RuleType.MAX_POSITION_SIZE && isEvmSafeAccount && !body.tokenAddress) {
      return reply.status(400).send({
        error: "INVALID_REQUEST",
        message: "tokenAddress is required for MAX_POSITION_SIZE rules on an EVM Safe account.",
      });
    }

    const rule = await addRule(deps.store, accountId, body.ruleType, new Decimal(body.param), body.tokenAddress);

    // Push the change on-chain to the trader's own Guard, if one is configured for this account's
    // chain, so the limit is enforced no matter which interface they trade through - not just
    // MyPropGuard's own dashboard. Deactivates the rule we just created if the on-chain call fails,
    // so a rule the Guard never actually received can't sit there looking active.
    if (account?.evmSafeAddress && account.evmChainId != null && EVM_SYNCABLE_RULE_TYPES.includes(rule.ruleType)) {
      const syncer = deps.evmGuardSyncers?.[account.evmChainId];
      if (syncer) {
        try {
          await syncer.syncRule({
            safeAddress: account.evmSafeAddress,
            ruleType: rule.ruleType,
            param: rule.param,
            tokenAddress: rule.tokenAddress,
          });
        } catch (error) {
          await deactivateRule(deps.store, accountId, rule.id);
          throw error;
        }
      }
    }

    const response: AddRuleResponse = {
      rule: {
        id: rule.id,
        accountId: rule.accountId,
        ruleType: rule.ruleType,
        param: rule.param.toString(),
        tokenAddress: rule.tokenAddress,
        effectiveFrom: rule.effectiveFrom.toISOString(),
        isActive: rule.isActive,
        createdAt: rule.createdAt.toISOString(),
      },
    };
    return reply.status(201).send(addRuleResponseSchema.parse(response));
  });

  app.post("/v1/accounts/:accountId/rules/:ruleId/deactivate", async (request, reply) => {
    const { accountId, ruleId } = request.params as { accountId: string; ruleId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;

    await deactivateRule(deps.store, accountId, ruleId);

    const response: DeactivateRuleResponse = { ruleId, isActive: false };
    return reply.send(deactivateRuleResponseSchema.parse(response));
  });
}
