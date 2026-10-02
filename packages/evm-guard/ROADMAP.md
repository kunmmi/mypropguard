# EVM expansion roadmap

Spot-trading risk enforcement first (fast to ship, no oracle dependency). Leveraged/perps risk
enforcement (max leverage, max daily loss) is deferred to its own later track - see "Deferred"
at the bottom for why, and what unlocks it.

## Done

| # | Chain | Exchange | Router(s) covered | Rules enforced | Proof |
|---|---|---|---|---|---|
| 1 | Arbitrum | GMX v2 (Classic Trading) | ExchangeRouter | max position size, max trades/day | 12 unit tests + 2 live-fork tests against real GMX contract |
| 2 | BSC | PancakeSwap | V2 Router + V3 SmartRouter | max $ per trade (per token), max trades/day | 18 unit tests + 4 live-fork tests, incl. 2 complete real swaps |
| 3 | Ethereum | Uniswap | V2 Router + V3 SwapRouter + SwapRouter02 | max $ per trade (per token), max trades/day | 18 unit tests + 4 live-fork tests, incl. 2 complete real swaps |

All three: one Guard contract per exchange, shared across every MyPropGuard Safe, admin-only
configuration (trader can't loosen their own limits), fail-closed if limits were never set.
Uniswap's Guard is near-identical code to PancakeSwap's, confirmed safe to duplicate rather than
share since PancakeSwap's routers are line-by-line forks of Uniswap's own.

Items 2 and 3 now cover V2 AND V3 (both struct generations - with/without a `deadline` field,
picked per registered router address via a `RouterKind` registry, since a Safe can only have one
Guard active and decoding the wrong struct shape silently misaligns every field after
`recipient`). The `amountIn == 0` "spend my whole balance" sentinel is rejected outright rather
than silently mis-checked as zero.

## Next: Universal Router (both chains) - currently blocked on real gaps, not just unstarted

Deliberately NOT built yet, and not simply because of time - real research gaps make it unsafe
to ship with confidence right now (see `research_notes/EVM on-chain trading risk enforcement/
v3_and_universal_router_abi.md`):

1. At least two live Ethereum Universal Router deployments decode the same command IDs into
   different tuple shapes (5-field vs. 6-field) - which one applies depends on which deployed
   address is the call target, and this needs to be gotten exactly right or a Guard would
   misread the real trade size.
2. The newest deployment has a third entry point, `executeSigned(...)`, whose
   authorization/attribution model (who can trigger it, whether it can relay someone else's
   pre-signed intent) is not understood yet - shipping without understanding this risks leaving
   an entire unblocked execution path.
3. PancakeSwap's Universal Router has its own extra command IDs beyond the ones shared with
   Uniswap's - these need explicit handling, not an "unknown command = assume safe" default.
4. PancakeSwap's exact `MulticallExtended` selectors (relevant to its V3 SmartRouter, separately
   from Universal Router) were only secondary-sourced, not confirmed against primary GitHub/BscScan
   source.

Before writing any Universal Router Guard code: close gaps 1-2 with direct Sourcify/Etherscan
bytecode reads (not just GitHub tags, since the research found real version drift), and get an
explicit answer on `executeSigned`'s authorization model. Shipping with these open would risk
the worst outcome for a security product: claiming a trade is blocked when it actually wasn't
decoded correctly, or claiming coverage of an execution path that was never actually blocked.

## Resolved: GMGN is out of scope for on-chain enforcement, confirmed

Previously left unresolved (see `research_notes/EVM on-chain trading risk enforcement/
gmgn_bsc_routing_confirmed.md`), now confirmed directly against a real GMGN account rather than
left as a guess. Connecting an external wallet (MetaMask) to GMGN is sign-in only - a message
signature, not a transaction. GMGN's own BSC "Wallet" screen then shows a separate, GMGN-generated
address ("Wallet1") with Deposit/Withdraw/Consolidate actions - the connected MetaMask address
never appears there. Trading requires depositing funds into that GMGN-controlled wallet; GMGN's
backend executes swaps from it, not from the trader's own wallet.

This means a MyPropGuard Safe can never be the wallet GMGN trades from - there is no flow where
GMGN signs a transaction from an externally-held smart contract wallet. The "which contract does
it call" question this item used to be framed around turns out not to matter: no Guard attached to
a trader's own Safe can ever see a GMGN trade, regardless of what GMGN's backend calls internally,
because the Safe is never the signer. No Guard work is possible or planned for GMGN.

