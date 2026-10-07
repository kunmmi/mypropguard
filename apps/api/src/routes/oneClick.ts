import type { FastifyInstance, FastifyReply } from "fastify";
import { getAddress, isAddressEqual, type Address, type PublicClient } from "viem";
import { SAFE_GUARD_STORAGE_SLOT, buildDisableSessionKeyTx, buildEnableSessionKeyTx, isSessionKeyActive } from "@mypropguard/evm";
import { assertAccountOwnership, type AppDeps } from "../app.js";
import type { OneClickStore } from "../oneClick/oneClickStore.js";
import type { WalletConnectService } from "../oneClick/walletConnectService.js";

/** One-click trading, as the routes need it (see apps/api/src/oneClick). */
export interface OneClickDeps {
  store: OneClickStore;
  service: Pick<WalletConnectService, "pair" | "disconnect" | "disconnectAccount">;
  /** Makes the account's session key (a Privy wallet). */
  createSessionWallet(): Promise<{ id: string; address: string }>;
  /** Per chain id: how to read the chain, which Guard protects Safes there, and Safe's MultiSendCallOnly. */
  chains: Record<number, { publicClient: PublicClient; guardAddress: Address; multiSendCallOnly: Address; gasWalletAddress?: Address }>;
  /** Shown to the trader: the site they link their exchange to is this server, not a browser tab. */
  maxTradesShown?: number;
}

/**
 * One-click trading: the owner switches it on with ONE transaction from their own wallet, links an exchange by pasting
 * its WalletConnect code, and from then on the exchange's trades are signed by the account's session key without a
 * popup (see packages/evm's SafeSessionExecutor and packages/evm-guard's SpotRiskGuard session keys).
 */
