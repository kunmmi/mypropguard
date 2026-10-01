import type {
  ActionHasher,
  AgentWalletProvisioner,
  EvmSafeProvisioner,
  OrderCanceller,
  OrderLifecycleReader,
  OrderSubmitter,
  SignerGateway,
} from "@mypropguard/domain";
import { createPool, PgExecutionSequencer, PgRiskLedgerStore } from "@mypropguard/risk-ledger";
import {
  HyperliquidInfoClient,
  HyperliquidActionHasher,
  HyperliquidAgentWalletProvisioner,
  HyperliquidOrderLifecycle,
  PrivyClient,
  PrivySignerGateway,
} from "@mypropguard/hyperliquid";
import { FakeSignerGateway, PlaceholderActionHasher } from "@mypropguard/execution";
import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { SafeDeployer, EvmChainSafeProvisioner } from "@mypropguard/evm";
import { createAuthPreHandler } from "./auth.js";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Start local Supabase Postgres (`supabase start`) and set it to the printed connection string.",
  );
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_ANON_KEY are required so every request can be authenticated against real users - without them this server would let any caller act as any accountId.",
  );
}
const authPreHandler = createAuthPreHandler(SUPABASE_URL, SUPABASE_ANON_KEY);

const pool = createPool(DATABASE_URL);
const store = new PgRiskLedgerStore(pool);
// Read-only public Hyperliquid Info API client (Phase 2) — no credentials,
// cannot place orders or move funds.
const venueReader = new HyperliquidInfoClient();
// Durable: an in-memory counter loses its high-water mark on every restart,
// which risks re-issuing a nonce Hyperliquid already saw for this account -
// it rejects anything lower than the last one it received. Real Postgres
// here regardless of ENABLE_REAL_SIGNER, since DATABASE_URL is required either way.
const executionSequencer = new PgExecutionSequencer(pool);

// Defaults to the offline scaffold (fake signer, placeholder hash). Set
// ENABLE_REAL_SIGNER=true (plus Privy credentials and an agent wallet) to
// switch /v1/execution/dry-run to real Hyperliquid hashing + real Privy
// signing instead — still no venue submission either way.
let hasher: ActionHasher = new PlaceholderActionHasher();
let signer: SignerGateway = new FakeSignerGateway(hasher);
let orderSubmitter: OrderSubmitter | undefined;
let orderCanceller: OrderCanceller | undefined;
let orderLifecycleReader: OrderLifecycleReader | undefined;
let agentWalletProvisioner: AgentWalletProvisioner | undefined;
let signerFactory: ((walletId: string, walletAddress: string) => SignerGateway) | undefined;
let orderLifecycleFactory: ((walletId: string) => OrderSubmitter & OrderCanceller & OrderLifecycleReader) | undefined;

if (process.env.ENABLE_REAL_SIGNER === "true") {
  const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AGENT_WALLET_ID, PRIVY_AGENT_WALLET_ADDRESS } = process.env;
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_AGENT_WALLET_ID || !PRIVY_AGENT_WALLET_ADDRESS) {
    throw new Error(
      "ENABLE_REAL_SIGNER=true requires PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AGENT_WALLET_ID, and PRIVY_AGENT_WALLET_ADDRESS.",
    );
  }
  const privyClient = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });
  hasher = new HyperliquidActionHasher();
  signer = new PrivySignerGateway({
    privyClient,
    walletId: PRIVY_AGENT_WALLET_ID,
    walletAddress: PRIVY_AGENT_WALLET_ADDRESS as `0x${string}`,
    isTestnet: true,
  });
  // Reuses the same Privy credentials - this is just "create a wallet",
  // not "sign with the server-wide one" - genuinely independent of the
  // signing pipeline this flag otherwise gates, but not worth a third flag.
  agentWalletProvisioner = new HyperliquidAgentWalletProvisioner(privyClient);
  // Lets each account with its own provisioned wallet (agentWalletId) sign
  // with that wallet instead of the single shared one above - see
  // resolveSignerForAccount in app.ts.
  signerFactory = (walletId, walletAddress) =>
    new PrivySignerGateway({
      privyClient,
      walletId,
      walletAddress: walletAddress as `0x${string}`,
      isTestnet: true,
    });
  // eslint-disable-next-line no-console
  console.log("Real signer enabled: HyperliquidActionHasher + PrivySignerGateway. New accounts get a real provisioned wallet.");

  // Separate, more cautious gate: real signing alone can never move
  // anything; this is the flag that actually lets /v1/execution/dry-run
  // reach a real venue, and lets order status/cancel act on the result.
  if (process.env.ENABLE_VENUE_SUBMISSION === "true") {
    const lifecycle = new HyperliquidOrderLifecycle({
      privyClient,
      walletId: PRIVY_AGENT_WALLET_ID,
      isTestnet: true,
    });
    orderSubmitter = lifecycle;
    orderCanceller = lifecycle;
    orderLifecycleReader = lifecycle;
    // Per-account equivalent of signerFactory - see resolveOrderSubmitterForAccount and siblings in app.ts.
    orderLifecycleFactory = (walletId) => new HyperliquidOrderLifecycle({ privyClient, walletId, isTestnet: true });
    // eslint-disable-next-line no-console
    console.log("Venue submission enabled: orders placed via /v1/execution/dry-run now actually reach Hyperliquid.");
  }
}

