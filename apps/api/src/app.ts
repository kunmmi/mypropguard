import Fastify, { type FastifyInstance } from "fastify";
import type { RiskLedgerStore, VenueStateReader } from "@mypropguard/domain";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerProtectionRoutes } from "./routes/protection.js";
import { registerReconciliationRoutes } from "./routes/reconciliation.js";

export interface AppDeps {
  store: RiskLedgerStore;
  /** Optional: only reconciliation (Phase 2) needs a venue reader. Omit it in tests that don't exercise that route. */
  venueReader?: VenueStateReader;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  registerAccountRoutes(app, deps);
  registerOrderRoutes(app, deps);
  registerProtectionRoutes(app, deps);
  registerReconciliationRoutes(app, deps);

  return app;
}
