import type {
  ActionHasher,
  AgentWalletProvisioner,
  EvmGuardRuleSyncer,
  EvmSafeEquityReader,
  EvmSafeStateReader,
  EvmTokenDiscovery,
  EvmSafeProvisioner,
  OrderCanceller,
  OrderLifecycleReader,
  OrderSubmitter,
  SignerGateway,
  VenueEnforcer,
} from "@mypropguard/domain";
import {
  createPool,
  PgExecutionSequencer,
  PgRiskLedgerStore,
  WatcherMemory,
  reconcileAllEvmAccountsWithDailyLossRule,
  watchAllHyperliquidAccounts,
} from "@mypropguard/risk-ledger";
import {
  HYPERLIQUID_MAINNET_INFO_URL,
  HYPERLIQUID_TESTNET_INFO_URL,
  HyperliquidEnforcer,
  HyperliquidInfoClient,
  HyperliquidActionHasher,
  HyperliquidAgentWalletProvisioner,
  HyperliquidOrderLifecycle,
  PrivyClient,
  PrivySignerGateway,
} from "@mypropguard/hyperliquid";
import { FakeSignerGateway, PlaceholderActionHasher } from "@mypropguard/execution";
import { createPublicClient, createWalletClient, http, type Address, type Chain, type PublicClient, type WalletClient, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, bsc, mainnet } from "viem/chains";
import {
  SafeDeployer,
  EvmChainSafeProvisioner,
  SpotGuardClient,
  EvmChainGuardRuleSyncer,
  PancakeSwapEquityReader,
  GoldRushTokenDiscovery,
  MoralisTokenDiscovery,
  SafeTxServiceTokenDiscovery,
  SafeStateReader,
  SafeSessionExecutor,
  FloatExecutor,
  FloatValuer,
  type FloatWalletSigner,
} from "@mypropguard/evm";
import { OneClickStore } from "./oneClick/oneClickStore.js";
import { OneClickRequestHandler } from "./oneClick/oneClickRequestHandler.js";
import { PgWalletConnectStorage } from "./oneClick/pgWalletConnectStorage.js";
import { WalletConnectService } from "./oneClick/walletConnectService.js";
import { forwardingService } from "./oneClick/forwardingService.js";
import { PgLeaseStore, WalletConnectLease, handOver } from "./oneClick/walletConnectLease.js";
import type { OneClickDeps } from "./routes/oneClick.js";
import type { FloatDeps } from "./routes/float.js";
import { FloatStore } from "./float/floatStore.js";
import { FloatRequestHandler } from "./float/floatRequestHandler.js";
import { loadWalletAccountRules } from "./float/accountRules.js";
import { FloatRiskGuard } from "./float/floatRiskGuard.js";
import type { SolanaDeps } from "./routes/solana.js";
import { SolanaStore } from "./solana/solanaStore.js";
import { SolanaRequestHandler } from "./solana/solanaRequestHandler.js";

// PancakeSwap's own canonical BSC mainnet addresses - public, not secrets, so hardcoded rather
// than made configurable (one less thing to misconfigure). See PancakeSwapEquityReader's NatSpec
// for why pool-reserve pricing (not an external oracle) is used here.
const PANCAKESWAP_V2_FACTORY_BSC: Address = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const WBNB_ADDRESS_BSC: Address = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_ADDRESS_BSC: Address = "0x55d398326f99059fF775485246999027B3197955";
// Stablecoins and wrapped BNB that are always watched for deposits (see SafeStateReader). Same
// list the Guard tracks as "money".
const BSC_DEPOSIT_TOKENS: Address[] = [
  WBNB_ADDRESS_BSC,
  USDT_ADDRESS_BSC,
  "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC
  "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", // BUSD
  "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", // FDUSD
  "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", // DAI
  "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", // USD1
  "0x40af3827F39D0EAcBF4A168f8D4ee67c121D11c9", // TUSD
];
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
// HYPERLIQUID_NETWORK picks the venue network for reads and for everything that signs ("testnet" or
// "mainnet"). Left unset it keeps the long-standing behaviour: public reads on mainnet, signing on testnet.
// The watcher refuses to start without it set explicitly, so reads and orders can never target different networks.
const hlNetworkEnv = process.env.HYPERLIQUID_NETWORK?.trim().toLowerCase();
if (hlNetworkEnv && hlNetworkEnv !== "testnet" && hlNetworkEnv !== "mainnet") {
  throw new Error('HYPERLIQUID_NETWORK must be "testnet" or "mainnet".');
}
const hlIsTestnet = hlNetworkEnv !== "mainnet";
const venueReader = new HyperliquidInfoClient(
  hlNetworkEnv ? { baseUrl: hlIsTestnet ? HYPERLIQUID_TESTNET_INFO_URL : HYPERLIQUID_MAINNET_INFO_URL } : {},
);
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
let privyClientForWatcher: PrivyClient | undefined;

