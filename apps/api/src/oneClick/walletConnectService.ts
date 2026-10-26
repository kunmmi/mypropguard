import { Core } from "@walletconnect/core";
import { WalletKit } from "@reown/walletkit";
import { buildApprovedNamespaces, getSdkError } from "@walletconnect/utils";
import { getAddress } from "viem";
import type { LinkKind, OneClickStore } from "./oneClickStore.js";
import { OneClickRequestHandler, SUPPORTED_METHODS } from "./oneClickRequestHandler.js";

export interface WalletConnectServiceOptions {
  projectId: string;
  /** WalletConnect's storage (Postgres-backed, so links survive a redeploy). */
  storage: unknown;
  store: OneClickStore;
  handler: OneClickRequestHandler;
  findAccount(accountId: string): Promise<{ evmSafeAddress?: string | null; evmChainId?: number | null } | undefined | null>;
  /** The account's active trading wallet, if any. Absent = links to a trading wallet are refused. */
  findFloat?(accountId: string): Promise<{ address: string; chainId: number; active: boolean } | undefined | null>;
  metadata: { name: string; description: string; url: string; icons: string[] };
  log?: (message: string) => void;
}

/** A trading wallet only ever answers these: no typed data, no raw signing. */
export const FLOAT_METHODS = ["eth_sendTransaction", "eth_accounts", "eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "personal_sign"] as const;

const PAIRING_WINDOW_MS = 5 * 60_000;
const EXTEND_EVERY_MS = 12 * 60 * 60_000;

/**
 * MyPropGuard as a WalletConnect "wallet" that stays online on the server. A trader links an exchange once (pasting
 * the exchange's WalletConnect code into the dashboard); after that the exchange sends its trades here and they are
 * signed by the account's session key, with no popup and no MyPropGuard page open.
 *
 * Only a link the signed-in owner just started from the dashboard is accepted: a proposal from a code nobody pasted
 * here is refused, so nobody else can attach a site to someone's account.
 */
export class WalletConnectService {
  private readonly pendingPairs = new Map<string, { accountId: string; at: number; kind: LinkKind }>();
  private readonly log: (message: string) => void;

  private constructor(
    private readonly kit: Awaited<ReturnType<typeof WalletKit.init>>,
    private readonly options: WalletConnectServiceOptions,
  ) {
    this.log = options.log ?? (() => undefined);
  }

  static async start(options: WalletConnectServiceOptions): Promise<WalletConnectService> {
    const core = new Core({ projectId: options.projectId, storage: options.storage as any });
    const kit = await WalletKit.init({ core, metadata: options.metadata });
    const service = new WalletConnectService(kit, options);
    service.listen();
    await service.reconcile();
    setInterval(() => void service.extendAll(), EXTEND_EVERY_MS).unref();
    return service;
  }

  /** Starts linking an exchange to an account from the exchange's WalletConnect code. */
  async pair(accountId: string, uri: string, kind: LinkKind = "safe"): Promise<void> {
    const trimmed = uri.trim();
    const topic = /^wc:([0-9a-f]{64})@2/i.exec(trimmed)?.[1];
    if (!topic) throw new Error("That is not a WalletConnect code. On the exchange, choose WalletConnect, then copy the code (it starts with wc:).");
    this.pendingPairs.set(topic, { accountId, at: Date.now(), kind });
    try {
      await this.kit.pair({ uri: trimmed });
    } catch (error) {
      this.pendingPairs.delete(topic);
      throw error;
    }
  }

  /** Closes the connection to the relay, so the next copy of the server can take over without two clients fighting. */
  async stop(): Promise<void> {
    try {
      await this.kit.core.relayer.transportClose();
    } catch {
      // Already closed.
    }
  }

  async disconnect(topic: string): Promise<void> {
    try {
      await this.kit.disconnectSession({ topic, reason: getSdkError("USER_DISCONNECTED") });
    } catch {
      // Already gone on the exchange's side; fall through and forget it here.
    }
    await this.options.store.removeSession(topic);
  }

  /** Ends every link of one account (used when one-click trading is switched off). */
  async disconnectAccount(accountId: string, kind?: LinkKind): Promise<void> {
    for (const session of await this.options.store.listSessions(accountId)) {
      if (!kind || session.kind === kind) await this.disconnect(session.topic);
    }
  }

  private listen(): void {
    this.kit.on("session_proposal", (proposal) => void this.onProposal(proposal));
    this.kit.on("session_request", (event) => void this.onRequest(event));
    this.kit.on("session_delete", (event) => void this.options.store.removeSession(event.topic).catch(() => undefined));
  }

  private async onProposal(proposal: any): Promise<void> {
    const reject = async (why: string) => {
      this.log(`WalletConnect proposal ${proposal.id} refused: ${why}`);
      await this.kit.rejectSession({ id: proposal.id, reason: getSdkError("USER_REJECTED") }).catch(() => undefined);
    };

    const pairingTopic: string | undefined = proposal.params?.pairingTopic;
    const pending = pairingTopic ? this.pendingPairs.get(pairingTopic) : undefined;
    if (!pending || Date.now() - pending.at > PAIRING_WINDOW_MS) return reject("not started from the dashboard");
    this.pendingPairs.delete(pairingTopic!);

    let chain: string;
    let address: string;
    let methods: readonly string[];
    if (pending.kind === "float") {
      const wallet = await this.options.findFloat?.(pending.accountId);
      if (!wallet || !wallet.active) return reject("the account has no active trading wallet");
      chain = `eip155:${wallet.chainId}`;
      address = wallet.address;
      methods = FLOAT_METHODS;
    } else {
      const [record, account] = await Promise.all([this.options.store.get(pending.accountId), this.options.findAccount(pending.accountId)]);
      if (!record || record.status !== "enabled") return reject("one-click trading is not enabled for the account");
      if (!account?.evmSafeAddress || !account.evmChainId) return reject("the account has no Safe");
      chain = `eip155:${account.evmChainId}`;
      address = account.evmSafeAddress;
      methods = SUPPORTED_METHODS;
    }
    let namespaces;
    try {
      namespaces = buildApprovedNamespaces({
        proposal: proposal.params,
        supportedNamespaces: {
          eip155: {
            chains: [chain],
            methods: [...methods],
            events: ["accountsChanged", "chainChanged"],
            accounts: [`${chain}:${getAddress(address)}`],
          },
        },
      });
    } catch (error) {
      return reject(`the site needs something this account cannot do (${error instanceof Error ? error.message : error})`);
    }

    const session = await this.kit.approveSession({ id: proposal.id, namespaces });
    const meta = proposal.params?.proposer?.metadata;
    await this.options.store.addSession({
      topic: session.topic,
      accountId: pending.accountId,
      kind: pending.kind,
      dappName: meta?.name ?? null,
      dappUrl: meta?.url ?? null,
      expiresAt: new Date(session.expiry * 1000),
    });
    this.log(`Linked ${meta?.name ?? "a site"} to ${pending.kind === "float" ? "the trading wallet of" : "account"} ${pending.accountId}`);
  }

  private async onRequest(event: any): Promise<void> {
    const { id, topic, params } = event;
    const method: string = params?.request?.method ?? "?";
    const startedAt = Date.now();
    this.log(`request ${method} (id ${id}) from link ${String(topic).slice(0, 8)}`);
    let reply;
    try {
      reply = await this.options.handler.handle(topic, params.chainId, params.request);
    } catch (error) {
      reply = { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
    const outcome = "error" in reply ? `error ${reply.error.code}` : "ok";
    const decidedMs = Date.now() - startedAt;
    try {
      await this.kit.respondSessionRequest({ topic, response: { id, jsonrpc: "2.0", ...reply } as any });
      this.log(`answered ${method} (id ${id}) ${outcome}: decided in ${decidedMs} ms, delivered in ${Date.now() - startedAt} ms`);
    } catch (error) {
      this.log(`COULD NOT DELIVER the answer to ${method} (id ${id}, ${outcome}) after ${Date.now() - startedAt} ms: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Forgets links the exchange or the relay already ended, so the dashboard never lists a dead link. */
  private async reconcile(): Promise<void> {
    const active = new Set(Object.keys(this.kit.getActiveSessions()));
    for (const topic of await this.options.store.listAllSessionTopics()) {
      if (!active.has(topic)) await this.options.store.removeSession(topic);
    }
  }

  /** Links last a week unless extended, so extend them regularly: a link then lasts until it is switched off. */
  private async extendAll(): Promise<void> {
    for (const topic of Object.keys(this.kit.getActiveSessions())) {
      try {
        await this.kit.extendSession({ topic });
      } catch (error) {
        this.log(`Could not extend link ${topic.slice(0, 8)}: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