export function registerOneClickRoutes(app: FastifyInstance, deps: AppDeps): void {
  const oneClick = deps.oneClick;
  if (!oneClick) return;

  async function loadAccount(accountId: string, reply: FastifyReply) {
    const account = await deps.store.findAccountById(accountId);
    if (!account) {
      void reply.status(404).send({ error: "NOT_FOUND", message: "Account not found." });
      return undefined;
    }
    const chain = account.evmChainId ? oneClick!.chains[account.evmChainId] : undefined;
    if (!account.evmSafeAddress || !account.evmOwnerWalletAddress || !account.evmChainId || !chain) {
      void reply.status(400).send({ error: "NOT_SUPPORTED", message: "One-click trading needs a protected Safe on a supported chain." });
      return undefined;
    }
    return { account, chain, safe: getAddress(account.evmSafeAddress), owner: getAddress(account.evmOwnerWalletAddress), chainId: account.evmChainId };
  }

  /** The Safe must use the current Guard, the one that knows session keys. */
  async function guardIsCurrent(publicClient: PublicClient, safe: Address, guard: Address): Promise<boolean> {
    const raw = await publicClient.getStorageAt({ address: safe, slot: SAFE_GUARD_STORAGE_SLOT });
    if (!raw) return false;
    return isAddressEqual(getAddress(`0x${raw.slice(-40)}`), guard);
  }

  app.get("/v1/accounts/:accountId/one-click", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await loadAccount(accountId, reply);
    if (!loaded) return;

    const [record, sessions, trades, gasBalance, guardOk] = await Promise.all([
      oneClick.store.get(accountId),
      oneClick.store.listSessions(accountId),
      oneClick.store.listTrades(accountId, oneClick.maxTradesShown ?? 15),
      loaded.chain.gasWalletAddress ? loaded.chain.publicClient.getBalance({ address: loaded.chain.gasWalletAddress }) : Promise.resolve(undefined),
      guardIsCurrent(loaded.chain.publicClient, loaded.safe, loaded.chain.guardAddress),
    ]);

    return reply.send({
      available: true,
      status: record?.status ?? "off",
      sessionKeyAddress: record?.sessionWalletAddress ?? null,
      guardIsCurrent: guardOk,
      gasWalletLow: gasBalance !== undefined ? gasBalance < 3_000_000_000_000_000n : false,
      links: sessions.map((s) => ({ topic: s.topic, name: s.dappName, url: s.dappUrl, linkedAt: s.createdAt.toISOString(), expiresAt: s.expiresAt?.toISOString() ?? null })),
      trades: trades.map((t) => ({ at: t.createdAt.toISOString(), site: t.dappName, to: t.toAddress, valueWei: t.valueWei, txHash: t.txHash, result: t.result, message: t.message })),
    });
  });

  // Step 1: make the key and hand back the single transaction the owner sends from their own wallet.
  app.post("/v1/accounts/:accountId/one-click/prepare", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await loadAccount(accountId, reply);
    if (!loaded) return;

    if (!(await guardIsCurrent(loaded.chain.publicClient, loaded.safe, loaded.chain.guardAddress))) {
      return reply.status(409).send({
        error: "GUARD_OUTDATED",
        message: "This Safe still uses an older version of the MyPropGuard Guard, which does not support one-click trading. It needs the upgrade first.",
      });
    }

    let record = await oneClick.store.get(accountId);
    if (!record) {
      const wallet = await oneClick.createSessionWallet();
      await oneClick.store.createPending(accountId, wallet.id, wallet.address);
      record = await oneClick.store.get(accountId);
    } else if (record.status === "revoked") {
      // A revoked key is gone from the Safe; start over with a fresh one.
      return reply.status(409).send({ error: "REVOKED", message: "One-click trading was switched off for this account. Create a new account key to switch it on again." });
    }
    if (!record) return reply.status(500).send({ error: "INTERNAL_ERROR", message: "Could not create the session key." });

    const transaction = await buildEnableSessionKeyTx({
      publicClient: loaded.chain.publicClient,
      safeAddress: loaded.safe,
      ownerAddress: loaded.owner,
      multiSendCallOnly: loaded.chain.multiSendCallOnly,
      guardAddress: loaded.chain.guardAddress,
      sessionKeyAddress: getAddress(record.sessionWalletAddress),
    });
    return reply.send({ sessionKeyAddress: record.sessionWalletAddress, ownerAddress: loaded.owner, chainId: loaded.chainId, transaction });
  });

  // Step 2: the owner has sent it; check the chain, not the browser's word for it.
  app.post("/v1/accounts/:accountId/one-click/confirm", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await loadAccount(accountId, reply);
    if (!loaded) return;

    const record = await oneClick.store.get(accountId);
    if (!record) return reply.status(409).send({ error: "NOT_PREPARED", message: "Start from Enable one-click trading." });
    const active = await isSessionKeyActive(loaded.chain.publicClient, loaded.safe, loaded.chain.guardAddress, getAddress(record.sessionWalletAddress));
    if (!active) {
      return reply.status(409).send({ error: "NOT_ON_CHAIN_YET", message: "The key is not on your Safe yet. Wait for the transaction to confirm, then try again." });
    }
    await oneClick.store.setStatus(accountId, "enabled");
    return reply.send({ status: "enabled" });
  });

  // Step 3: link an exchange from its WalletConnect code.
  app.post("/v1/accounts/:accountId/one-click/pair", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await loadAccount(accountId, reply);
    if (!loaded) return;

    const record = await oneClick.store.get(accountId);
    if (record?.status !== "enabled") return reply.status(409).send({ error: "NOT_ENABLED", message: "Enable one-click trading first." });

    const uri = (request.body as { uri?: unknown } | undefined)?.uri;
    if (typeof uri !== "string" || uri.length > 2000) return reply.status(400).send({ error: "INVALID_INPUT", message: "Paste the WalletConnect code from the exchange." });
    try {
      await oneClick.service.pair(accountId, uri);
    } catch (error) {
      return reply.status(400).send({ error: "PAIRING_FAILED", message: error instanceof Error ? error.message : "Could not use that code. Copy a fresh one from the exchange." });
    }
    return reply.send({ ok: true, message: "Waiting for the exchange to confirm. This takes a few seconds." });
  });

  app.post("/v1/accounts/:accountId/one-click/disconnect", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const topic = (request.body as { topic?: unknown } | undefined)?.topic;
    if (typeof topic !== "string") return reply.status(400).send({ error: "INVALID_INPUT", message: "Which link?" });
    const session = await oneClick.store.getSession(topic);
    if (!session || session.accountId !== accountId) return reply.status(404).send({ error: "NOT_FOUND", message: "No such link." });
    await oneClick.service.disconnect(topic);
    return reply.send({ ok: true });
  });

  // Switching off: the server stops signing and drops every link at once; the owner then removes the key from the Safe.
  app.post("/v1/accounts/:accountId/one-click/disable", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!(await assertAccountOwnership(deps, request, reply, accountId))) return;
    const loaded = await loadAccount(accountId, reply);
    if (!loaded) return;

    const record = await oneClick.store.get(accountId);
    if (!record) return reply.send({ status: "off" });

    await oneClick.store.setStatus(accountId, "revoked");
    await oneClick.service.disconnectAccount(accountId);

    let transaction: Awaited<ReturnType<typeof buildDisableSessionKeyTx>> | null = null;
    try {
      transaction = await buildDisableSessionKeyTx({
        publicClient: loaded.chain.publicClient,
        safeAddress: loaded.safe,
        ownerAddress: loaded.owner,
        multiSendCallOnly: loaded.chain.multiSendCallOnly,
        guardAddress: loaded.chain.guardAddress,
        sessionKeyAddress: getAddress(record.sessionWalletAddress),
      });
    } catch {
      // The key was never added to the Safe, so there is nothing to remove on-chain.
    }
    return reply.send({ status: "revoked", chainId: loaded.chainId, ownerAddress: loaded.owner, transaction });
  });
}
