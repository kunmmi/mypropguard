import type { FastifyInstance, FastifyReply } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { sweepSolanaWallet, type SolanaRpc, type SolanaValuer, type SolanaWalletSigner } from "@mypropguard/solana";
import { assertAccountOwnership, type AppDeps } from "../app.js";
import { loadWalletAccountRules } from "../float/accountRules.js";
import type { SolanaStore } from "../solana/solanaStore.js";
import type { WalletConnectService } from "../oneClick/walletConnectService.js";

/** The Solana wallet, as the routes need it (see apps/api/src/solana). */
export interface SolanaDeps {
  store: SolanaStore;
  service: Pick<WalletConnectService, "pair" | "disconnect" | "disconnectAccount">;
  /** Makes the wallet (a Privy wallet). */
  createWallet(): Promise<{ id: string; address: string }>;
  /** Reads balances and sends withdrawals. Absent: balances are not shown and withdrawals are unavailable. */
  rpc?: Pick<SolanaRpc, "getBalance" | "getTokenBalance" | "getAccountData" | "getAccountOwner" | "getLatestBlockhash" | "sendRaw" | "confirm">;
  signer?: SolanaWalletSigner;
  valuer?: Pick<SolanaValuer, "holdings" | "quoteSell">;
  /** Whether the server signs trades at all (ENABLE_SOLANA_TRADING). Shown to the owner. */
  tradingEnabled?: boolean;
  maxRequestsShown?: number;
}

const bad = (message: string) => ({ error: "INVALID_INPUT", message });