// EVM-chain Safe provisioning (see packages/evm-guard, packages/evm) - opt-in per chain, off by
// default. Only Arbitrum/GMX is wired here for now (the first and most-proven EVM integration -
// see packages/evm-guard/ROADMAP.md); adding BSC/Ethereum follows the same pattern with their
// own env var prefix and viem chain import.
const evmSafeProvisioners: Record<number, EvmSafeProvisioner> = {};

if (process.env.ENABLE_EVM_ARBITRUM_PROVISIONING === "true") {
  const {
    EVM_ARBITRUM_RPC_URL,
    EVM_ARBITRUM_ADMIN_PRIVATE_KEY,
    EVM_ARBITRUM_SAFE_PROXY_FACTORY,
    EVM_ARBITRUM_SAFE_SINGLETON,
    EVM_ARBITRUM_SAFE_GUARD_SETUP,
    EVM_ARBITRUM_GMX_GUARD_ADDRESS,
  } = process.env;
  if (
    !EVM_ARBITRUM_RPC_URL ||
    !EVM_ARBITRUM_ADMIN_PRIVATE_KEY ||
    !EVM_ARBITRUM_SAFE_PROXY_FACTORY ||
    !EVM_ARBITRUM_SAFE_SINGLETON ||
    !EVM_ARBITRUM_SAFE_GUARD_SETUP ||
    !EVM_ARBITRUM_GMX_GUARD_ADDRESS
  ) {
    throw new Error(
      "ENABLE_EVM_ARBITRUM_PROVISIONING=true requires EVM_ARBITRUM_RPC_URL, EVM_ARBITRUM_ADMIN_PRIVATE_KEY, EVM_ARBITRUM_SAFE_PROXY_FACTORY, EVM_ARBITRUM_SAFE_SINGLETON, EVM_ARBITRUM_SAFE_GUARD_SETUP, and EVM_ARBITRUM_GMX_GUARD_ADDRESS.",
    );
  }
  const adminAccount = privateKeyToAccount(EVM_ARBITRUM_ADMIN_PRIVATE_KEY as `0x${string}`);
  const transport = http(EVM_ARBITRUM_RPC_URL);
  const publicClient = createPublicClient({ chain: arbitrum, transport });
  const walletClient = createWalletClient({ chain: arbitrum, transport, account: adminAccount });
  const safeDeployer = new SafeDeployer(publicClient, walletClient, adminAccount, arbitrum, {
    safeProxyFactory: EVM_ARBITRUM_SAFE_PROXY_FACTORY as Address,
    safeSingleton: EVM_ARBITRUM_SAFE_SINGLETON as Address,
    safeGuardSetup: EVM_ARBITRUM_SAFE_GUARD_SETUP as Address,
  });
  evmSafeProvisioners[arbitrum.id] = new EvmChainSafeProvisioner(
    safeDeployer,
    arbitrum.id,
    EVM_ARBITRUM_GMX_GUARD_ADDRESS as Address,
  );
  // eslint-disable-next-line no-console
  console.log("EVM Safe provisioning enabled for Arbitrum (GMX). New accounts on that chain get a real provisioned Safe.");
}

const app = buildApp({
  store,
  venueReader,
  executionSequencer,
  hasher,
  signer,
  orderSubmitter,
  orderCanceller,
  orderLifecycleReader,
  agentWalletProvisioner,
  signerFactory,
  orderLifecycleFactory,
  authPreHandler,
  evmSafeProvisioners,
});

const port = Number(process.env.PORT ?? 3000);
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`mypropguard api listening on :${port}`);
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
