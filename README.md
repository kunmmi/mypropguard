# MyPropGuard Onchain

Trading-risk-enforcement layer: evaluates every proposed trade against an
owner-defined mandate (daily loss, drawdown, leverage, position size,
exposure, trade frequency, cooldowns) and returns ALLOW/RESIZE/BLOCK before
execution. See `MyPropGuard for DeFi - Discovery Notes.docx` (kept outside
this repo) for the full architecture research this is built from.

**Scope of this repo right now: Phase 0 + Phase 1 only**, per that
research's own ADR-009 — frozen contracts and an offline, deterministic risk
engine. There is **no live Hyperliquid connection, no signing, and no real
trading** yet (that's Phase 2/3). See `packages/hyperliquid`'s manifest and
`apps/api`'s 501 responses on `/v1/orders/:id` for exactly where that line
is drawn today.

## Layout

- `packages/domain` — types, enums, reason codes, and the `RiskLedgerStore`/`LedgerContext` ports.
- `packages/contracts` — Zod schemas for the external `/v1` API and internal decision/authorization shapes.
- `packages/risk-engine` — pure, deterministic risk decisions. No I/O.
- `packages/hyperliquid` — static Hyperliquid Standard-mode capability manifest (data only).
- `packages/persistence` — Postgres-backed and in-memory `RiskLedgerStore` implementations, plus the `reserveOrder`/`getProtectionStatus`/`activateProtection` orchestrators.
- `packages/test-fixtures` — deterministic fixtures and the in-memory store used across test suites.
- `apps/api` — Fastify HTTP server for the `/v1` contracts.
- `supabase/migrations` — Phase 0 baseline schema.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

To run the API against a real Postgres (local Supabase or cloud):

```bash
supabase start        # prints a local DATABASE_URL
supabase db push       # applies supabase/migrations/0001_phase0_baseline.sql
DATABASE_URL=<connection string> pnpm dev:api
```

Without a database, `pnpm test` still fully exercises the API and
reservation-concurrency logic via the in-memory `RiskLedgerStore` — see
`packages/persistence/test/reserveOrder.concurrency.test.ts` and
`apps/api/test/*.test.ts`.

## What "Phase 1 offline" means concretely

- `GET /v1/protection` will always report `walletNeedsAttention: true` and
  refuse `botCanOpenNewTrades` until Phase 2 (live venue state ingestion)
  exists — per the blueprint, protection must never show green when account
  state continuity is unverified.
- `POST /v1/orders` runs the real deterministic risk engine and atomic
  reservation logic against whatever account/rule state is in Postgres, but
  every account is currently projected as flat (no live position feed).
- `POST /v1/orders/:id/cancel` and `GET /v1/orders/:id` return `501` — they
  require live venue execution.
