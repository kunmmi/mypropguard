# MyPropGuard Onchain

Trading-risk-enforcement layer: evaluates every proposed trade against an
owner-defined mandate (daily loss, drawdown, leverage, position size,
exposure, trade frequency, cooldowns) and returns ALLOW/RESIZE/BLOCK before
execution. See `MyPropGuard for DeFi - Discovery Notes.docx` (kept outside
this repo) for the full architecture research this is built from.

**Scope of this repo right now: Phase 0 + Phase 1 + Phase 2 (read-only)**,
per that research's own ADR-009/build sequence. There is a real deterministic
risk engine, real account/rule provisioning, and a real (read-only)
Hyperliquid state feed — but **no signing, no agent wallets, and no order
placement on a live venue** yet (that's Phase 3+). See
`packages/hyperliquid`'s capability manifest and `apps/api`'s 501 responses
on `/v1/orders/:id` for exactly where that line is drawn today.

## Layout

- `packages/domain` — types, enums, reason codes, and the `RiskLedgerStore`/`LedgerContext`/`VenueStateReader` ports.
- `packages/contracts` — Zod schemas for the external `/v1` API and internal decision/authorization shapes.
- `packages/risk-engine` — pure, deterministic risk decisions. No I/O.
- `packages/hyperliquid` — static Hyperliquid Standard-mode capability manifest, plus a read-only Info API client (public `clearinghouseState` reads only — no credentials, cannot place orders or move funds).
- `packages/persistence` — Postgres-backed and in-memory `RiskLedgerStore` implementations, plus the `reserveOrder`/`getProtectionStatus`/`activateProtection`/`reconcileAccountFromVenue` orchestrators.
- `packages/test-fixtures` — deterministic fixtures and the in-memory store used across test suites.
- `apps/api` — Fastify HTTP server for the `/v1` contracts.
- `supabase/migrations` — Phase 0/2 schema.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

To run the API against a real Postgres (local Supabase or cloud):

```bash
supabase start        # prints a local DATABASE_URL
supabase db push       # applies supabase/migrations/*.sql
DATABASE_URL=<connection string> pnpm dev:api
```

Without a database, `pnpm test` still fully exercises the API and
reservation-concurrency logic via the in-memory `RiskLedgerStore` — see
`packages/persistence/test/*.test.ts` (the `*.postgres.test.ts` files there
are skipped automatically when `DATABASE_URL` isn't set) and
`apps/api/test/*.test.ts`.

Real-network tests (a genuine public read against Hyperliquid's mainnet
Info API) are opt-in via `RUN_NETWORK_TESTS=1`, since this environment may
be offline.

## What's real right now

- `POST /v1/accounts` provisions a `protected_accounts` + `account_risk_heads` + initial `rule_versions` row set.
- `POST /v1/orders` runs the real deterministic risk engine and atomic reservation logic against whatever account/rule state is in Postgres.
- `POST /v1/accounts/:accountId/reconcile` fetches an account's live equity/exposure from Hyperliquid's public Info API (read-only, any address, no auth) and folds it into `account_risk_heads`, recording a `VERIFIED` state checkpoint.
- `GET /v1/protection` only reports `botCanOpenNewTrades: true` once a **fresh** (< 5 minutes) `VERIFIED` checkpoint exists for that account — before the first reconcile, or once one goes stale, it correctly reports `walletNeedsAttention: true` instead. Per the blueprint: never show green protection when state continuity is unverified.
- `POST /v1/orders/:id/cancel` and `GET /v1/orders/:id` return `501` — they require live venue execution (order placement/cancellation), which needs a signer and is Phase 3+.

## What's explicitly not built yet (Phase 3+)

No agent wallets, no signing keys, no nonce/exact-hash authorization, no
order placement on Hyperliquid, no real money movement. That work needs
your explicit sign-off before touching real credentials or a funded vendor
account (Privy/Turnkey/etc.) — it isn't something to build unattended.
