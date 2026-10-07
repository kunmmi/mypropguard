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

- `POST /v1/accounts` provisions a `protected_accounts` + `account_risk_heads` + initial `rule_versions` row set. When `agentWalletProvisioner` is configured (i.e. `ENABLE_REAL_SIGNER=true`), also provisions a real, distinct Privy wallet for this specific account and returns its address as `agentWalletAddress` — that's the address a user needs to go approve as a Hyperliquid agent. Verified against the live Privy API: two calls genuinely return two different wallets, neither matching the single shared wallet the rest of the codebase still signs with (see below).
- `POST /v1/orders` runs the real deterministic risk engine and atomic reservation logic against whatever account/rule state is in Postgres.
- `POST /v1/accounts/:accountId/reconcile` fetches an account's live equity/exposure from Hyperliquid's public Info API (read-only, any address, no auth) and folds it into `account_risk_heads`, recording a `VERIFIED` state checkpoint.
- `GET /v1/protection` only reports `botCanOpenNewTrades: true` once a **fresh** (< 5 minutes) `VERIFIED` checkpoint exists for that account — before the first reconcile, or once one goes stale, it correctly reports `walletNeedsAttention: true` instead. Per the blueprint: never show green protection when state continuity is unverified.
- `POST /v1/execution/dry-run` — **always** a true dry run, regardless of server config. Runs the real reservation flow and, if not BLOCKed, the real nonce-lease/exact-hash-authorization/sign pipeline. Defaults to the offline fake signer; set `ENABLE_REAL_SIGNER=true` (plus Privy credentials and an agent wallet — see below) for real Hyperliquid hashing + real Privy signing. Never calls the order submitter even if the server has one configured — this route's name is a promise, not just a description. (An earlier version of this route *did* submit when configured, meaning a UI's "Check order" button could silently place a real trade purely based on server-side env vars the caller couldn't see. Fixed by splitting submission into its own route below — this one is now safe to wire up to any "check"/"preview" UI unconditionally.)
- `POST /v1/execution/submit` — the endpoint that can actually reach a venue. Same risk-check → reservation → sign pipeline as dry-run; additionally submits and records the real `venueOrderId` when `ENABLE_VENUE_SUBMISSION=true` (alongside `ENABLE_REAL_SIGNER`) — if signing **or** submission fails, the reservation is released, not left permanently spending budget. Any UI wiring this up needs to make unmistakably clear to whoever clicks it that this one can move real money.
- `GET /v1/orders/:id` — real. A reservation that was never submitted (the common case — `/v1/orders` itself never signs/submits, and neither does `/v1/execution/dry-run` anymore) reports `result: "PENDING"`, `venueOrderId: null`. One that was submitted via `/v1/execution/submit` reports its real `venueOrderId`; pass `?venueAddress=0x...` to also get a live `result: "COMMITTED"`/`"OUTCOME_UNKNOWN"` read from Hyperliquid's Info API (needs `orderLifecycleReader` configured, i.e. both flags above).
- `POST /v1/orders/:id/cancel` — real. A reservation that never reached the venue is just released locally (`reasonCode: "NEVER_SUBMITTED"`, no venue call needed). One with a real `venueOrderId` gets a real `cancel` action built, signed, and submitted to Hyperliquid before the reservation is released — needs `ENABLE_VENUE_SUBMISSION`, else `501`.
- `GET /v1/accounts?ownerUserId=...` — real. Lists every account owned by one user.
- `GET /v1/accounts/:accountId/rules` — real. Lists an account's active rules.
- `POST /v1/accounts/:accountId/rules` — real. Adds a new rule to an account's mandate. Takes effect on the very next order.
- `POST /v1/accounts/:accountId/rules/:ruleId/deactivate` — real. Deactivates a rule; idempotent.

## Per-account wallet provisioning (real, and wired into signing)

`packages/hyperliquid/src/agentWalletProvisioner.ts`'s `HyperliquidAgentWalletProvisioner`
wraps a real Privy wallet-creation call behind the venue-agnostic
`AgentWalletProvisioner` domain port. Every new account gets its own
signing wallet automatically, stored on `protected_accounts.agent_wallet_id`/
`agent_wallet_address`.

