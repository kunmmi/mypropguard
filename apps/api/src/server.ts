import { createPool, PgRiskLedgerStore } from "@mypropguard/persistence";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Start local Supabase Postgres (`supabase start`) and set it to the printed connection string.",
  );
}

const pool = createPool(DATABASE_URL);
const store = new PgRiskLedgerStore(pool);
const app = buildApp({ store });

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
