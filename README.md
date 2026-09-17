# MyPropGuard Onchain

Trading-risk-enforcement layer: evaluates every proposed trade against an
owner-defined mandate (daily loss, drawdown, leverage, position size,
exposure, trade frequency, cooldowns) and returns ALLOW/RESIZE/BLOCK before
execution. See `MyPropGuard for DeFi - Discovery Notes.docx` (kept outside
this repo) for the full architecture research this is built from.

**Scope of this repo right now: Phase 0 + Phase 1 + Phase 2 (read-only) +
Phase 3 (architecture scaffold, fake signer only)**, per that research's own
ADR-009/build sequence. There is a real deterministic risk engine, real
account/rule provisioning, a real (read-only) Hyperliquid state feed, and a
full canonicalize → nonce-lease → exact-hash-authorization → sign pipeline
— but the signer is a **fake with a placeholder hash, not connected to any
real key, venue, or funds**. Nothing in this repo can place a real order or
move money. See `packages/execution`'s doc comments and `apps/api`'s 501
responses on `/v1/orders/:id` for exactly where that line is drawn today.

## Layout

- `packages/domain` — types, enums, reason codes, and the `RiskLedgerStore`/`LedgerContext`/`VenueStateReader`/`SignerGateway`/`ExecutionSequencer` ports.
- `packages/contracts` — Zod schemas for the external `/v1` API and internal decision/authorization shapes.
- `packages/risk-engine` — pure, deterministic risk decisions. No I/O.
- `packages/hyperliquid` — static Hyperliquid Standard-mode capability manifest, plus a read-only Info API client (public `clearinghouseState` reads only — no credentials, cannot place orders or move funds).
- `packages/execution` — Phase 3 scaffold: canonical action + placeholder connectionId hash + authorize/sign orchestration, plus `FakeSignerGateway`/`InMemoryExecutionSequencer` (fake key, in-memory nonce counter — never real).
- `packages/persistence` — Postgres-backed and in-memory `RiskLedgerStore` implementations, plus the `reserveOrder`/`getProtectionStatus`/`activateProtection`/`reconcileAccountFromVenue` orchestrators.
- `packages/test-fixtures` — deterministic fixtures and the in-memory store used across test suites.
- `apps/api` — Fastify HTTP server for the `/v1` contracts, plus the experimental `/v1/execution/dry-run` scaffold endpoint.
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
- `POST /v1/execution/dry-run` (experimental Phase 3 scaffold) runs the real reservation flow and, if not BLOCKed, the real nonce-lease/exact-hash-authorization pipeline against a **fake** signer — proves the architecture end to end without any real key or venue call. Response fields are explicitly named `mock*` so nothing here is mistakable for a real signature.
- `POST /v1/orders/:id/cancel` and `GET /v1/orders/:id` return `501` — they require live venue execution, which needs a real signer and venue submission.

## What's explicitly not built yet

No real agent wallets, no real signing keys, no byte-exact Hyperliquid wire
format (MsgPack + Keccak + phantom-agent EIP-712 — `computeConnectionId` in
`packages/execution` is a placeholder SHA-256, documented as such), no order
submission to any venue (testnet or mainnet), no real money movement. That
work needs an explicit decision on a signer vendor (Privy/Turnkey/etc.),
real credentials, and — for anything beyond testnet — your sign-off. It
isn't something to build unattended.