if (process.env.ENABLE_REAL_SIGNER === "true") {
  const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AGENT_WALLET_ID, PRIVY_AGENT_WALLET_ADDRESS } = process.env;
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_AGENT_WALLET_ID || !PRIVY_AGENT_WALLET_ADDRESS) {
    throw new Error(
      "ENABLE_REAL_SIGNER=true requires PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AGENT_WALLET_ID, and PRIVY_AGENT_WALLET_ADDRESS.",
    );
  }
  const privyClient = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });
  privyClientForWatcher = privyClient;
  hasher = new HyperliquidActionHasher();
  signer = new PrivySignerGateway({
    privyClient,
    walletId: PRIVY_AGENT_WALLET_ID,
    walletAddress: PRIVY_AGENT_WALLET_ADDRESS as `0x${string}`,
    isTestnet: hlIsTestnet,
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
      isTestnet: hlIsTestnet,
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
      isTestnet: hlIsTestnet,
    });
    orderSubmitter = lifecycle;
    orderCanceller = lifecycle;
    orderLifecycleReader = lifecycle;
    // Per-account equivalent of signerFactory - see resolveOrderSubmitterForAccount and siblings in app.ts.
    orderLifecycleFactory = (walletId) => new HyperliquidOrderLifecycle({ privyClient, walletId, isTestnet: hlIsTestnet });
    // eslint-disable-next-line no-console
    console.log("Venue submission enabled: orders placed via /v1/execution/dry-run now actually reach Hyperliquid.");
  }
}

// EVM-chain Safe provisioning (see packages/evm-guard, packages/evm) - opt-in per chain, off by
// default. Each chain needs its own env var prefix, viem Chain, and already-deployed Guard
// contract address (see packages/evm-guard/ROADMAP.md for which chains have a Guard built).
// "spot" chains (PancakeSwap/Uniswap) also get an EvmGuardRuleSyncer, built from the exact same
// admin wallet/RPC config - that Guard's setTokenLimit/setMaxTradesPerDay are independently
// settable per rule, unlike GMX's combined setLimits, which needs its own, separate design before
// a single rule change could safely push to it without clobbering the other limit.
/**
 * Reads a private key from the environment. Pasted values often carry spaces, quotes or a missing "0x", which are
 * harmless and fixed here. Anything else that is not 64 hex characters is reported by variable name and length only,
 * never by value, so a wrong paste (the wallet address instead of the key, a cut-off key) is easy to spot in the log.
 */
