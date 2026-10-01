import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type {
  ActionHasher,
  AgentWalletProvisioner,
  EvmGuardRuleSyncer,
  EvmSafeProvisioner,
  ExecutionSequencer,
  OrderCanceller,
  OrderLifecycleReader,
  OrderSubmitter,
  ProtectedAccount,
  RiskLedgerStore,
  SignerGateway,
  VenueStateReader,
} from "@mypropguard/domain";
import type { AuthPreHandler } from "./auth.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerProtectionRoutes } from "./routes/protection.js";
import { registerReconciliationRoutes } from "./routes/reconciliation.js";
import { registerExecutionRoutes } from "./routes/execution.js";
import { registerRuleRoutes } from "./routes/rules.js";

export interface AppDeps {
  store: RiskLedgerStore;
  /** Optional: only reconciliation (Phase 2) needs a venue reader. Omit it in tests that don't exercise that route. */
  venueReader?: VenueStateReader;
  /** Optional: only /v1/execution/dry-run needs these. Pair PlaceholderActionHasher with FakeSignerGateway (offline scaffold) or HyperliquidActionHasher with PrivySignerGateway (real signing, still no venue submission). */
  executionSequencer?: ExecutionSequencer;
  hasher?: ActionHasher;
  /** Fallback signer, used when the account has no provisioned wallet of its own (see signerFactory) - and the only signer at all in the offline scaffold. */
  signer?: SignerGateway;
  /**
   * When set, and the account being signed for has its own agentWalletId
   * (see agentWalletProvisioner), this builds a signer scoped to THAT
   * account's wallet instead of falling back to the single shared `signer`.
   * This is what makes per-account wallet provisioning actually matter for
   * trading, rather than just an address shown on screen.
   */
  signerFactory?: (walletId: string, walletAddress: string) => SignerGateway;
  /** Fallback order lifecycle (submit/cancel/status), used when the account has no provisioned wallet - and the only one at all when orderLifecycleFactory isn't configured. */
  orderSubmitter?: OrderSubmitter;
  orderCanceller?: OrderCanceller;
  orderLifecycleReader?: OrderLifecycleReader;
  /** Per-account equivalent of signerFactory, for submit/cancel/status. */
  orderLifecycleFactory?: (walletId: string) => OrderSubmitter & OrderCanceller & OrderLifecycleReader;
  /** Optional: when configured, POST /v1/accounts provisions a real signing wallet for the new account. Null/absent in the offline scaffold - accounts just get no wallet. */
  agentWalletProvisioner?: AgentWalletProvisioner;
  /**
   * EVM-chain Safe provisioning (see packages/evm-guard, packages/evm), keyed by chain id (e.g.
   * 42161 for Arbitrum, 56 for BSC, 1 for Ethereum). POST /v1/accounts uses the entry matching
   * the request's evmChainId, if both that and evmOwnerWalletAddress are provided. Absent
   * entirely in the offline scaffold and for any chain not yet configured.
   */
  evmSafeProvisioners?: Record<number, EvmSafeProvisioner>;
  /**
   * EVM-chain on-chain rule sync (see packages/evm's EvmChainGuardRuleSyncer), keyed by chain id
   * the same way as evmSafeProvisioners. POST /v1/accounts/:accountId/rules uses the entry
   * matching the account's own evmChainId (not the request) to push MAX_POSITION_SIZE/
   * MAX_TRADE_FREQUENCY changes to that account's already-deployed Guard. Absent entirely in the
   * offline scaffold and for any chain not yet configured - rule changes then only ever apply
   * inside MyPropGuard's own dashboard, same as before this existed.
   */
  evmGuardSyncers?: Record<number, EvmGuardRuleSyncer>;
  /**
   * When configured, every route requires a valid Supabase bearer token and
   * populates request.userId - route handlers then use it to derive
   * ownerUserId (never trust a client-supplied one) and to enforce that a
   * user can only act on accounts they own (see assertAccountOwnership).
   * Absent in tests and the offline scaffold, which keeps the previous
   * unauthenticated behavior for those - production (server.ts) always
   * configures this.
   */
  authPreHandler?: AuthPreHandler;
}