**Now actually used for signing/submission/cancel/status**, not just
displayed: `apps/api/src/app.ts`'s `resolveSignerForAccount` and its three
`resolveOrder*ForAccount` siblings look up the account being acted on and,
if it has its own `agentWalletId`, build a signer/lifecycle scoped to
*that* wallet via `AppDeps.signerFactory`/`orderLifecycleFactory` — falling
back to the single server-wide wallet only for accounts with no provisioned
wallet of their own. `apps/api/src/routes/execution.ts` and `orders.ts` call
these resolvers instead of a fixed dependency. Verified live: two accounts
with different provisioned wallets got routed to different signers and
produced different `venueOrderId`s from the same running server (see git
history for the exact request/response pairs), and unit-tested in
`apps/api/test/execution.test.ts`/`orders.test.ts` ("per-account wallet
resolution").

Verified against the live browser dashboard, not just the API: creating an
account now shows a real provisioned address and a prompt to go approve it
on Hyperliquid. Caught and fixed a real bug doing that — the callout was
nested inside the same conditional block as the "provision a new account"
form, so it vanished the instant the account finished loading (right after
creation), meaning a user would never actually see the address they needed.

## Authentication (real, required)

Multi-user auth via Supabase Auth. Every API route requires a valid
Supabase bearer token (`apps/api/src/auth.ts` verifies it against
Supabase's own auth server via `supabase.auth.getUser`) — `apps/api/src/server.ts`
refuses to start without `SUPABASE_URL`/`SUPABASE_ANON_KEY` configured, the
same fail-closed pattern as `DATABASE_URL`.

`assertAccountOwnership` (`apps/api/src/app.ts`) enforces that the
authenticated caller actually owns the account it's trying to act on for
every account-scoped route (rules, execution, orders, protection,
reconciliation) — a 403 otherwise. `POST /v1/accounts` and
`GET /v1/accounts` always derive `ownerUserId` from the verified token, not
the request body/query, so it can no longer be spoofed.

`apps/web` gates the entire dashboard behind a real sign-in/sign-up screen
(`AuthForm` in `src/app/page.tsx`) and attaches the session's access token
to every API call (`src/lib/api.ts`). The old manual "owner user id" text
field is gone — accounts are scoped to whoever is actually signed in.

Tests and the offline in-memory scaffold are unaffected: `authPreHandler`
is optional on `AppDeps`, so `request.userId` is simply `undefined` there
and every ownership check is a no-op — all pre-existing tests needed zero
changes. See `apps/api/test/auth.test.ts` for the auth/ownership-specific
tests (rejecting missing/invalid tokens, spoofed `ownerUserId`, and
cross-account access).

**Requires your own Supabase project's credentials** — see `.env.example`
(`SUPABASE_URL`/`SUPABASE_ANON_KEY`) and `apps/web/.env.local.example`
(`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`), from your
Supabase project's Settings → API page.

## Dashboard (`apps/web`)

Gated behind real sign-in/sign-up (see "Authentication" above) — no
session, no access to anything else on the page. Has a "Submit for real"
control next to "Check order" (`POST /v1/execution/submit`), disabled until
an explicit confirmation checkbox is checked, kept visually and
functionally separate from the always-safe dry-run preview.

Also has real account/rule management, not just single-account inspection:
"Your accounts" (list by owner id, click to load), "Risk rules" (list active
rules, add a new one, deactivate any of them — the panel showing this
account's actual mandate). Verified end to end in a real browser against a
running API: create an account, list it back, add a rule, watch the
Protection status panel's daily-loss budget update live, deactivate the
rule, confirm it's gone.

Caught and fixed two real bugs doing that verification, not just from code
review: (1) the deactivate-rule request sent `Content-Type: application/json`
with no body, which Fastify's parser rejects outright — every `POST` that
takes no input body now sends an explicit `"{}"`. (2) Protection status
(the daily-loss budget shown) depends on active rules but wasn't refreshed
after adding/deactivating one, so it silently went stale until the next full
reload — both rule-mutating handlers now also refetch protection status.

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

Nothing here moves funds or places a live order **automatically**: there is
no code path that submits to mainnet without a human explicitly running it.
Testnet needs one manual, one-time step this codebase cannot do for you (it
requires signing with *your own* wallet, not a key this codebase holds):
approving this Privy agent wallet (`PRIVY_AGENT_WALLET_ADDRESS` in `.env`) on
a funded Hyperliquid **testnet** account, via Hyperliquid's own testnet UI at
`app.hyperliquid-testnet.xyz` → API tab → Approve Agent, after getting free
test USDC from their faucet.

**Proven for real on mainnet too, on 2026-09-30**, once the account owner
funded a real account and approved the agent on `app.hyperliquid.xyz`
themselves: a real BTC resting order, placed with real money, confirmed
independently against the live mainnet order book
(`packages/hyperliquid/test/submitOrder.mainnet.test.ts`, gated behind
`SUBMIT_MAINNET_ORDER=1` — deliberately never run automatically, only by a
human who explicitly sets that flag knowing it moves real funds).

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

## Hosting (not done yet — needs your own accounts)

Everything above still only runs locally (`pnpm dev`). This repo can't
deploy itself: hosting requires accounts and credentials on providers this
codebase has no access to and shouldn't be given (Vercel, Railway/Fly/Render,
your Supabase project). What's ready for it, and what you'd still do
yourself:

- **`apps/web`** is a standard Next.js app — deployable to Vercel by
  pointing a new Vercel project at this repo with root directory
  `apps/web` (pnpm workspace is auto-detected). Set
  `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`/`NEXT_PUBLIC_API_URL`
  (the last one pointing at wherever you host `apps/api`) as Vercel project
  env vars.
- **`apps/api`** is a plain Fastify server (`pnpm --filter @mypropguard/api build && node dist/server.js`)
  — deployable to any Node host (Railway, Fly.io, Render). Set every var
  from `.env.example` (`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  and the Privy/signer vars if you want real signing) as that host's env
  vars, not in a committed file.
- **Database**: point `DATABASE_URL` at your Supabase project's Postgres
  connection string (already the case for local dev too) — no separate
  hosting decision needed there, it's already cloud-hosted once you're using
  a real Supabase project instead of `supabase start`.

No Dockerfile/CI deploy workflow exists yet — add one if/when you pick a
specific host, since the exact shape depends on which one.

## Hyperliquid watcher (react, don't intercept)

Hyperliquid accounts are not programmable, so a trader who clicks Buy on Hyperliquid's own site cannot be stopped
before the order is placed. Instead the watcher (`packages/risk-ledger/src/watcher.ts`, decisions in
`packages/risk-engine/src/enforcement.ts`) reads the trader's account every few seconds and reacts:

- Max position size only trims: the trade that takes the account over the limit is closed (a new position in full, a
  position that grew loses the growth) and nothing is locked, so the next trade is allowed again. A position held over
  the limit before the watcher saw it is left alone, and only growth after that is trimmed. Any older position-size
  lock lifts by itself.
- When any other watched rule is broken (daily loss, drawdown, leverage, exposure) the account is locked for
  the rest of the UTC day. Positions open at that moment are left alone. The trade that broke the rule - found by
  comparing with the last compliant reading - and every new trade after it is cancelled or trimmed with a
  reduce-only IOC order. The trader may still reduce or close what they hold; a position that shrank cannot be
  grown back, a closed one cannot be reopened, and a flip's new side is closed.
- It acts through the account's own approved agent wallet, which Hyperliquid restricts to trading. Every order it
  sends is reduce-only, so a repeated or mistaken instruction can never open or flip a position.
- A lock based on equity is only created after the ledger of deposits and withdrawals has been re-read, so a
  withdrawal is never mistaken for a loss. A failed read changes nothing.
- MyPropGuard-routed orders are also blocked while locked (`ACCOUNT_LOCKED_FOR_TODAY`); reducing is still allowed.
- Every decision is written to `enforcement_actions`, shown on the dashboard. In `log` mode it only records what it
  would do. Not yet watched: trade frequency and cooldown (they need fill history).

Limits: it reacts after the fact (a bad trade is live for seconds; closes happen at market with slippage); the trader
can revoke the agent approval on Hyperliquid; it covers one account (not sub-accounts); the Info API rate limit
(about 1200 weight/min per IP) bounds how many accounts one server can watch at a 5 second interval.