function envPrivateKey(name: string, value: string | undefined): `0x${string}` | undefined {
  const cleaned = value?.trim().replace(/^["']|["']$/g, "").trim();
  if (!cleaned) return undefined;
  const hex = cleaned.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const looksLikeAddress = /^0x[0-9a-fA-F]{40}$/i.test(cleaned);
    throw new Error(
      `${name} is not a valid private key (expected 64 hex characters, optionally starting with 0x; got ${cleaned.length} characters${looksLikeAddress ? ", which is the length of a wallet ADDRESS - the private key is the longer secret" : ""}).`,
    );
  }
  return `0x${hex}`;
}

function envAddress(value: string | undefined): Address | undefined {
  const trimmed = value?.trim();
  return trimmed ? getAddress(trimmed.toLowerCase()) : undefined;
}

function configureEvmChainProvisioning(
  label: string,
  envPrefix: string,
  chain: Chain,
  guardLabel: string,
  guardKind: "gmx" | "spot",
  /**
   * Only passed for chains with a built EvmSafeEquityReader (currently BSC/PancakeSwap only - see
   * PancakeSwapEquityReader; Ethereum/Uniswap has no equivalent yet). When present, also builds an
   * equity reader from the same publicClient, so checkAndEnforceDailyLossFreeze has live data for
   * that chain.
   */
  equityReaderConfig?: {
    factoryAddress: Address;
    wrappedNativeAddress: Address;
    stablecoinAddress: Address;
    depositTokens: Address[];
    moralisChain: string;
    goldRushChain: string;
    safeTxServiceSlug: string;
  },
): {
  provisioner: EvmSafeProvisioner;
  guardSyncer?: EvmGuardRuleSyncer;
  equityReader?: EvmSafeEquityReader;
  stateReader?: EvmSafeStateReader;
  tokenDiscovery?: EvmTokenDiscovery;
  /** What one-click trading reuses: the chain's clients, the gas-paying admin wallet and the Guard. */
  clients: { publicClient: PublicClient; walletClient: WalletClient; adminAccount: ReturnType<typeof privateKeyToAccount>; guardAddress: Address; rpcUrl: string };
} | undefined {
  if (process.env[`ENABLE_EVM_${envPrefix}_PROVISIONING`] !== "true") return undefined;

  // Values pasted into a host's settings page often carry a stray space or newline, and an address
  // copied by eye can have a wrong capital letter (which fails the checksum). Trim everything and
  // normalize addresses (a lowercase address is always valid) so a cosmetic slip cannot take the
  // server down.
  const rpcUrl = process.env[`EVM_${envPrefix}_RPC_URL`]?.trim();
  const adminPrivateKey = envPrivateKey(`EVM_${envPrefix}_ADMIN_PRIVATE_KEY`, process.env[`EVM_${envPrefix}_ADMIN_PRIVATE_KEY`]);
  const safeProxyFactory = envAddress(process.env[`EVM_${envPrefix}_SAFE_PROXY_FACTORY`]);
  const safeSingleton = envAddress(process.env[`EVM_${envPrefix}_SAFE_SINGLETON`]);
  const safeGuardSetup = envAddress(process.env[`EVM_${envPrefix}_SAFE_GUARD_SETUP`]);
  const guardAddress = envAddress(process.env[`EVM_${envPrefix}_${guardLabel}_GUARD_ADDRESS`]);

  if (!rpcUrl || !adminPrivateKey || !safeProxyFactory || !safeSingleton || !safeGuardSetup || !guardAddress) {
    throw new Error(
      `ENABLE_EVM_${envPrefix}_PROVISIONING=true requires EVM_${envPrefix}_RPC_URL, EVM_${envPrefix}_ADMIN_PRIVATE_KEY, EVM_${envPrefix}_SAFE_PROXY_FACTORY, EVM_${envPrefix}_SAFE_SINGLETON, EVM_${envPrefix}_SAFE_GUARD_SETUP, and EVM_${envPrefix}_${guardLabel}_GUARD_ADDRESS.`,
    );
  }

  const adminAccount = privateKeyToAccount(adminPrivateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account: adminAccount });
  const safeDeployer = new SafeDeployer(publicClient, walletClient, adminAccount, chain, {
    safeProxyFactory: safeProxyFactory as Address,
    safeSingleton: safeSingleton as Address,
    safeGuardSetup: safeGuardSetup as Address,
  });
  const provisioner = new EvmChainSafeProvisioner(safeDeployer, chain.id, guardAddress as Address);

  let guardSyncer: EvmGuardRuleSyncer | undefined;
  if (guardKind === "spot") {
    const spotGuardClient = new SpotGuardClient(publicClient, walletClient, adminAccount, chain, guardAddress as Address);
    guardSyncer = new EvmChainGuardRuleSyncer(publicClient, spotGuardClient);
  }

  let equityReader: EvmSafeEquityReader | undefined;
  let stateReader: EvmSafeStateReader | undefined;
  let tokenDiscovery: EvmTokenDiscovery | undefined;
  if (equityReaderConfig) {
    equityReader = new PancakeSwapEquityReader(
      publicClient,
      equityReaderConfig.factoryAddress,
      equityReaderConfig.wrappedNativeAddress,
      equityReaderConfig.stablecoinAddress,
    );
    // Reads balances, the Safe's transaction count and the Guard's withdrawal totals with plain state
    // calls (free public RPCs refuse event logs), so daily loss is measured on trading only.
    stateReader = new SafeStateReader(publicClient, {
      guardAddress: guardAddress as Address,
      baseTokens: equityReaderConfig.depositTokens,
    });
    // Finding the tokens a Safe holds: by default Safe's own free Transaction Service, which indexes every
    // transfer for Safes built on the L2 singleton and needs no key. TOKEN_DISCOVERY_PROVIDER can pick
    // "goldrush" or "moralis" instead (each needs its key); "none" turns discovery off, in which case
    // only BNB, the base tokens and tokens with a per-token rule are valued.
    const provider = (process.env.TOKEN_DISCOVERY_PROVIDER ?? "safe").trim().toLowerCase();
    const goldRushApiKey = process.env.GOLDRUSH_API_KEY?.trim();
    const moralisApiKey = process.env.MORALIS_API_KEY?.trim();
    if (provider === "safe") {
      tokenDiscovery = new SafeTxServiceTokenDiscovery({
        chainSlug: equityReaderConfig.safeTxServiceSlug,
        apiKey: process.env.SAFE_API_KEY?.trim() || undefined,
      });
    } else if (provider === "goldrush" && goldRushApiKey) {
      tokenDiscovery = new GoldRushTokenDiscovery({ apiKey: goldRushApiKey, chain: equityReaderConfig.goldRushChain });
    } else if (provider === "moralis" && moralisApiKey) {
      tokenDiscovery = new MoralisTokenDiscovery({ apiKey: moralisApiKey, chain: equityReaderConfig.moralisChain });
    } else {
      // eslint-disable-next-line no-console
      console.warn(`Token discovery is off for ${label} (TOKEN_DISCOVERY_PROVIDER=${provider}): equity will not include tokens bought outside a per-token rule, so buys can look like losses.`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`EVM Safe provisioning enabled for ${label}. New accounts on that chain get a real provisioned Safe.`);
  return {
    provisioner,
    guardSyncer,
    equityReader,
    stateReader,
    tokenDiscovery,
    clients: { publicClient: publicClient as any, walletClient: walletClient as any, adminAccount, guardAddress: guardAddress as Address, rpcUrl },
  };
}

const evmSafeProvisioners: Record<number, EvmSafeProvisioner> = {};
const evmGuardSyncers: Record<number, EvmGuardRuleSyncer> = {};
const evmEquityReaders: Record<number, EvmSafeEquityReader> = {};
const evmStateReaders: Record<number, EvmSafeStateReader> = {};
const evmTokenDiscoveries: Record<number, EvmTokenDiscovery> = {};

const arbitrumConfig = configureEvmChainProvisioning("Arbitrum (GMX)", "ARBITRUM", arbitrum, "GMX", "gmx");
if (arbitrumConfig) evmSafeProvisioners[arbitrum.id] = arbitrumConfig.provisioner;

const bscConfig = configureEvmChainProvisioning("BSC (PancakeSwap)", "BSC", bsc, "PANCAKESWAP", "spot", {
  factoryAddress: PANCAKESWAP_V2_FACTORY_BSC,
  wrappedNativeAddress: WBNB_ADDRESS_BSC,
  stablecoinAddress: USDT_ADDRESS_BSC,
  depositTokens: BSC_DEPOSIT_TOKENS,
  moralisChain: "bsc",
  goldRushChain: "bsc-mainnet",
  safeTxServiceSlug: "bnb",
});
if (bscConfig) {
  evmSafeProvisioners[bsc.id] = bscConfig.provisioner;
  if (bscConfig.guardSyncer) evmGuardSyncers[bsc.id] = bscConfig.guardSyncer;
  if (bscConfig.equityReader) evmEquityReaders[bsc.id] = bscConfig.equityReader;
  if (bscConfig.stateReader) evmStateReaders[bsc.id] = bscConfig.stateReader;
  if (bscConfig.tokenDiscovery) evmTokenDiscoveries[bsc.id] = bscConfig.tokenDiscovery;
}

// Ethereum/Uniswap has no EvmSafeEquityReader yet (would need a Uniswap-specific factory/WETH/
// USDC wiring, analogous to PancakeSwapEquityReader) - max-daily-loss freezing isn't live for
// Ethereum accounts yet even though the freeze mechanism itself works on any spot Guard.
const ethereumConfig = configureEvmChainProvisioning("Ethereum (Uniswap)", "ETHEREUM", mainnet, "UNISWAP", "spot");
if (ethereumConfig) {
  evmSafeProvisioners[mainnet.id] = ethereumConfig.provisioner;
  if (ethereumConfig.guardSyncer) evmGuardSyncers[mainnet.id] = ethereumConfig.guardSyncer;
}

// Hyperliquid watcher (see packages/risk-ledger/src/watcher.ts). Off by default. "log" only records what it would do;
// "enforce" really cancels orders and places reduce-only closes through each account's own agent wallet. It needs
// the real signer (Privy) for "enforce", and HYPERLIQUID_NETWORK set explicitly so reads and orders share a network.
const watcherEnabled = process.env.ENABLE_HL_WATCHER === "true";
const watcherMode: "log" | "enforce" = process.env.HL_WATCHER_MODE?.trim().toLowerCase() === "enforce" ? "enforce" : "log";
if (watcherEnabled) {
  if (!hlNetworkEnv) {
    throw new Error('ENABLE_HL_WATCHER=true requires HYPERLIQUID_NETWORK to be set to "testnet" or "mainnet".');
  }
  if (watcherMode === "enforce" && !privyClientForWatcher) {
    throw new Error("HL_WATCHER_MODE=enforce requires ENABLE_REAL_SIGNER=true (the agent wallets are Privy wallets).");
  }
}

// One-click trading (see apps/api/src/oneClick, packages/evm's SafeSessionExecutor, SpotRiskGuard session keys). The
// server stays connected to exchanges as a WalletConnect "wallet" and signs each trade with the account's session key,
// a Privy wallet the Guard lets trade and nothing else. Off by default.
// A problem here (a missing or wrong WalletConnect id, the relay being unreachable) must not take the whole API down:
// it would stop the Hyperliquid watcher and every other route too. So it is reported clearly and one-click stays off.
async function setUpOneClick(): Promise<OneClickDeps | undefined> {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID?.trim();
  const { PRIVY_APP_ID, PRIVY_APP_SECRET } = process.env;
  if (!projectId || !PRIVY_APP_ID || !PRIVY_APP_SECRET) {
    throw new Error("it needs WALLETCONNECT_PROJECT_ID (free, from cloud.reown.com), PRIVY_APP_ID and PRIVY_APP_SECRET");
  }
  if (!bscConfig) throw new Error("it needs ENABLE_EVM_BSC_PROVISIONING=true (it trades on the BSC Safes)");

  const privy = new PrivyClient({ appId: PRIVY_APP_ID, appSecret: PRIVY_APP_SECRET });
  const { publicClient, adminAccount, guardAddress, rpcUrl } = bscConfig.clients;
  // The wallet that pays gas for one-click trades. It holds no power over anyone's funds. Defaults to the Guard's
  // admin wallet; set EVM_BSC_RELAYER_PRIVATE_KEY to use a separate one.
  const relayerKey = envPrivateKey("EVM_BSC_RELAYER_PRIVATE_KEY", process.env.EVM_BSC_RELAYER_PRIVATE_KEY);
  const gasAccount = relayerKey ? privateKeyToAccount(relayerKey) : adminAccount;
  const gasWalletClient: WalletClient = createWalletClient({ chain: bsc, transport: http(rpcUrl), account: gasAccount });
  const executor = new SafeSessionExecutor(publicClient, gasWalletClient, gasAccount, bsc, privy);

  const oneClickStore = new OneClickStore(pool);
  const findAccount = (accountId: string) => store.findAccountById(accountId);
  // The trading wallet: a plain wallet sites like four.meme can log in to, judged by MyPropGuard's rules before every
  // signature. Off unless ENABLE_FLOAT_WALLET=true.
  const floatEnabled = process.env.ENABLE_FLOAT_WALLET === "true";
  const floatStore = new FloatStore(pool);
  const floatSigner: FloatWalletSigner = {
    sendTransaction: (walletId, tx) => privy.sendTransaction(walletId, `eip155:${bsc.id}`, tx),
    personalSign: (walletId, message) => privy.personalSign(walletId, message),
  };
  const floatValuer = new FloatValuer(publicClient);
  // What one BNB is worth in dollars, for the loss and size rules (which the owner sets in dollars). Cached for a minute.
  const bnbPrice = { at: 0, usd: 0 };
  const usdPerBnb = async (): Promise<number> => {
    if (Date.now() - bnbPrice.at < 60_000 && bnbPrice.usd > 0) return bnbPrice.usd;
    const reader = evmEquityReaders?.[bsc.id];
    if (!reader) throw new Error("no price source for BNB");
    const usd = (await reader.getTokenValueUsd("0x0000000000000000000000000000000000000000", 10n ** 18n)).toNumber();
    if (!(usd > 0)) throw new Error("BNB price unavailable");
    bnbPrice.at = Date.now();
    bnbPrice.usd = usd;
    return usd;
  };
  const floatRiskGuard = new FloatRiskGuard({ store: floatStore, valuer: floatValuer, usdPerBnb });
  const floatHandler = floatEnabled
    ? new FloatRequestHandler({
        store: floatStore,
        executor: new FloatExecutor({ publicClient, signer: floatSigner }),
        signer: floatSigner,
        accountRules: (accountId) => loadWalletAccountRules(store, accountId),
        riskGuard: floatRiskGuard,
        log: (message) => console.log(`[float] ${message}`),
      })
    : undefined;
  // The Solana wallet (pump.fun and similar): links a site and signs its login; it records transaction requests but signs
  // none yet. Off unless ENABLE_SOLANA_WALLET=true.
  const solanaEnabled = process.env.ENABLE_SOLANA_WALLET === "true";
  const solanaStore = new SolanaStore(pool);
  const solanaHandler = solanaEnabled
    ? new SolanaRequestHandler({
        store: solanaStore,
        signer: { signMessage: (walletId, messageBase64) => privy.solanaSignMessage(walletId, messageBase64) },
        log: (message) => console.log(`[solana] ${message}`),
      })
    : undefined;
  const handler = new OneClickRequestHandler({ store: oneClickStore, findAccount, executors: { [bsc.id]: executor }, float: floatHandler, solana: solanaHandler });
  const publicUrl = process.env.PUBLIC_WEB_URL?.trim() || "https://mypropguard.com";
  // Only one copy of the server may own the WalletConnect connection. The host runs the old and the new copy side by
  // side during a deploy, so the new one waits for the old one to let go. This runs in the background: the server
  // itself must come up at once so the host sees it as healthy and stops the old copy.
  const log = (message: string) => console.log(`[one-click] ${message}`);
  let running: WalletConnectService | undefined;
  // Set when this copy no longer owns the WalletConnect connection. From then on one-click is off on THIS copy: it must
  // not answer requests or accept new links while another copy owns the identity.
  let standingDown = false;
  const lease = new WalletConnectLease(new PgLeaseStore(pool), {
    log,
    onLost: async () => {
      standingDown = true;
      await running?.stop();
    },
  });
  const ready = (async () => {
    try {
      try {
        await lease.acquire();
      } catch (error) {
        // A problem with the lease itself must not keep one-click off: carry on as before, without it.
        console.error(`[one-click] could not use the WalletConnect lease, starting without it: ${error instanceof Error ? error.message : error}`);
      }
      const starting = WalletConnectService.start({
        projectId,
        storage: new PgWalletConnectStorage(pool),
        store: oneClickStore,
        handler,
        findAccount,
        findFloat: floatEnabled
          ? async (accountId) => {
              const wallet = await floatStore.get(accountId);
              return wallet && { address: wallet.address, chainId: wallet.chainId, active: wallet.status === "active" };
            }
          : undefined,
        findSolana: solanaEnabled
          ? async (accountId) => {
              const wallet = await solanaStore.get(accountId);
              return wallet && { address: wallet.address, active: wallet.status === "active" };
            }
          : undefined,
        metadata: { name: "MyPropGuard", description: "Trade with your protected account, with your risk rules enforced.", url: publicUrl, icons: [`${publicUrl}/favicon.ico`] },
        log,
      });
      // Do not let a slow relay hold the connection setup hostage.
      running = await Promise.race([
        starting,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the WalletConnect relay did not answer within 30 seconds")), 30_000)),
      ]);
      if (standingDown) {
        // The lease was lost while the service was still starting: close what just came up.
        await running.stop();
        running = undefined;
        return;
      }
      console.log(`One-click trading on (BSC). Gas is paid by ${gasAccount.address}.`);
    } catch (error) {
      console.error(`[one-click] NOT started, the rest of the server is running without it: ${error instanceof Error ? error.message : error}`);
    }
  })();
  const whenRunning = async (): Promise<WalletConnectService> => {
    await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 25_000))]);
    if (standingDown) throw new Error("One-click trading moved to another copy of the server. Try again in a minute.");
    if (!running) throw new Error("One-click trading is still starting up. Try again in a minute.");
    return running;
  };
  const service: OneClickDeps["service"] = forwardingService(whenRunning);
  // Told to stop (a deploy): close the connection, then let go of the lease, so the new copy neither waits nor overlaps.
  const onStop = () => {
    void handOver(() => running?.stop(), lease).finally(() => process.exit(0));
  };
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);

  floatDeps = floatEnabled
    ? {
        store: floatStore,
        service,
        createWallet: async () => {
          const wallet = await privy.createEthereumWallet();
          return { id: wallet.id, address: wallet.address };
        },
        signer: floatSigner,
        publicClient,
        valuer: floatValuer,
        chainId: bsc.id,
        nativeSymbol: "BNB",
      }
    : undefined;

  solanaDeps = solanaEnabled
    ? {
        store: solanaStore,
        service,
        createWallet: async () => {
          const wallet = await privy.createSolanaWallet();
          return { id: wallet.id, address: wallet.address };
        },
      }
    : undefined;

  return {
    store: oneClickStore,
    service,
    createSessionWallet: async () => {
      const wallet = await privy.createEthereumWallet();
      return { id: wallet.id, address: wallet.address };
    },
    chains: {
      [bsc.id]: {
        publicClient,
        guardAddress,
        // Safe's canonical MultiSendCallOnly v1.4.1 on BNB Chain.
        multiSendCallOnly: envAddress(process.env.EVM_BSC_MULTISEND_CALL_ONLY) ?? ("0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address),
        gasWalletAddress: gasAccount.address,
      },
    },
  };
}

