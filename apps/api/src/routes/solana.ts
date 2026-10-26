import type { FastifyInstance, FastifyReply } from "fastify";
import { assertAccountOwnership, type AppDeps } from "../app.js";
import type { SolanaStore } from "../solana/solanaStore.js";
import type { WalletConnectService } from "../oneClick/walletConnectService.js";

/** The Solana wallet, as the routes need it (see apps/api/src/solana). */
export interface SolanaDeps {
  store: SolanaStore;
  service: Pick<WalletConnectService, "pair" | "disconnect" | "disconnectAccount">;
  /** Makes the wallet (a Privy wallet). */
  createWallet(): Promise<{ id: string; address: string }>;
  maxRequestsShown?: number;
}

const bad = (message: string) => ({ error: "INVALID_INPUT", message });

/**
 * The Solana wallet: a wallet MyPropGuard holds that Solana sites like pump.fun can log in to. This first version links a
 * site and records what it asks for, signing only its login. It signs no transactions yet, so nothing needs depositing.
 */
export function registerSolanaRoutes(app: FastifyInstance, deps: AppDeps): void {
  const maybe = deps.solana;
  if (!maybe) return;
  const solana: SolanaDeps = maybe;

  async function loadAccount(accountId: string, reply: FastifyReply) {
    const account = await deps.store.findAccountById(accountId);
    if (!account) {
      void reply.status(404).send({ error: "NOT_FOUND", message: "Account not found." });
      return undefined;
    }
    return account;
  }

  app.get("/v1/accounts/:accountId/solana", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await loadAccount(accountId, reply))) return;

    const wallet = await solana.store.get(accountId);
    if (!wallet) return reply.send({ available: true, exists: false });
    const [requests, sessions] = await Promise.all([
      solana.store.listRequests(accountId, solana.maxRequestsShown ?? 15),
      deps.oneClick ? deps.oneClick.store.listSessions(accountId) : Promise.resolve([]),
    ]);
    return reply.send({
      available: true,
      exists: true,
      address: wallet.address,
      status: wallet.status,
      links: sessions.filter((s) => s.kind === "solana").map((s) => ({ topic: s.topic, name: s.dappName, url: s.dappUrl, linkedAt: s.createdAt.toISOString() })),
      requests: requests.map((r) => ({
        at: r.createdAt.toISOString(),
        site: r.dappName,
        kind: r.kind,
        method: r.method,
        result: r.result,
        code: r.code,
        message: r.message,
        detail: r.detail,
      })),
    });
  });

  app.post("/v1/accounts/:accountId/solana/create", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await loadAccount(accountId, reply))) return;
    if (await solana.store.get(accountId)) return reply.status(409).send({ error: "EXISTS", message: "You already have a Solana wallet." });
    const wallet = await solana.createWallet();
    await solana.store.create({ accountId, walletId: wallet.id, address: wallet.address });
    return reply.send({ ok: true, address: wallet.address, status: "active" });
  });

  app.post("/v1/accounts/:accountId/solana/pair", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const wallet = await solana.store.get(accountId);
    if (!wallet || wallet.status !== "active") return reply.status(409).send({ error: "NOT_ENABLED", message: "Create and switch on your Solana wallet first." });
    const uri = (request.body as { uri?: unknown } | undefined)?.uri;
    if (typeof uri !== "string" || uri.length > 2000) return reply.status(400).send(bad("Paste the WalletConnect code from the site."));
    try {
      await solana.service.pair(accountId, uri, "solana");
    } catch (error) {
      return reply.status(400).send({ error: "PAIRING_FAILED", message: error instanceof Error ? error.message : "Could not use that code. Copy a fresh one from the site." });
    }
    return reply.send({ ok: true, message: "Waiting for the site to confirm. This takes a few seconds." });
  });

  app.post("/v1/accounts/:accountId/solana/disconnect", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const topic = (request.body as { topic?: unknown } | undefined)?.topic;
    if (typeof topic !== "string") return reply.status(400).send(bad("Which link?"));
    const session = deps.oneClick ? await deps.oneClick.store.getSession(topic) : undefined;
    if (!session || session.accountId !== accountId || session.kind !== "solana") return reply.status(404).send({ error: "NOT_FOUND", message: "No such link." });
    await solana.service.disconnect(topic);
    return reply.send({ ok: true });
  });

  // Switch off: stop answering sites at once and drop every link.
  app.post("/v1/accounts/:accountId/solana/off", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await solana.store.get(accountId))) return reply.send({ ok: true });
    await solana.store.setStatus(accountId, "off");
    await solana.service.disconnectAccount(accountId, "solana").catch(() => undefined);
    return reply.send({ ok: true });
  });

  app.post("/v1/accounts/:accountId/solana/on", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await solana.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your Solana wallet first." });
    await solana.store.setStatus(accountId, "active");
    return reply.send({ ok: true });
  });
}
