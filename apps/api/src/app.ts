import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type {
  ActionHasher,
  AgentWalletProvisioner,
  ExecutionSequencer,
  OrderCanceller,
  OrderLifecycleReader,
  OrderSubmitter,
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
  signer?: SignerGateway;
  /** Optional: only present once real submission is configured (ENABLE_REAL_SIGNER). Lets dry-run actually reach the venue and lets order status/cancel act on the result. */
  orderSubmitter?: OrderSubmitter;
  orderCanceller?: OrderCanceller;
  orderLifecycleReader?: OrderLifecycleReader;
  /** Optional: when configured, POST /v1/accounts provisions a real signing wallet for the new account. Null/absent in the offline scaffold - accounts just get no wallet. */
  agentWalletProvisioner?: AgentWalletProvisioner;
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
