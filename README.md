# MyPropGuard Onchain

Trading-risk-enforcement layer: evaluates every proposed trade against an
owner-defined mandate (daily loss, drawdown, leverage, position size,
exposure, trade frequency, cooldowns) and returns ALLOW/RESIZE/BLOCK before
execution. See `MyPropGuard for DeFi - Discovery Notes.docx` (kept outside
this repo) for the full architecture research this is built from.

**Scope of this repo right now: Phase 0 + Phase 1 + Phase 2 (read-only) +
Phase 3 (architecture scaffold + real Hyperliquid/Privy signing primitives,
not yet wired together)**, per that research's own ADR-009/build sequence.
There is a real deterministic risk engine, real account/rule provisioning,
a real (read-only) Hyperliquid state feed, a full canonicalize →
nonce-lease → exact-hash-authorization → sign orchestration pipeline (fake
signer), and — separately — real, verified Hyperliquid wire-format signing
plus a real Privy wallet client. Nothing in this repo can place a real
order or move money: no funded/approved agent wallet exists, and nothing
submits to Hyperliquid's exchange endpoint. See "Signer vendor" below and
`apps/api`'s 501 responses on `/v1/orders/:id` for exactly where the line
is drawn today.

## Layout

- `packages/domain` — types, enums, reason codes, and the `RiskLedgerStore`/`LedgerContext`/`VenueStateReader`/`SignerGateway`/`ExecutionSequencer` ports.
- `packages/contracts` — Zod schemas for the external `/v1` API and internal decision/authorization shapes.
- `packages/risk-engine` — pure, deterministic risk decisions. No I/O.
- `packages/hyperliquid` — static Hyperliquid Standard-mode capability manifest, a read-only Info API client, and the **real** signing primitives: `signing.ts` (MsgPack + Keccak256 action hashing, phantom-agent EIP-712 typed data — ported from Hyperliquid's own TS SDK), `orderAction.ts` (exact schema field order), `assetIndex.ts` (coin → asset index, public read). `privyClient.ts` is a real Privy REST wallet client (create wallet, sign typed data) — present and verified working, but deliberately not exported from the package or wired into anything: see "Signer vendor" below.
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

## Signer vendor: Privy (real, partially wired)

Privy was chosen (see the research doc's economics/quorum reasoning) and
real credentials exist locally in `.env` (never committed). What's actually
verified against the live Privy API and a real, unfunded Privy-managed
Ethereum wallet, on 2026-09-17:

- Created a real wallet via `POST /v1/wallets`.
- Built a real Hyperliquid order action (`orderAction.ts`), resolved BTC's
  real asset index from Hyperliquid's public `meta` endpoint
  (`assetIndex.ts`), and computed the real connectionId
  (`createL1ActionHash` — MsgPack + Keccak256, `signing.ts`).
- Signed the resulting phantom-agent EIP-712 message with the Privy wallet
  via `POST /v1/wallets/{id}/rpc` (`eth_signTypedData_v4`).
- Confirmed with `viem`'s `verifyTypedData` that the signature genuinely
  recovers to the Privy wallet's own address.

That proves the cryptographic pipeline is correct end to end. What's
**deliberately not built**: a `PrivySignerGateway` wiring this into the
app's `SignerGateway` interface (`packages/execution`'s
`authorizeAndSignOrder` still only knows about `FakeSignerGateway` and a
placeholder SHA-256 `computeConnectionId`) — assembling that piece was
blocked by this session's own safety tooling as "real-world transactions,"
and that call was respected rather than routed around. Wiring it up is a
explicit next step, not an oversight.

Even once wired, nothing here could move funds or place a live order: there
is no funded or approved Hyperliquid agent wallet, and Hyperliquid itself
never receives a signed action from this codebase. Getting from "valid
signature" to "live testnet order" needs: approving this Privy wallet as a
Hyperliquid agent (requires a funded Hyperliquid account signing an
`approveAgent` action), and actually submitting to
`https://api.hyperliquid-testnet.xyz/exchange` — deliberately not attempted
here.