let floatDeps: FloatDeps | undefined;
let solanaDeps: SolanaDeps | undefined;
let oneClick: OneClickDeps | undefined;
if (process.env.ENABLE_ONE_CLICK === "true") {
  try {
    oneClick = await setUpOneClick();
  } catch (error) {
    console.error(`[one-click] NOT started, the rest of the server is running without it: ${error instanceof Error ? error.message : error}`);
  }
}

const app = buildApp({
  store,
  watcherMode: watcherEnabled ? watcherMode : undefined,
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
  evmGuardSyncers,
  evmEquityReaders,
  evmStateReaders,
  evmTokenDiscoveries,
  oneClick,
  float: floatDeps,
  solana: solanaDeps,
});

// Max-daily-loss freezing is equity-based, not just realized P&L from trades - an account can
// breach its budget purely from a token's price dropping while held, with no new trade to trigger
// a recheck. A clock-based sweep is therefore necessary, not just a nice-to-have: without it,
// freeze state only ever updates when a rule is added or removed. Only sweeps when at least one
// EVM equity reader is configured (currently BSC only - see PancakeSwapEquityReader above), and
// only reconciles accounts that actually have an active MAX_DAILY_LOSS rule, not every EVM
// account, so idle accounts cost nothing. 5 minutes balances catching a breach reasonably quickly
// against RPC/gas cost; override via EVM_DAILY_LOSS_SWEEP_INTERVAL_MS if that tradeoff needs tuning.
if (Object.keys(evmEquityReaders).length > 0) {
  const sweepIntervalMs = Number(process.env.EVM_DAILY_LOSS_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);
  setInterval(() => {
    reconcileAllEvmAccountsWithDailyLossRule(store, evmEquityReaders, evmGuardSyncers, {
      stateReaders: evmStateReaders,
      tokenDiscoveries: evmTokenDiscoveries,
    })
      .then((results) => {
        const failures = results.filter((r) => r.error);
        if (failures.length > 0) {
          // eslint-disable-next-line no-console
          console.error(`Max-daily-loss sweep: ${failures.length}/${results.length} accounts failed to reconcile.`, failures);
        }
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("Max-daily-loss sweep failed entirely:", error);
      });
  }, sweepIntervalMs);
  // eslint-disable-next-line no-console
  console.log(`Max-daily-loss sweep enabled, running every ${sweepIntervalMs}ms.`);
}

