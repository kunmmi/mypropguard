# MyPropGuard Onchain

Trading-risk-enforcement layer: evaluates every proposed trade against an
owner-defined mandate (daily loss, drawdown, leverage, position size,
exposure, trade frequency, cooldowns) and returns ALLOW/RESIZE/BLOCK before
execution. See `MyPropGuard for DeFi - Discovery Notes.docx` (kept outside
this repo) for the full architecture research this is built from.

**Scope of this repo right now: Phase 0 + Phase 1 + Phase 2 (read-only) +
Phase 3 (real Hyperliquid/Privy signing, now wired into the generic
orchestrator)**, per that research's own ADR-009/build sequence. There is a
real deterministic risk engine, real account/rule provisioning, a real
(read-only) Hyperliquid state feed, and a canonicalize → nonce-lease →
exact-hash-authorization → sign pipeline that runs against either a fast
offline fake signer (`PlaceholderActionHasher` + `FakeSignerGateway`) or the
real one (`HyperliquidActionHasher` + `PrivySignerGateway`) — same
orchestrator either way, selected by which hasher/signer pair you inject.
Nothing in this repo can place a real order or move money: no
funded/approved agent wallet exists, and nothing submits to Hyperliquid's
exchange endpoint. See "Signer vendor" below and `apps/api`'s 501 responses
on `/v1/orders/:id` for exactly where the line is drawn today.

## Layout

- `packages/domain` — types, enums, reason codes, and the `RiskLedgerStore`/`LedgerContext`/`VenueStateReader`/`SignerGateway`/`ExecutionSequencer` ports.
- `packages/contracts` — Zod schemas for the external `/v1` API and internal decision/authorization shapes.
- `packages/risk-engine` — pure, deterministic risk decisions. No I/O.
- `packages/hyperliquid` — static Hyperliquid Standard-mode capability manifest, a read-only Info API client, and the **real** signing stack: `signing.ts` (MsgPack + Keccak256 action hashing, phantom-agent EIP-712 typed data — ported from Hyperliquid's own TS SDK), `orderAction.ts` (exact schema field order), `assetIndex.ts` (coin → asset index, public read), `hyperliquidActionHasher.ts` (real `ActionHasher`), `privyClient.ts` (real Privy REST wallet client), and `privySignerGateway.ts` — a real `SignerGateway` that independently recomputes the Hyperliquid hash, refuses anything that doesn't match, and signs via a real Privy-managed key. See "Signer vendor" below.
- `packages/execution` — the venue-agnostic orchestrator: canonical action → nonce lease → exact-hash authorization → signer, plus the offline scaffold pair `PlaceholderActionHasher`/`FakeSignerGateway`/`InMemoryExecutionSequencer` (fake key — never real). Pass it `HyperliquidActionHasher`/`PrivySignerGateway` instead for the real path.
- `packages/risk-ledger` — Postgres-backed and in-memory `RiskLedgerStore` implementations, plus the `reserveOrder`/`getProtectionStatus`/`activateProtection`/`reconcileAccountFromVenue` orchestrators.
- `packages/test-fixtures` — deterministic fixtures and the in-memory store used across test suites.
- `apps/api` — Fastify HTTP server for the `/v1` contracts, plus the experimental `/v1/execution/dry-run` scaffold endpoint. CORS is open (`origin: true`) since this is a local dev tool, not a public service.
- `apps/web` — a Next.js dashboard for this backend: load or provision an account, see real protection status, reconcile against Hyperliquid, and check an order against the real risk engine. Styled with the Ighodalo Labs design system (tokens/components copied into `src/design-system/`) — MyPropGuard has no finished brand of its own yet, so this uses the parent company's real, ready system rather than inventing one. Copy is scoped honestly to what this backend actually does (no MT5/Telegram/billing claims from the separate, more mature MyPropGuard MT5 product).
- `supabase/migrations` — Phase 0/2 schema.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

To run the dashboard against a locally running API:

```bash
pnpm --filter @mypropguard/api dev   # port 3000, needs DATABASE_URL
pnpm --filter @mypropguard/web dev   # port 3001
```

To run the API against a real Postgres (local Supabase or cloud):

```bash
supabase start        # prints a local DATABASE_URL
supabase db push       # applies supabase/migrations/*.sql
DATABASE_URL=<connection string> pnpm dev:api
```

Without a database, `pnpm test` still fully exercises the API and
reservation-concurrency logic via the in-memory `RiskLedgerStore` — see
`packages/risk-ledger/test/*.test.ts` (the `*.postgres.test.ts` files there
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
- `POST /v1/execution/dry-run` runs the real reservation flow and, if not BLOCKed, the real nonce-lease/exact-hash-authorization pipeline. Defaults to the offline fake signer; set `ENABLE_REAL_SIGNER=true` (plus Privy credentials and an agent wallet — see below) to switch it to real Hyperliquid hashing + real Privy signing. Response fields are named `mock*` in the fake case; still no venue submission either way.
- `POST /v1/orders/:id/cancel` and `GET /v1/orders/:id` return `501` — they require live venue execution, which needs a real signer and venue submission.

## Signer vendor: Privy (real)

Privy was chosen (see the research doc's economics/quorum reasoning) and
real credentials exist locally in `.env` (never committed). `PrivySignerGateway`
(`packages/hyperliquid/src/privySignerGateway.ts`) is a real, working
`SignerGateway`: given an `ActionAuthorization` + `CanonicalOrderAction`, it

1. Resolves the coin's real Hyperliquid asset index (public read).
2. Builds the real order action and independently recomputes the real
   connectionId (MsgPack + Keccak256) — **refusing to sign if it doesn't
   match** the authorization it was handed (default-deny).
3. Signs the phantom-agent EIP-712 message via a real Privy-managed key
   (`POST /v1/wallets/{id}/rpc`, `eth_signTypedData_v4`).

Verified end to end against the live Privy API on 2026-09-17
(`packages/hyperliquid/test/privySignerGateway.integration.test.ts`, real
credentials required to run): created a real wallet, signed a real BTC
order action's real connectionId, and confirmed with `viem`'s
`verifyTypedData` that the signature genuinely recovers to the wallet's
address. A second test confirms it correctly refuses a mismatched hash.

**The gap between the generic orchestrator and this real signer is now
closed.** `authorizeAndSignOrder` (`packages/execution`) takes an
`ActionHasher` as an explicit parameter instead of hardcoding a hash
algorithm — pass `PlaceholderActionHasher` for the fast offline scaffold, or
`HyperliquidActionHasher` to get a real Hyperliquid connectionId that
`PrivySignerGateway` will actually accept. A third integration test
(`"works through the generic authorizeAndSignOrder orchestrator..."`) proves
the full real path — reservation → nonce lease → real hash → real Privy
signature — end to end.

Nothing here could move funds or place a live order regardless: there
is no funded or approved Hyperliquid agent wallet, and Hyperliquid itself
never receives a signed action from this codebase. Getting from "valid
signature" to "live testnet order" needs: approving this Privy wallet as a
Hyperliquid agent (requires a funded Hyperliquid account signing an
`approveAgent` action), and actually submitting to
`https://api.hyperliquid-testnet.xyz/exchange` — deliberately not attempted
here.