/**
 * Resolves which real implementation to use for one account: its own
 * provisioned wallet when it has one and a factory is configured,
 * otherwise the server-wide fallback instance. The same resolution rule
 * backs signing, submitting, cancelling, and status reads, so per-account
 * wallets apply consistently across the whole order lifecycle rather than
 * only some of it.
 */
async function resolveForAccount<T>(
  deps: AppDeps,
  accountId: string,
  factory: ((account: ProtectedAccount) => T) | undefined,
  fallback: T | undefined,
): Promise<T | undefined> {
  if (factory) {
    const account = await deps.store.findAccountById(accountId);
    if (account?.agentWalletId) {
      return factory(account);
    }
  }
  return fallback;
}

export function resolveSignerForAccount(deps: AppDeps, accountId: string): Promise<SignerGateway | undefined> {
  return resolveForAccount(
    deps,
    accountId,
    deps.signerFactory && ((account) => deps.signerFactory!(account.agentWalletId!, account.agentWalletAddress!)),
    deps.signer,
  );
}

export function resolveOrderSubmitterForAccount(deps: AppDeps, accountId: string): Promise<OrderSubmitter | undefined> {
  return resolveForAccount(
    deps,
    accountId,
    deps.orderLifecycleFactory && ((account) => deps.orderLifecycleFactory!(account.agentWalletId!)),
    deps.orderSubmitter,
  );
}

export function resolveOrderCancellerForAccount(deps: AppDeps, accountId: string): Promise<OrderCanceller | undefined> {
  return resolveForAccount(
    deps,
    accountId,
    deps.orderLifecycleFactory && ((account) => deps.orderLifecycleFactory!(account.agentWalletId!)),
    deps.orderCanceller,
  );
}

export function resolveOrderLifecycleReaderForAccount(deps: AppDeps, accountId: string): Promise<OrderLifecycleReader | undefined> {
  return resolveForAccount(
    deps,
    accountId,
    deps.orderLifecycleFactory && ((account) => deps.orderLifecycleFactory!(account.agentWalletId!)),
    deps.orderLifecycleReader,
  );
}

/**
 * Enforces that the authenticated user (request.userId) owns the given
 * account, replying 404/403 and returning false if not - callers must
 * `return` immediately when this returns false. When no auth is configured
 * (request.userId undefined - tests, offline scaffold) this is a no-op that
 * returns true, preserving the previous unauthenticated behavior for those.
 */
export async function assertAccountOwnership(
  deps: AppDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  accountId: string,
): Promise<boolean> {
  if (!request.userId) return true;

  const account = await deps.store.findAccountById(accountId);
  if (!account) {
    reply.status(404).send({ error: "NOT_FOUND", message: `No account found for id ${accountId}` });
    return false;
  }
  if (account.ownerUserId !== request.userId) {
    reply.status(403).send({ error: "FORBIDDEN", message: "You do not own this account." });
    return false;
  }
  return true;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Local dev tool only, not exposed publicly: reflecting the request
  // origin lets apps/web (a different port/origin) call this API.
  void app.register(cors, { origin: true });

  if (deps.authPreHandler) {
    app.addHook("preHandler", deps.authPreHandler);
  }

  registerAccountRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerProtectionRoutes(app, deps);
  registerReconciliationRoutes(app, deps);
  registerExecutionRoutes(app, deps);
  registerRuleRoutes(app, deps);

  // Route handlers already return typed errors (400/409/501) for expected
  // cases. Anything reaching here is unexpected (e.g. a database driver
  // error) and must not leak internals like raw connection error text.
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: error.name, message: error.message });
    }
    return reply.status(500).send({ error: "INTERNAL_ERROR", message: "Something went wrong. Please try again." });
  });

  return app;
}
