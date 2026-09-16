import Fastify, { type FastifyInstance } from "fastify";
import type { RiskLedgerStore } from "@mypropguard/domain";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerProtectionRoutes } from "./routes/protection.js";

export interface AppDeps {
  store: RiskLedgerStore;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  registerOrderRoutes(app, deps);
  registerProtectionRoutes(app, deps);

  return app;
}
