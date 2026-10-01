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

## Open question: GMGN

Left unresolved deliberately (see
`research_notes/EVM on-chain trading risk enforcement/gmgn_bsc_routing_confirmed.md`) - evidence
leans toward GMGN using its own backend-mediated execution path on BSC (would need its own Guard
support, not covered by the PancakeSwap one), but this isn't confirmed. Resolving it needs either
someone sharing a real GMGN BSC transaction hash, or creating a real GMGN account and inspecting
a trade's wallet-confirmation payload directly - deliberately not done without explicit sign-off,
since it's a bigger step than research.

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

## Deliberately not done yet (real decisions needed, not just more time)

3. **Rule sync**: `packages/evm`'s `GmxGuardClient`/`SpotGuardClient` exist and are verified
   (same Anvil test), but nothing in `apps/api` calls them yet when a Postgres rule
   changes. Blocked on a real schema decision, not just wiring: the spot Guards'
   `setTokenLimit` is per-token, and `rule_versions` has no token column - extending it needs an
   actual design choice (a new column? a new rule type? how does "max $100 per trade in USDT"
   round-trip through the existing single-decimal `param` field?), not a guess. Also needs a
   funded admin wallet per chain to pay gas for these calls, an operational requirement
   Hyperliquid's gas-free signing never had.
4. **Real funded proof**: the same bar as the Hyperliquid mainnet proof - a real Safe, real
   funds, a real trade through the real exchange UI, with a rule violation genuinely reverting
   on-chain. The *mechanism* is proven on forks (see above); this step is specifically about
   doing it with real money on real mainnet, which needs the account owner's own funded wallet -
   prepare it, have them run it, same pattern as the Hyperliquid mainnet proof.

## Deferred: max leverage, max daily loss (leveraged/perps risk enforcement)

Explicitly out of scope until there's a specific reason to prioritize it. Per the original
research report, this needs cross-trade P&L/position-value accounting that a Guard can't get
from a single transaction's calldata alone - realistic options when this is picked back up:

- Build an owned on-chain position-accounting contract (most trustless, most work).
- Accept an off-chain attestation MyPropGuard's own backend signs before each trade (reintroduces
  a trusted component, but is the standard DeFi-wide compromise for this exact problem).
- A keeper/automation hybrid: periodically compute P&L off-chain, flip a cheap on-chain "frozen"
  flag the Guard checks (near-zero added gas per trade).

No decision has been made yet on which of these to use - revisit
`reports/EVM on-chain trading risk enforcement.md` section on the oracle/P&L problem when this
track is picked up.
