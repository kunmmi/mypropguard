import { createPool, PgRiskLedgerStore } from "@mypropguard/persistence";
import { HyperliquidInfoClient } from "@mypropguard/hyperliquid";
import { FakeSignerGateway, InMemoryExecutionSequencer } from "@mypropguard/execution";
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
// Phase 3 SCAFFOLD ONLY: fake signer + in-memory nonce sequencer. Cannot
// reach a real venue or move funds — see /v1/execution/dry-run.
const executionSequencer = new InMemoryExecutionSequencer();
const signer = new FakeSignerGateway();
const app = buildApp({ store, venueReader, executionSequencer, signer });

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
