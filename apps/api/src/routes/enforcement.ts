import type { FastifyInstance } from "fastify";
import { assertAccountOwnership, type AppDeps } from "../app.js";

/**
 * What the Hyperliquid watcher is doing for one account: whether it is locked for today and why, the exposure
 * ceilings that apply while locked, and the most recent actions it took (or, in log-only mode, would have taken).
 * Read-only, and only for the signed-in owner's own account.
 */
export function registerEnforcementRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/v1/accounts/:accountId/enforcement", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;

    const head = await deps.store.runExclusive(accountId, (ctx) => ctx.getAccountRiskHead(accountId));
    const actions = await deps.store.listEnforcementActions(accountId, 30);
    const today = new Date().toISOString().slice(0, 10);
    const state = head.enforcement ?? null;

    return reply.send({
      watcherMode: deps.watcherMode ?? "off",
      lockedToday: state?.lockedDay === today,
      lockedDay: state?.lockedDay ?? null,
      reason: state?.reason ?? null,
      lockedAt: state?.lockedAtMs ? new Date(state.lockedAtMs).toISOString() : null,
      ceilings: Object.fromEntries(Object.entries(state?.ceilings ?? {}).map(([coin, size]) => [coin, size.toString()])),
      actions: actions.map((a) => ({
        at: (a.createdAt ?? new Date()).toISOString(),
        mode: a.mode,
        kind: a.kind,
        coin: a.coin ?? null,
        result: a.result,
        detail: a.detail,
        error: a.error ?? null,
      })),
    });
  });
}
