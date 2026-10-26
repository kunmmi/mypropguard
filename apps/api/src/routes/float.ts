import type { FastifyInstance } from "fastify";
import { erc20Abi, formatEther, getAddress, type Address, type PublicClient } from "viem";
import type { FloatWalletSigner } from "@mypropguard/evm";
import { assertAccountOwnership, type AppDeps } from "../app.js";
import type { FloatStore } from "../float/floatStore.js";
import { sweepFloat } from "../float/sweep.js";
import { loadWalletAccountRules } from "../float/accountRules.js";
import type { WalletConnectService } from "../oneClick/walletConnectService.js";

/** The trading ("float") wallet, as the routes need it (see apps/api/src/float). */
export interface FloatDeps {
  store: FloatStore;
  service: Pick<WalletConnectService, "pair" | "disconnect" | "disconnectAccount">;
  /** Makes the trading wallet (a Privy wallet). */
  createWallet(): Promise<{ id: string; address: string }>;
  signer: Pick<FloatWalletSigner, "sendTransaction">;
  publicClient: PublicClient;
  chainId: number;
  nativeSymbol: string;
  maxTradesShown?: number;
}

const bad = (message: string) => ({ error: "INVALID_INPUT", message });


function whole(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

/**
 * The trading wallet: a separate wallet MyPropGuard holds and signs for, that sites like four.meme can log in to
 * (a Safe cannot). The owner chooses how much to put in it (the float) and the rules it trades under; the rules are
 * enforced on the server for every transaction a site proposes (packages/evm/src/floatPolicy.ts). The only way funds
 * leave it is back to the owner's own Safe.
 */
export function registerFloatRoutes(app: FastifyInstance, deps: AppDeps): void {
  const maybeFloat = deps.float;
  if (!maybeFloat) return;
  const float: FloatDeps = maybeFloat;

  async function load(accountId: string, reply: import("fastify").FastifyReply) {
    const account = await deps.store.findAccountById(accountId);
    if (!account) {
      void reply.status(404).send({ error: "NOT_FOUND", message: "Account not found." });
      return undefined;
    }
    if (!account.evmSafeAddress || !account.evmChainId || account.evmChainId !== float.chainId) {
      void reply.status(400).send({ error: "NOT_SUPPORTED", message: "Your MyPropGuard wallet needs a protected account on a supported chain first." });
      return undefined;
    }
    return { account, safe: getAddress(account.evmSafeAddress) };
  }

  const view = (w: NonNullable<Awaited<ReturnType<FloatStore["get"]>>>) => ({
    address: w.address,
    status: w.status,
    chainId: w.chainId,
    limits: {
      maxBuyPct: w.maxBuyPct,
      dailySpendPct: w.dailySpendPct,
      maxBuysPerDay: w.maxBuysPerDay,
      cooldownSec: w.cooldownSec,
      frozen: w.frozen,
    },
  });

  async function holdings(accountId: string, address: Address) {
    const tokens = await float.store.knownTokens(accountId);
    const rows = await Promise.all(
      tokens.map(async (token) => {
        try {
          const [balance, symbol, decimals] = await Promise.all([
            float.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
            float.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
            float.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
          ]);
          return { token, symbol: String(symbol), decimals: Number(decimals), balance: (balance as bigint).toString() };
        } catch {
          return undefined;
        }
      }),
    );
    return rows.filter((r): r is NonNullable<typeof r> => !!r && r.balance !== "0");
  }

  app.get("/v1/accounts/:accountId/float", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await load(accountId, reply);
    if (!loaded) return;

    const wallet = await float.store.get(accountId);
    if (!wallet) return reply.send({ available: true, exists: false, nativeSymbol: float.nativeSymbol, chainId: float.chainId });

    const [balance, held, trades, sessions, accountRules] = await Promise.all([
      float.publicClient.getBalance({ address: wallet.address }),
      holdings(accountId, wallet.address),
      float.store.listTrades(accountId, float.maxTradesShown ?? 15),
      deps.oneClick ? deps.oneClick.store.listSessions(accountId) : Promise.resolve([]),
      loadWalletAccountRules(deps.store, accountId).catch(() => ({})),
    ]);
    return reply.send({
      available: true,
      exists: true,
      nativeSymbol: float.nativeSymbol,
      ...view(wallet),
      accountRules,
      balanceWei: balance.toString(),
      holdings: held,
      returnsTo: loaded.safe,
      links: sessions
        .filter((s) => s.kind === "float")
        .map((s) => ({ topic: s.topic, name: s.dappName, url: s.dappUrl, linkedAt: s.createdAt.toISOString() })),
      trades: trades.map((t) => ({
        at: t.createdAt.toISOString(),
        site: t.dappName,
        kind: t.kind,
        token: t.tokenAddress,
        valueWei: t.valueWei,
        txHash: t.txHash,
        result: t.result,
        code: t.code,
        message: t.message,
        totalMs: t.totalMs,
      })),
    });
  });

  // Create the wallet with the float the owner chose. Nothing moves yet: the owner sends BNB to the address shown.
  app.post("/v1/accounts/:accountId/float/create", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await load(accountId, reply))) return;
    if (await float.store.get(accountId)) return reply.status(409).send({ error: "EXISTS", message: "You already have a wallet." });

    const wallet = await float.createWallet();
    await float.store.create({ accountId, walletId: wallet.id, address: wallet.address, chainId: float.chainId });
    const created = await float.store.get(accountId);
    return reply.send({ ok: true, ...(created ? view(created) : {}) });
  });

  // Change the float and/or any limit. Takes effect on the very next trade a site proposes.
  app.post("/v1/accounts/:accountId/float/settings", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await load(accountId, reply))) return;
    const wallet = await float.store.get(accountId);
    if (!wallet) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your wallet first." });

    const body = (request.body ?? {}) as Record<string, unknown>;
    try {
      const maxBuyPct = whole(body.maxBuyPct, "The biggest single buy", 1, 100);
      const dailySpendPct = whole(body.dailySpendPct, "The most spent per day", 1, 100);
      const maxBuysPerDay = whole(body.maxBuysPerDay, "Buys per day", 1, 1000);
      const cooldownSec = whole(body.cooldownSec, "The pause between buys", 0, 86_400);
      await float.store.updateSettings(accountId, {
        ...(maxBuyPct !== undefined && { maxBuyPct }),
        ...(dailySpendPct !== undefined && { dailySpendPct }),
        ...(maxBuysPerDay !== undefined && { maxBuysPerDay }),
        ...(cooldownSec !== undefined && { cooldownSec }),
      });
    } catch (error) {
      return reply.status(400).send(bad((error as Error).message));
    }
    const updated = await float.store.get(accountId);
    return reply.send({ ok: true, ...(updated ? view(updated) : {}) });
  });

  // Freeze: no new buys, selling stays possible.
  app.post("/v1/accounts/:accountId/float/freeze", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await float.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your wallet first." });
    const frozen = (request.body as { frozen?: unknown } | undefined)?.frozen !== false;
    await float.store.setFrozen(accountId, frozen);
    return reply.send({ ok: true, frozen });
  });

  app.post("/v1/accounts/:accountId/float/pair", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const wallet = await float.store.get(accountId);
    if (!wallet || wallet.status !== "active") return reply.status(409).send({ error: "NOT_ENABLED", message: "Create and switch on your wallet first." });
    const uri = (request.body as { uri?: unknown } | undefined)?.uri;
    if (typeof uri !== "string" || uri.length > 2000) return reply.status(400).send(bad("Paste the WalletConnect code from the site."));
    try {
      await float.service.pair(accountId, uri, "float");
    } catch (error) {
      return reply.status(400).send({ error: "PAIRING_FAILED", message: error instanceof Error ? error.message : "Could not use that code. Copy a fresh one from the site." });
    }
    return reply.send({ ok: true, message: "Waiting for the site to confirm. This takes a few seconds." });
  });

  app.post("/v1/accounts/:accountId/float/disconnect", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const topic = (request.body as { topic?: unknown } | undefined)?.topic;
    if (typeof topic !== "string") return reply.status(400).send(bad("Which link?"));
    const session = deps.oneClick ? await deps.oneClick.store.getSession(topic) : undefined;
    if (!session || session.accountId !== accountId || session.kind !== "float") return reply.status(404).send({ error: "NOT_FOUND", message: "No such link." });
    await float.service.disconnect(topic);
    return reply.send({ ok: true });
  });

  async function sweep(accountId: string, safe: Address) {
    const wallet = await float.store.get(accountId);
    if (!wallet) return [];
    const tokens = await float.store.knownTokens(accountId);
    const items = await sweepFloat({
      walletId: wallet.walletId,
      walletAddress: wallet.address,
      to: safe,
      tokens,
      publicClient: float.publicClient,
      signer: float.signer,
    });
    for (const item of items) {
      await float.store
        .recordTrade({
          accountId,
          dappName: null,
          kind: "sweep",
          toAddress: safe,
          tokenAddress: item.asset === "BNB" ? null : item.asset,
          valueWei: item.asset === "BNB" ? item.amount : null,
          txHash: item.txHash,
          result: item.error ? "ERROR" : "SENT",
          code: null,
          message: item.error ?? `returned ${item.asset === "BNB" ? `${formatEther(item.amount)} ${float.nativeSymbol}` : "a token balance"} to your Safe`,
        })
        .catch(() => undefined);
    }
    return items.map((i) => ({ asset: i.asset, amount: i.amount.toString(), txHash: i.txHash, error: i.error }));
  }

  // Bring everything back to the owner's Safe. The wallet keeps working afterwards (it is just empty).
  app.post("/v1/accounts/:accountId/float/sweep", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await load(accountId, reply);
    if (!loaded) return;
    if (!(await float.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your wallet first." });
    return reply.send({ ok: true, returnedTo: loaded.safe, items: await sweep(accountId, loaded.safe) });
  });

  // Switch off: stop answering sites at once, drop every link, then return the funds.
  app.post("/v1/accounts/:accountId/float/off", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await load(accountId, reply);
    if (!loaded) return;
    if (!(await float.store.get(accountId))) return reply.send({ ok: true, items: [] });
    await float.store.setStatus(accountId, "off");
    await float.service.disconnectAccount(accountId, "float").catch(() => undefined);
    return reply.send({ ok: true, returnedTo: loaded.safe, items: await sweep(accountId, loaded.safe) });
  });

  app.post("/v1/accounts/:accountId/float/on", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    if (!(await float.store.get(accountId))) return reply.status(404).send({ error: "NOT_FOUND", message: "Create your wallet first." });
    await float.store.setStatus(accountId, "active");
    return reply.send({ ok: true });
  });
}
