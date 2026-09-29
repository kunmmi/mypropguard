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
exact-hash-authorization → sign → **submit** pipeline that runs against
either a fast offline fake signer (`PlaceholderActionHasher` +
`FakeSignerGateway`) or the real one (`HyperliquidActionHasher` +
`PrivySignerGateway`) — same orchestrator either way, selected by which
hasher/signer pair you inject.

**Verified end to end on Hyperliquid's testnet on 2026-09-29**: a real risk
check, a real reservation, a real signature, and a real order that actually
rests on the venue (`packages/hyperliquid/test/submitOrder.integration.test.ts`).
Two real bugs were caught and fixed in the process of getting this to work
for real — see "Signer vendor" below. Order lifecycle (submit, cancel,
status) is now real too — see "What's real right now". Nothing here can
move funds or place a live order **on mainnet**: no funded/approved mainnet
agent wallet exists, and venue submission needs a second explicit opt-in
(`ENABLE_VENUE_SUBMISSION`) beyond real signing.

## Layout

- `packages/domain` — types, enums, reason codes, and the `RiskLedgerStore`/`LedgerContext`/`VenueStateReader`/`SignerGateway`/`ExecutionSequencer` ports.
- `packages/contracts` — Zod schemas for the external `/v1` API and internal decision/authorization shapes.
- `packages/risk-engine` — pure, deterministic risk decisions. No I/O.
- `packages/hyperliquid` — static Hyperliquid Standard-mode capability manifest, a read-only Info API client, and the **real** signing stack: `signing.ts` (MsgPack + Keccak256 action hashing, phantom-agent EIP-712 typed data — ported from Hyperliquid's own TS SDK), `orderAction.ts`/`cancelAction.ts` (exact schema field order for order/cancel actions), `assetIndex.ts` (coin → asset index, public read), `hyperliquidActionHasher.ts` (real `ActionHasher`), `privyClient.ts` (real Privy REST wallet client), `privySignerGateway.ts` (real `SignerGateway`), `exchangeClient.ts`/`submitOrder.ts` (real order submission), and `orderLifecycle.ts` (`HyperliquidOrderLifecycle` — real submit/cancel/status against the live venue). See "Signer vendor" below.
- `packages/execution` — the venue-agnostic orchestrator: canonical action → nonce lease → exact-hash authorization → signer, plus the offline scaffold pair `PlaceholderActionHasher`/`FakeSignerGateway`/`InMemoryExecutionSequencer` (fake key, timestamp-based nonces — never real, but Hyperliquid-plausible). Pass it `HyperliquidActionHasher`/`PrivySignerGateway` instead for the real path.
- `packages/risk-ledger` — Postgres-backed and in-memory `RiskLedgerStore` implementations, `PgExecutionSequencer` (durable nonce leasing), plus the `reserveOrder`/`getProtectionStatus`/`activateProtection`/`reconcileAccountFromVenue` orchestrators.
- `packages/test-fixtures` — deterministic fixtures and the in-memory store used across test suites.
- `apps/api` — Fastify HTTP server for the `/v1` contracts, plus the experimental `/v1/execution/dry-run` scaffold endpoint. CORS is open (`origin: true`) since this is a local dev tool, not a public service.
- `apps/web` — a Next.js dashboard for this backend: load or provision an account, see real protection status, reconcile against Hyperliquid, and check an order against the real risk engine. Styled with the Ighodalo Labs design system (tokens/components copied into `src/design-system/`) — MyPropGuard has no finished brand of its own yet, so this uses the parent company's real, ready system rather than inventing one. Copy is scoped honestly to what this backend actually does (no MT5/Telegram/billing claims from the separate, more mature MyPropGuard MT5 product).
- `supabase/migrations` — Phase 0/2 schema, plus `order_reservations.coin`/`venue_order_id` (order lifecycle tracking) and `nonce_leases` (durable nonce leasing).

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
- `POST /v1/execution/dry-run` runs the real reservation flow and, if not BLOCKed, the real nonce-lease/exact-hash-authorization pipeline. Defaults to the offline fake signer; set `ENABLE_REAL_SIGNER=true` (plus Privy credentials and an agent wallet — see below) to switch it to real Hyperliquid hashing + real Privy signing. Response fields are named `mock*` in the fake case (`mock: false` once real submission is also on). Set `ENABLE_VENUE_SUBMISSION=true` alongside `ENABLE_REAL_SIGNER` to actually submit to Hyperliquid and record the real `venueOrderId` on the reservation — if signing **or** submission fails, the reservation is released, not left permanently spending budget.
- `GET /v1/orders/:id` — real. A reservation that was never submitted (the common case — `/v1/orders` itself never signs/submits) reports `result: "PENDING"`, `venueOrderId: null`. One that was submitted via the dry-run route above reports its real `venueOrderId`; pass `?venueAddress=0x...` to also get a live `result: "COMMITTED"`/`"OUTCOME_UNKNOWN"` read from Hyperliquid's Info API (needs `orderLifecycleReader` configured, i.e. both flags above).
- `POST /v1/orders/:id/cancel` — real. A reservation that never reached the venue is just released locally (`reasonCode: "NEVER_SUBMITTED"`, no venue call needed). One with a real `venueOrderId` gets a real `cancel` action built, signed, and submitted to Hyperliquid before the reservation is released — needs `ENABLE_VENUE_SUBMISSION`, else `501`.

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

Real order submission exists (`packages/hyperliquid/src/exchangeClient.ts` +
`submitOrder.ts`): given a `SignedAction`, it rebuilds the exact wire-format
action that was hashed and POSTs it, with the signature split into the
`{r, s, v}` shape Hyperliquid's `/exchange` endpoint expects, to either
`HYPERLIQUID_MAINNET_EXCHANGE_URL` or `HYPERLIQUID_TESTNET_EXCHANGE_URL`.

**Proven against the live testnet on 2026-09-29**
(`submitOrder.integration.test.ts`, gated behind `SUBMIT_TESTNET_ORDER=1`,
requires the manual agent-approval step below): a real BTC buy order
actually rests on Hyperliquid's testnet order book. Getting there caught two
real bugs, both fixed and covered by regression tests:

1. `exchangeClient.submitAction` only checked the top-level
   `status: "ok"/"err"` wrapper. Hyperliquid nests per-order rejections
   (invalid size, price too far from reference, etc.) inside
   `response.data.statuses` — a rejected order was silently
   indistinguishable from a resting one to any caller checking truthiness.
   First real order attempt (0.001 BTC at $100) got rejected as
   "Order has invalid size" and the bug let it through as a false success.
2. `PrivySignerGateway` always resolved the coin-to-asset-index mapping
   against **mainnet's** Info API regardless of `isTestnet`, because that
   flag only controlled the EIP-712 domain's `source` field. Mainnet and
   testnet do not share the same asset ordering — this silently placed a
   real testnet BTC request as a **SOL** order instead. `isTestnet` now also
   picks the matching Info API by default (`assetIndexOptions.baseUrl`
   still overrides it explicitly).

Nothing here can move funds or place a live order **on mainnet** regardless:
there is no funded or approved mainnet Hyperliquid agent wallet. Testnet is
different — it needs one manual, one-time step this codebase cannot do for
you (it requires signing with *your own* wallet, not a key this codebase
holds): approving this Privy agent wallet
(`PRIVY_AGENT_WALLET_ADDRESS` in `.env`) on a funded Hyperliquid **testnet**
account, via Hyperliquid's own testnet UI at
`app.hyperliquid-testnet.xyz` → API tab → Approve Agent, after getting free
test USDC from their faucet.

## Nonces: durable, and a third real bug the testnet proof caught

`ExecutionSequencer.leaseNonce` originally handed out a plain 1/2/3 counter.
Confirmed for real against testnet: Hyperliquid rejects that outright —
`"Invalid nonce: nonce too low 1 < 1790522111031"` — because it requires the
nonce to be a recent millisecond timestamp, strictly greater than the last
one it saw for that account. Every real order submitted so far worked
around this by building the canonical action by hand with `Date.now()`
directly, bypassing the sequencer entirely; the actual `/v1/execution/dry-run`
route (which does go through the sequencer) would have failed on this the
moment `ENABLE_VENUE_SUBMISSION` was turned on.

Fixed at the scheme level, not just the storage level:
`InMemoryExecutionSequencer` now leases `max(Date.now(), lastNonce + 1)`
instead of an incrementing counter — correct regardless of persistence.
`PgExecutionSequencer` (`packages/risk-ledger/src/postgres/pgExecutionSequencer.ts`)
makes it durable across server restarts, backed by a `nonce_leases` table,
via a single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
(Postgres serializes concurrent leases for the same account at the row
level — no separate lock needed). `apps/api/src/server.ts` uses it
unconditionally, since `DATABASE_URL` is already required there regardless
of which signer is active.