## Done: real Safe + execTransaction end-to-end proof (all three exchanges)

Closed a gap this roadmap used to list as outstanding. `test/GmxSafeEndToEnd.t.sol`,
`test/PancakeSwapSafeEndToEnd.t.sol`, and `test/UniswapSafeEndToEnd.t.sol` each deploy a genuine,
unmodified Safe (real `SafeProxyFactory` + `Safe` singleton, same bytecode Safe ships) on the
relevant live mainnet fork, attach the Guard via the Safe's own `setGuard` (a real
`execTransaction`, not a shortcut), then drive further real `execTransaction` calls signed via
Safe's native approved-hash scheme - not `vm.prank`-ing straight into `checkTransaction` the way
every earlier test in this package did. PancakeSwap and Uniswap's within-limit cases complete a
full, successful real swap through the real Safe (trader's real token balance increases); GMX's
within-limit case proves the Guard let it through (confirmed by the revert NOT carrying the
Guard's own error selector) before GMX's own logic rejects it deeper in for lack of real
collateral - the same limitation the plain fork-integration tests already had.

## Done: wired into the actual MyPropGuard product (provisioning + dashboard)

1. **Provisioning - done, real, wired in.** `packages/evm`'s `SafeDeployer` (verified against a
   real local Anvil chain) is now called from `POST /v1/accounts` via the new
   `EvmSafeProvisioner` domain port and `EvmChainSafeProvisioner` adapter, opt-in per chain via
   `AppDeps.evmSafeProvisioners` - `server.ts` wires one concrete example (Arbitrum/GMX) behind
   `ENABLE_EVM_ARBITRUM_PROVISIONING`. `protected_accounts` gained
   `evm_owner_wallet_address`/`evm_safe_address`/`evm_chain_id` columns
   (`supabase/migrations/0007_evm_safe_accounts.sql`) to persist the result. A request with
   `venue="arbitrum-gmx"` + `evmOwnerWalletAddress` + `evmChainId=42161` now deploys a real Safe
   and returns its address - 2 new apps/api tests prove this is actually called when configured
   and skipped when it isn't.
2. **Dashboard - done.** A Venue selector (Hyperliquid vs GMX on Arbitrum) in the "provision a
   new account" form reveals a "Your wallet address" field for EVM venues, and shows the
   provisioned Safe address afterward with instructions to connect it directly on GMX's own UI -
   mirroring the existing Hyperliquid agent-wallet-approval callout. Verified live in the browser.

## Done: on-chain rule sync for the spot Guards (PancakeSwap/Uniswap)

The schema decision this used to be blocked on: `rule_versions` gained a nullable `token_address`
column (`supabase/migrations/0008_rule_token_address.sql`) rather than a new rule type - null for
every rule except MAX_POSITION_SIZE on an EVM spot venue, where it names which ERC-20 the limit
applies to. `POST /v1/accounts/:accountId/rules` now rejects a MAX_POSITION_SIZE rule missing
`tokenAddress` on an EVM Safe account, and otherwise pushes MAX_POSITION_SIZE/MAX_TRADE_FREQUENCY
changes straight to that account's Guard via the new `EvmChainGuardRuleSyncer`
(`packages/evm/src/evmGuardRuleSyncer.ts`) - built from the same admin wallet/RPC config that
already provisions Safes (`apps/api/src/server.ts`'s `configureEvmChainProvisioning`, now also
wired to `AppDeps.evmGuardSyncers`), so no new env vars. Token decimals are resolved live via the
ERC-20's own `decimals()` call rather than stored, so a dollar-denominated rule param converts to
the correct raw on-chain amount regardless of the token. If the on-chain push fails, the
just-created rule is deactivated and the request fails - a rule the Guard never actually received
can't sit in Postgres looking active. The dashboard's "Add a rule" form now shows a token-address
field whenever MAX_POSITION_SIZE is picked for an EVM Safe account, with inline copy explaining
the limit is enforced for every trade on that token, not just ones placed through the dashboard.

GMX is deliberately excluded from this: its Guard's `setLimits` sets `maxPositionSizeUsd` and
`maxTradesPerDay` together in one call, so pushing just one rule change would need to first read
the other current limit to avoid clobbering it - a separate, still-undone piece of design, not
covered by this change.

**Proof:** 5 new `packages/evm` unit tests (mocked viem clients, no live chain) cover the
decimals-conversion math, the native-token sentinel, the missing-tokenAddress rejection, and the
unsupported-rule-type rejection; 5 new `apps/api` tests cover the full HTTP path with a fake
syncer - successful push, missing-tokenAddress 400, no-op for non-EVM accounts, no-op when no
syncer is configured for the chain, and the deactivate-on-failure rollback. All 56 `apps/api`
tests and all `packages/risk-ledger` in-memory tests still pass.

**Still needs, before this is live**: migration 0008 applied to the production database (not done
from this environment - direct Postgres access to the production pooler isn't reachable from
here), and a funded admin wallet per EVM chain to pay the gas these calls cost, same operational
requirement Hyperliquid's gas-free signing never had.

## Deliberately not done yet (real decisions needed, not just more time)

1. **Real funded proof**: the same bar as the Hyperliquid mainnet proof - a real Safe, real
   funds, a real trade through the real exchange UI, with a rule violation genuinely reverting
   on-chain. The *mechanism* is proven on forks (see above); this step is specifically about
   doing it with real money on real mainnet, which needs the account owner's own funded wallet -
   prepare it, have them run it, same pattern as the Hyperliquid mainnet proof.

## Deferred: max leverage (not applicable to the spot Guards)

Still explicitly out of scope. PancakeSwap/Uniswap are spot AMMs - there is no leverage concept in
a plain token swap, so this only matters if/when a leveraged venue beyond GMX is added. No change
here.

## Done: max daily loss freeze mechanism for PancakeSwap/Uniswap Guards (decision made: backend attestation)

The three-option decision from this roadmap's earlier revision is resolved: **backend attestation**
was chosen over an owned on-chain accounting contract or a keeper/automation hybrid, since it
reuses the existing Postgres risk ledger and risk engine almost entirely rather than building new
on-chain accounting infrastructure. In practice this is implemented as a simple admin-controlled
freeze flag rather than a per-trade cryptographic signature - functionally the same trust tradeoff
(the backend's admin key decides), but far simpler for traders: nothing changes about how they
submit a trade, no extra signature needs to be attached to anything.

**Revised after explicit product direction**: the admin key must never be able to freeze a wallet
outside of an actual rule breach, and once frozen, nothing - not even the admin - may lift it
early; the only way out is the next UTC day. `PancakeSwapLimitGuard`/`UniswapLimitGuard` gained
`frozenThroughDay` (a UTC day number, not a boolean) and a single admin function,
`recordDailyLossBreach`, which can only ever set that day to *today* - there is no function on
either contract, callable by anyone, that clears it early. `_enforce` reverts with
`AccountIsFrozen` for any registered router while `frozenThroughDay[account] == today`, and the
freeze lifts itself automatically the instant `block.timestamp / 1 days` advances, with zero
transactions needed from anyone. A frozen account can still call untracked addresses (e.g.
withdrawing its own funds elsewhere) - freezing only stops further trades. The one thing that
remains structurally unavoidable: the contract still can't independently verify a breach happened
(realized P&L across multiple trades isn't derivable from calldata), so the admin key is still the
one that *reports* a breach - what changed is that reporting one no longer gives the admin any
control over how long the freeze lasts.

`packages/evm`'s `SpotGuardClient.recordDailyLossBreach` and
`EvmChainGuardRuleSyncer.freezeForToday` wire this into the existing per-chain admin wallet config.
`packages/risk-ledger`'s `checkAndEnforceDailyLossFreeze` reuses the *exact* same
`equityStartOfDay - currentEquity >= maxDailyLossParam` comparison the risk engine already uses for
Hyperliquid accounts, and is now one-directional to match the contract: it calls `freezeForToday`
when breached and does *nothing* when not (there is no "unfreeze" call to make - the domain port,
`EvmGuardRuleSyncer`, has no such method at all). `apps/api`'s rule routes call this automatically
whenever a MAX_DAILY_LOSS rule is added or deactivated, so changing the limit re-evaluates
immediately rather than waiting for the next trade attempt.

**Proof:** 4 Foundry tests per Guard contract (frozen accounts revert; no function anywhere lifts
a freeze early, confirmed by calling `recordDailyLossBreach` twice and showing it stays frozen
rather than toggling; the freeze lifts automatically after `vm.warp`-ing one day forward with zero
further calls; freezing doesn't block calls to untracked addresses; only the admin can record a
breach at all) - run for real against this environment's own Foundry install, all passing,
alongside the full existing suite. Plus 6 `packages/risk-ledger` unit tests and 7 `apps/api` tests
(including one exercising a real reported breach end-to-end through the HTTP rule route, not just
the no-breach cases), all passing.

## Done: EVM equity feed for BSC (the oracle/P&L piece that makes max daily loss live)

Closes the gap this roadmap used to describe as "the real remaining gap." `account_risk_heads`
needed something to feed it an EVM Safe's live on-chain USD value, the same way
`reconcileAccountFromVenue` already does for Hyperliquid from its Info API - no such feed existed
for EVM, because it needs pricing arbitrary ERC-20 holdings, the oracle/P&L problem flagged since
the original research (`reports/EVM on-chain trading risk enforcement.md`).

**The decision made**: price using PancakeSwap's own pool reserves (`packages/evm`'s
`PancakeSwapEquityReader`), not an external oracle like Chainlink. Chainlink only covers major
assets; this product's whole premise is enforcing risk on PancakeSwap trading, which includes the
long-tail meme-coin-style tokens Chainlink will never list. The tradeoff, stated plainly: a pool's
spot price can be briefly skewed by a large trade or deliberately manipulated within one block
(e.g. a flash loan). That's accepted here because this number only drives a risk-monitoring freeze
decision, not a fund-moving settlement - the worst case of a bad read is a wrongly frozen/unfrozen
account, not a theft. Revisit if max-daily-loss enforcement is ever used to gate something costlier
to get wrong.

Only values the Safe's native BNB balance plus whatever ERC-20s the account has an active
MAX_POSITION_SIZE rule for (`packages/risk-ledger`'s new `reconcileEvmAccountEquity` collects these
from the account's own rules before calling the reader) - there's no general way to enumerate every
token an address holds purely on-chain, so a token the account holds but has never set a rule for
isn't counted. Each tracked token is priced via a direct pool with USDT if one exists, otherwise
routed through a WBNB pool; a token with neither is valued at $0 rather than erroring, so one
illiquid token can't break the whole equity read. `POST /v1/accounts/:accountId/reconcile-evm`
exposes this (no `venueAddress` needed, unlike the Hyperliquid `/reconcile` - the account's own
`evmSafeAddress`/`evmChainId` already say what to read) and immediately re-checks the daily-loss
freeze state afterward, the same way adding a MAX_DAILY_LOSS rule does.

Wired for BSC/PancakeSwap only, using PancakeSwap's own canonical Factory/WBNB/USDT addresses
(public, hardcoded in `apps/api/src/server.ts`, not configurable - one less thing to misconfigure).
Ethereum/Uniswap has no equivalent reader yet; that chain's accounts still have max-daily-loss
freezing built but not live, same as before this change.

**Proof:** 6 new `packages/evm` unit tests (mocked viem client) cover direct-stablecoin pricing,
WBNB-routed pricing, the no-pair-found $0 fallback, the stablecoin-itself shortcut, and the
native-sentinel dedup; 5 new `packages/risk-ledger` tests cover the full reconcile-then-freeze flow
and both not-configured error cases; 3 new `apps/api` tests cover the HTTP route. All existing
tests continue to pass (63 `apps/api`, 27 `packages/risk-ledger` in-memory, 12 `packages/evm` unit
tests not requiring a live chain).

## Done: periodic sweep - this is what actually makes max daily loss live, unattended

Closes the last gap: `apps/api/src/server.ts` now runs a `setInterval` sweep
(`reconcileAllEvmAccountsWithDailyLossRule`) every 5 minutes (override with
`EVM_DAILY_LOSS_SWEEP_INTERVAL_MS`) that reconciles every EVM account with an active
MAX_DAILY_LOSS rule and re-checks its freeze state - without this, equity only ever updated when a
rule was added or removed, which would never catch a trader losing money purely by holding a token
whose price drops (no new trade to trigger a recheck). A clock-based sweep is necessary for exactly
this reason, not just a convenience: the loss here is equity-based, not realized-P&L-from-trades.

Only reconciles accounts that actually have the rule active (`RiskLedgerStore.
listAccountsWithActiveRuleType`, a new cross-account query backed by a single JOIN in Postgres), so
accounts not using this feature cost nothing. One account's failure (e.g. an RPC hiccup) is caught
and logged without aborting the sweep for everyone else. The sweep is a no-op entirely when no EVM
equity reader is configured.

**Proof:** 3 new `packages/risk-ledger` tests for `listAccountsWithActiveRuleType` (matches,
excludes deactivated rules, empty case) and 4 for the sweep itself (reconciles the right accounts,
skips chains with no reader, no-op with nothing configured, one failure doesn't block the rest) -
all passing alongside the full existing suite (63 `apps/api`, 34 `packages/risk-ledger` in-memory).

Max daily loss for BSC/PancakeSwap accounts is now built end to end: schema → freeze mechanism →
decision logic → live equity feed → automatic periodic enforcement. Ethereum/Uniswap still lacks
only the equity reader (no Uniswap-specific pricing built yet) to reach the same state.

## Done: a frozen account can still sell, never buy

Per explicit product direction: blocking a trader from exiting a losing position while frozen
works against the entire point of the feature (stopping *new* risk, not trapping someone in an
existing one). Both spot Guards now distinguish direction: `_checkAndRecord` only applies the
freeze check when the trade's output token is **not** the chain's native asset or its wrapped form
(BNB/WBNB for PancakeSwap, ETH/WETH for Uniswap) - i.e. a trade that returns to the base asset is
always allowed, frozen or not. Every other check (per-token amount limit, trade count) still
applies to that exit exactly as it would to any other trade - the exemption only ever touches the
freeze.

This needed real decode work, not just a flag: the Guards previously only extracted the *input*
token from a swap call. Both now also extract the *output* token - trivial for V3 (`exactInputSingle`'s
struct already names `tokenOut`), and for V2's `swapExactTokensForTokens`/`...Fee` and
`exactInput`'s packed path, the output token is the path's last entry (`_lastTokenFromPath`,
mirroring the existing `_firstTokenFromPath`). `swapExactTokensForETH`/`swapExactETHForTokens`
don't need path inspection at all - the function name itself guarantees which side is native.

A direct token-for-token swap where **neither** side is the base asset (e.g. one meme coin for
another) is deliberately **not** treated as an exit - it still opens exposure to a different asset,
not a return to safety, so it stays blocked while frozen. This is a conservative choice: ambiguous
cases are blocked, not guessed at.

Both contracts' constructors gained a third parameter (`wrappedNative` - WBNB or WETH) to make this
recognition possible; `DeployBscGuard.s.sol` was updated to pass BSC's real WBNB address. This is a
breaking constructor change, made before any real deployment exists, so there is no migration cost.

**Proof:** 6 new Foundry tests per Guard contract (selling into native and into wrapped-native are
both allowed while frozen; buying with either is blocked; a direct token-for-token swap stays
blocked; an allowed exit still enforces the per-token amount limit), written to run against this
machine's own Foundry install alongside the full existing suite including the multicall/batch and
V2/V3 decode-shape regression tests from before this change - confirm with `forge test` before
deploying.

## Done: Guard hardening - block-by-default, protected removal (needs `forge test` run by the user)

Correction first: an earlier claim that a frozen Safe "can never execute a buy, no exceptions" was
false. The Guard used to pass through any call to an address that was not a registered router, so a
trader could (1) call an unregistered DEX/aggregator (e.g. Axiom's rotating routers) directly,
(2) use delegatecall/MultiSend, or (3) simply `setGuard(0)` and detach the Guard.

Now `_enforce` is block-by-default in both PancakeSwapLimitGuard and UniswapLimitGuard. Allowed:
- rule-checked swaps on registered routers (unknown router functions and unknown calls inside a V3
  multicall revert; only unwrap/refund/sweep settlement helpers are let through),
- plain native sends, ERC-20 `transfer` (withdrawals stay possible - non-custodial),
- `approve` only for a registered router (or amount 0 to revoke),
- WBNB/WETH `deposit()` / `withdraw(uint256)`,
- Safe self-calls (owner/module management). `setGuard` specifically requires `requestRemoval()`
  to have been called at least 24h earlier AND the account not frozen that UTC day; the Safe calls
  `requestRemoval()` / `cancelRemoval()` through the Guard itself.
Everything else, including every delegatecall, reverts with `UnrecognizedCall`.

Honest remaining limits: a trader can still withdraw funds and trade elsewhere with them, or wait
out the 24h cooldown on a non-frozen day and remove the Guard; Axiom/aggregators are blocked, not
supported (support would need the current router ABI decoded); Safe batching via MultiSend is
blocked because it is a delegatecall; tests still run against Safe v1.5.0 while production uses
v1.4.1. Contracts must be redeployed from this version - do not deploy the older build.
