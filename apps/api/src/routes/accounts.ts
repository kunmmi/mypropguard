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

    // EVM-chain venues: deploy a Safe (with MyPropGuard's risk Guard already attached - see
    // packages/evm-guard/src/SafeGuardSetup.sol) for the trader's own wallet, same
    // fail-the-whole-creation-rather-than-leave-it-half-done reasoning as agentWallet above.
    // Requires BOTH evmOwnerWalletAddress and evmChainId, and a provisioner actually configured
    // for that chain - any of those missing just skips Safe provisioning (same as the offline
    // scaffold omitting agentWalletProvisioner).
    let evmSafe: { safeAddress: string } | null = null;
    if (body.evmOwnerWalletAddress && body.evmChainId) {
      const provisioner = deps.evmSafeProvisioners?.[body.evmChainId];
      if (provisioner) {
        const provisioned = await provisioner.provisionSafe(body.evmOwnerWalletAddress);
        evmSafe = { safeAddress: provisioned.safeAddress };
      }
    }

    // Never trust a client-supplied ownerUserId when the caller is
    // authenticated - always create the account under the real logged-in
    // user, regardless of what the request body claims.
    const ownerUserId = request.userId ?? body.ownerUserId;

    try {
      await deps.store.createAccount({
        accountId: body.accountId,
        ownerUserId,
        venue: body.venue,
        initialEquity: new Decimal(body.initialEquity),
        initialRules: body.initialRules.map((rule) => ({ ruleType: rule.ruleType, param: new Decimal(rule.param) })),
        agentWalletId: agentWallet?.walletId ?? null,
        agentWalletAddress: agentWallet?.walletAddress ?? null,
        evmOwnerWalletAddress: body.evmOwnerWalletAddress ?? null,
        evmSafeAddress: evmSafe?.safeAddress ?? null,
        evmChainId: body.evmChainId ?? null,
      });
    } catch (error) {
      if (error instanceof AccountAlreadyExistsError) {
        return reply.status(409).send({ error: "ACCOUNT_ALREADY_EXISTS", accountId: error.accountId });
      }
      throw error;
    }

    if (body.venueAddress) await deps.store.setVenueAddress(body.accountId, body.venueAddress);

    const response: CreateAccountResponse = {
      accountId: body.accountId,
      protectionOn: false,
      agentWalletAddress: agentWallet?.walletAddress ?? null,
      evmSafeAddress: evmSafe?.safeAddress ?? null,
    };
    return reply.status(201).send(createAccountResponseSchema.parse(response));
  });

  const listAccountsQuerySchema = z.object({ ownerUserId: z.string().min(1).optional() });

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

    // Authenticated callers always list their own accounts - the query
    // param only remains for unauthenticated tests/scaffold use.
    const ownerUserId = request.userId ?? query.ownerUserId;
    if (!ownerUserId) {
      return reply.status(400).send({ error: "INVALID_REQUEST", message: "ownerUserId is required." });
    }

    const accounts = await listAccounts(deps.store, ownerUserId);
    const response: ListAccountsResponse = {
      accounts: accounts.map((a) => ({
        accountId: a.accountId,
        ownerUserId: a.ownerUserId,
        venue: a.venue,
        protectionEnabled: a.protectionEnabled,
        createdAt: a.createdAt.toISOString(),
        agentWalletAddress: a.agentWalletAddress,
        evmSafeAddress: a.evmSafeAddress,
        venueAddress: a.venueAddress ?? null,
      })),
    };
    return reply.send(listAccountsResponseSchema.parse(response));
  });
}
