import type { ActionHasher, SignerGateway } from "@mypropguard/domain";
import { createPool, PgRiskLedgerStore } from "@mypropguard/risk-ledger";
import { HyperliquidInfoClient, HyperliquidActionHasher, PrivyClient, PrivySignerGateway } from "@mypropguard/hyperliquid";
import { FakeSignerGateway, InMemoryExecutionSequencer, PlaceholderActionHasher } from "@mypropguard/execution";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Start local Supabase Postgres (`supabase start`) and set it to the printed connection string.",
  );
}

const pool = createPool(DATABASE_URL);
const store = new PgRiskLedgerStore(pool);
// Read-only public Hyperliquid Info API client (Phase 2) — no credentials,
// cannot place orders or move funds.
const venueReader = new HyperliquidInfoClient();
const executionSequencer = new InMemoryExecutionSequencer();

// Defaults to the offline scaffold (fake signer, placeholder hash). Set
// ENABLE_REAL_SIGNER=true (plus Privy credentials and an agent wallet) to
// switch /v1/execution/dry-run to real Hyperliquid hashing + real Privy
// signing instead — still no venue submission either way.
let hasher: ActionHasher = new PlaceholderActionHasher();
let signer: SignerGateway = new FakeSignerGateway(hasher);

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
  // eslint-disable-next-line no-console
  console.log("Real signer enabled: HyperliquidActionHasher + PrivySignerGateway. Still no venue submission.");
}

const app = buildApp({ store, venueReader, executionSequencer, hasher, signer });

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