function whole(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

/**
 * The Solana wallet: a wallet MyPropGuard holds that Solana sites like pump.fun can log in to. The owner chooses the limits;
 * every transaction a site proposes is judged on the server before it is signed (packages/solana). The only place money can
 * go is the one withdrawal address the signed-in owner set.
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

  const limitsOf = (w: NonNullable<Awaited<ReturnType<SolanaStore["get"]>>>) => ({
    maxBuyPct: w.maxBuyPct,
    dailySpendPct: w.dailySpendPct,
    maxBuysPerDay: w.maxBuysPerDay,
    cooldownSec: w.cooldownSec,
    frozen: w.frozen,
  });

  app.get("/v1/accounts/:accountId/solana", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await loadAccount(accountId, reply))) return;

    const wallet = await solana.store.get(accountId);
    if (!wallet) return reply.send({ available: true, exists: false });

    const [requests, sessions, accountRules, mints] = await Promise.all([
      solana.store.listRequests(accountId, solana.maxRequestsShown ?? 15),
      deps.oneClick ? deps.oneClick.store.listSessions(accountId) : Promise.resolve([]),
      loadWalletAccountRules(deps.store, accountId).catch(() => ({ value: {} })),
      solana.store.knownMints(accountId),
    ]);
    // Balances come from the network; if it is slow or down the rest of the page still loads.
    let balanceLamports: string | null = null;
    let holdings: Array<{ mint: string; balance: string; valueLamports: string }> = [];
    if (solana.valuer) {
      try {
        const h = await solana.valuer.holdings(wallet.address, mints);
        balanceLamports = h.solLamports.toString();
        holdings = h.positions.filter((p) => p.balance > 0n).map((p) => ({ mint: p.mint, balance: p.balance.toString(), valueLamports: p.valueLamports.toString() }));
      } catch {
        // leave null: "could not read"
      }
    }
    return reply.send({
      available: true,
      exists: true,
      address: wallet.address,
      status: wallet.status,
      tradingEnabled: solana.tradingEnabled ?? false,
      limits: limitsOf(wallet),
      accountRules,
      withdrawalAddress: wallet.withdrawalAddress,
      balanceLamports,
      holdings,
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
        tradeKind: r.tradeKind,
        mint: r.mint,
        lamports: r.lamports,
        signature: r.signature,
        totalMs: r.totalMs,
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

  // Change any limit. Takes effect on the very next trade a site proposes.
  app.post("/v1/accounts/:accountId/solana/settings", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await solana.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your Solana wallet first." });
    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const maxBuyPct = whole(body.maxBuyPct, "The biggest single buy", 1, 100);
      const dailySpendPct = whole(body.dailySpendPct, "The most spent per day", 1, 100);
      const maxBuysPerDay = whole(body.maxBuysPerDay, "Buys per day", 1, 1000);
      const cooldownSec = whole(body.cooldownSec, "The pause between buys", 0, 86_400);
      await solana.store.updateSettings(accountId, {
        ...(maxBuyPct !== undefined && { maxBuyPct }),
        ...(dailySpendPct !== undefined && { dailySpendPct }),
        ...(maxBuysPerDay !== undefined && { maxBuysPerDay }),
        ...(cooldownSec !== undefined && { cooldownSec }),
      });
    } catch (error) {
      return reply.status(400).send(bad((error as Error).message));
    }
    const updated = await solana.store.get(accountId);
    return reply.send({ ok: true, ...(updated ? { limits: limitsOf(updated) } : {}) });
  });

  // Pause: no new buys, selling stays possible.
  app.post("/v1/accounts/:accountId/solana/freeze", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await solana.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your Solana wallet first." });
    const frozen = (request.body as { frozen?: unknown } | undefined)?.frozen !== false;
    await solana.store.setFrozen(accountId, frozen);
    return reply.send({ ok: true, frozen });
  });

  // Where withdrawals go. Chosen by the signed-in owner; the server sends money nowhere else.
  app.post("/v1/accounts/:accountId/solana/withdrawal-address", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const wallet = await solana.store.get(accountId);
    if (!wallet) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your Solana wallet first." });
    const address = (request.body as { address?: unknown } | undefined)?.address;
    if (typeof address !== "string" || address.length > 60) return reply.status(400).send(bad("Enter your own Solana wallet address."));
    let valid: PublicKey;
    try {
      valid = new PublicKey(address.trim());
    } catch {
      return reply.status(400).send(bad("That is not a valid Solana address."));
    }
    if (valid.toBase58() === wallet.address) return reply.status(400).send(bad("That is this wallet's own address. Enter your own wallet's address."));
    await solana.store.setWithdrawalAddress(accountId, valid.toBase58());
    return reply.send({ ok: true, withdrawalAddress: valid.toBase58() });
  });

  async function withdraw(accountId: string) {
    const wallet = await solana.store.get(accountId);
    if (!wallet?.withdrawalAddress) return { error: "NO_ADDRESS" as const };
    if (!solana.rpc || !solana.signer || !solana.valuer) return { error: "UNAVAILABLE" as const };
    const mints = await solana.store.knownMints(accountId);
    const items = await sweepSolanaWallet({
      walletId: wallet.walletId,
      wallet: wallet.address,
      to: wallet.withdrawalAddress,
      mints,
      rpc: solana.rpc,
      signer: solana.signer,
      valuer: solana.valuer,
    });
    for (const item of items) {
      await solana.store
        .recordRequest({
          accountId,
          dappName: null,
          kind: "sweep",
          method: "withdraw",
          result: item.error ? "ERROR" : item.signature ? "SIGNED" : "REFUSED",
          code: item.skipped ? "SKIPPED" : null,
          message: item.error ?? item.skipped ?? `withdrew ${item.asset === "SOL" ? "SOL" : "a coin"} to your address`,
          mint: item.asset === "SOL" ? null : item.asset,
          lamports: item.asset === "SOL" ? item.amount : null,
          proceedsLamports: item.proceedsLamports,
          signature: item.signature,
        })
        .catch(() => undefined);
    }
    // Money the owner took out is not a loss: forget the high-water mark so the drawdown rule starts afresh.
    await solana.store.resetPeak(accountId).catch(() => undefined);
    return { items: items.map((i) => ({ asset: i.asset, amount: i.amount.toString(), signature: i.signature, error: i.error, skipped: i.skipped ?? null })), to: wallet.withdrawalAddress };
  }

  const withdrawReply = (out: Awaited<ReturnType<typeof withdraw>>, reply: FastifyReply) => {
    if ("error" in out) {
      return reply.status(out.error === "NO_ADDRESS" ? 409 : 503).send({
        error: out.error,
        message: out.error === "NO_ADDRESS" ? "Set your withdrawal address first. Withdrawals only ever go to the address you set." : "Withdrawals are not available on this server right now.",
      });
    }
    return reply.send({ ok: true, ...out });
  };

  app.post("/v1/accounts/:accountId/solana/withdraw", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await solana.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your Solana wallet first." });
    return withdrawReply(await withdraw(accountId), reply);
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

  // Switch off: stop answering sites at once and drop every link. If a withdrawal address is set, the funds go back too.
  app.post("/v1/accounts/:accountId/solana/off", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const wallet = await solana.store.get(accountId);
    if (!wallet) return reply.send({ ok: true });
    await solana.store.setStatus(accountId, "off");
    await solana.service.disconnectAccount(accountId, "solana").catch(() => undefined);
    const withdrawn = wallet.withdrawalAddress ? await withdraw(accountId) : undefined;
    return reply.send({ ok: true, ...(withdrawn && !("error" in withdrawn) ? withdrawn : {}) });
  });

  app.post("/v1/accounts/:accountId/solana/on", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await solana.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your Solana wallet first." });
    await solana.store.setStatus(accountId, "active");
    return reply.send({ ok: true });
  });
}
