import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { Decimal } from "decimal.js";
import {
  createAccountRequestSchema,
  createAccountResponseSchema,
  listAccountsResponseSchema,
  type CreateAccountResponse,
  type ListAccountsResponse,
} from "@mypropguard/contracts";
import { AccountAlreadyExistsError } from "@mypropguard/domain";
import { listAccounts } from "@mypropguard/risk-ledger";
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

    // Provisioned before the account row is written, not inside it: a
    // failed Privy call should fail the whole creation rather than leave an
    // account permanently missing its wallet with no retry path.
    let agentWallet: { walletId: string; walletAddress: string } | null = null;
    if (deps.agentWalletProvisioner) {
      const provisioned = await deps.agentWalletProvisioner.provisionWallet();
      agentWallet = { walletId: provisioned.walletId, walletAddress: provisioned.walletAddress };
    }

    try {
      await deps.store.createAccount({
        accountId: body.accountId,
        ownerUserId: body.ownerUserId,
        venue: body.venue,
        initialEquity: new Decimal(body.initialEquity),
        initialRules: body.initialRules.map((rule) => ({ ruleType: rule.ruleType, param: new Decimal(rule.param) })),
        agentWalletId: agentWallet?.walletId ?? null,
        agentWalletAddress: agentWallet?.walletAddress ?? null,
      });
    } catch (error) {
      if (error instanceof AccountAlreadyExistsError) {
        return reply.status(409).send({ error: "ACCOUNT_ALREADY_EXISTS", accountId: error.accountId });
      }
      throw error;
    }

    const response: CreateAccountResponse = {
      accountId: body.accountId,
      protectionOn: false,
      agentWalletAddress: agentWallet?.walletAddress ?? null,
    };
    return reply.status(201).send(createAccountResponseSchema.parse(response));
  });

  const listAccountsQuerySchema = z.object({ ownerUserId: z.string().min(1) });

  app.get("/v1/accounts", async (request, reply) => {
    let query;
    try {
      query = listAccountsQuerySchema.parse(request.query);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: "INVALID_REQUEST", issues: error.issues });
      }
      throw error;
    }

    const accounts = await listAccounts(deps.store, query.ownerUserId);
    const response: ListAccountsResponse = {
      accounts: accounts.map((a) => ({
        accountId: a.accountId,
        ownerUserId: a.ownerUserId,
        venue: a.venue,
        protectionEnabled: a.protectionEnabled,
        createdAt: a.createdAt.toISOString(),
        agentWalletAddress: a.agentWalletAddress,
      })),
    };
    return reply.send(listAccountsResponseSchema.parse(response));
  });
}
