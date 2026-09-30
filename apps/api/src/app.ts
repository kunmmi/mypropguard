import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type {
  ActionHasher,
  AgentWalletProvisioner,
  ExecutionSequencer,
  OrderCanceller,
  OrderLifecycleReader,
  OrderSubmitter,
  ProtectedAccount,
  RiskLedgerStore,
  SignerGateway,
  VenueStateReader,
} from "@mypropguard/domain";
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

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Local dev tool only, not exposed publicly: reflecting the request
  // origin lets apps/web (a different port/origin) call this API.
  void app.register(cors, { origin: true });

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