if (watcherEnabled) {
  const intervalMs = Number(process.env.HL_WATCHER_INTERVAL_MS ?? 5_000);
  const slippageBps = Number(process.env.HL_CLOSE_SLIPPAGE_BPS ?? 500);
  const enforcers = new Map<string, VenueEnforcer>();
  const approvedCache = new Map<string, { agents: string[]; at: number }>();
  const approvedAgentsFor = async (venueAddress: string): Promise<string[]> => {
    const key = venueAddress.toLowerCase();
    const cached = approvedCache.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.agents;
    const agents = await venueReader.getApprovedAgents(venueAddress);
    approvedCache.set(key, { agents, at: Date.now() });
    return agents;
  };
  const memory = new WatcherMemory();
  let running = false;
  const deps = {
    store,
    venueReader,
    mode: watcherMode,
    memory,
    // Acts through a wallet Hyperliquid has really approved for the trader's account: the account's own agent wallet
    // if it is approved, otherwise the shared server wallet if that one is. An unapproved wallet's orders are
    // rejected, so asking Hyperliquid first turns a silent failure into a clear instruction.
    enforcerFor: async (account: { agentWalletId: string | null; agentWalletAddress: string | null; venueAddress?: string | null }): Promise<VenueEnforcer | undefined> => {
      if (!privyClientForWatcher || !account.venueAddress) return undefined;
      const approved = await approvedAgentsFor(account.venueAddress);
      const candidates = [
        { id: account.agentWalletId, address: account.agentWalletAddress },
        { id: process.env.PRIVY_AGENT_WALLET_ID, address: process.env.PRIVY_AGENT_WALLET_ADDRESS },
      ];
      const pick = candidates.find((c) => c.id && c.address && approved.includes(c.address.toLowerCase()));
      if (!pick?.id) return undefined;
      let enforcer = enforcers.get(pick.id);
      if (!enforcer) {
        enforcer = new HyperliquidEnforcer({ privyClient: privyClientForWatcher, walletId: pick.id, isTestnet: hlIsTestnet, slippageBps });
        enforcers.set(pick.id, enforcer);
      }
      return enforcer;
    },
  };
  setInterval(() => {
    if (running) return; // a slow pass must never overlap the next one
    running = true;
    watchAllHyperliquidAccounts(deps)
      .then(({ errors }) => {
        for (const { accountId, error } of errors) {
          // eslint-disable-next-line no-console
          console.error(`Hyperliquid watcher: ${accountId} failed this cycle:`, error instanceof Error ? error.message : error);
        }
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("Hyperliquid watcher pass failed entirely:", error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // eslint-disable-next-line no-console
  console.log(`Hyperliquid watcher on (${hlIsTestnet ? "testnet" : "MAINNET"}, mode=${watcherMode}), every ${intervalMs}ms.`);
}

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
