import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Decimal } from "decimal.js";
import {
  createAccountRequestSchema,
  createAccountResponseSchema,
  type CreateAccountResponse,
} from "@mypropguard/contracts";
import { AccountAlreadyExistsError } from "@mypropguard/domain";
import type { AppDeps } from "../app.js";

export function registerAccountRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/v1/accounts", async (request, reply) => {
    let body;
    try {
      body = createAccountRequestSchema.parse(request.body);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }

    try {
      await deps.store.createAccount({
        accountId: body.accountId,
        ownerUserId: body.ownerUserId,
        venue: body.venue,
        initialEquity: new Decimal(body.initialEquity),
        initialRules: body.initialRules.map((rule) => ({ ruleType: rule.ruleType, param: new Decimal(rule.param) })),
      });
    } catch (error) {
      if (error instanceof AccountAlreadyExistsError) {
        return reply.status(409).send({ error: "ACCOUNT_ALREADY_EXISTS", accountId: error.accountId });
      }
      throw error;
    }

    const response: CreateAccountResponse = { accountId: body.accountId, protectionOn: false };
    return reply.status(201).send(createAccountResponseSchema.parse(response));
  });
}
