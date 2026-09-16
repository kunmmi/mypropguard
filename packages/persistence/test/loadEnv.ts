import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal .env loader so the Postgres integration test can pick up
 * DATABASE_URL from the repo-root .env without adding a dotenv dependency.
 * No-op if the variable is already set (e.g. in CI) or the file is absent.
 */
export function loadRootEnvIfPresent(): void {
  if (process.env.DATABASE_URL) return;

  const envPath = resolve(__dirname, "../../../.env");
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
