import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Decimal } from "decimal.js";
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
import type { AppDeps } from "../app.js";

export function registerRuleRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/v1/accounts/:accountId/rules", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const rules = await listRules(deps.store, accountId);

    const response: ListRulesResponse = {
      rules: rules.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        ruleType: r.ruleType,
        param: r.param.toString(),
        effectiveFrom: r.effectiveFrom.toISOString(),
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
      })),
    };
    return reply.send(listRulesResponseSchema.parse(response));
  });

  app.post("/v1/accounts/:accountId/rules", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };

    let body;
    try {
      body = addRuleRequestSchema.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }

    const rule = await addRule(deps.store, accountId, body.ruleType, new Decimal(body.param));
    const response: AddRuleResponse = {
      rule: {
        id: rule.id,
        accountId: rule.accountId,
        ruleType: rule.ruleType,
        param: rule.param.toString(),
        effectiveFrom: rule.effectiveFrom.toISOString(),
        isActive: rule.isActive,
        createdAt: rule.createdAt.toISOString(),
      },
    };
    return reply.status(201).send(addRuleResponseSchema.parse(response));
  });

  app.post("/v1/accounts/:accountId/rules/:ruleId/deactivate", async (request, reply) => {
    const { accountId, ruleId } = request.params as { accountId: string; ruleId: string };

    await deactivateRule(deps.store, accountId, ruleId);

    const response: DeactivateRuleResponse = { ruleId, isActive: false };
    return reply.send(deactivateRuleResponseSchema.parse(response));
  });
}
