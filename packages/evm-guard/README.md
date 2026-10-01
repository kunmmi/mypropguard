# @mypropguard/evm-guard

A Safe (Gnosis Safe) Guard contract that enforces MyPropGuard risk rules **on-chain, inside
every trade transaction**, for GMX v2 ("Classic Trading") on Arbitrum — regardless of which
front-end initiates the trade (GMX's own UI, a bot, MetaMask directly). This is fundamentally
different from, and stronger than, the "check rules then sign with an approved wallet" model
used for Hyperliquid elsewhere in this repo: Hyperliquid accounts aren't programmable, so that
model can always be bypassed by trading directly on Hyperliquid's own UI with your own key. A
Safe account *is* programmable — this Guard makes rule violations revert on-chain, unconditionally.

See `research_notes/EVM on-chain trading risk enforcement/` and
`reports/EVM on-chain trading risk enforcement.md` at the repo root for the research this is
built from, including why GMX-on-Arbitrum was chosen over BSC/Ethereum-mainnet options.

## Scope (v1)

Enforced, real, on-chain, unbypassable:
- **Max position size** — per order, in USD (GMX's own 30-decimal `sizeDeltaUsd` precision).
- **Max trades per day** — counts GMX position-opening orders (`MarketIncrease`/`LimitIncrease`/`StopIncrease`), resets at UTC midnight.

Explicitly deferred (per the research report — these need cross-trade P&L/position-value
accounting this Guard has no way to compute from calldata alone):
- Max leverage
- Max daily loss / max drawdown

## How it works

1. MyPropGuard provisions a Safe for the trader (one owner: the trader; one Guard: this
   contract, shared across all MyPropGuard accounts — see `GmxPositionLimitGuard.sol`'s
   per-account state keyed by the calling Safe's address). The trader never signs anything for
   this step — see `SafeGuardSetup.sol` below for how MyPropGuard's own backend deploys the Safe
   *and* attaches the Guard in one atomic transaction, with the trader set as sole owner from
   the start.
2. MyPropGuard's backend (the `admin` address at deploy time) calls `setLimits(account, ...)` —
   the trader themselves cannot loosen their own limits; a Safe with no limits configured fails
   closed (`LimitsNotConfigured`), never silently allows unlimited trading.
3. The trader trades GMX v2 Classic Trading **directly through GMX's own UI**, connecting their
   Safe as the trading wallet. Every order-opening transaction routes through
   `ExchangeRouter.multicall([sendWnt(...), createOrder(...)])`.
4. Safe's own `GuardManager` calls this Guard's `checkTransaction`/`checkModuleTransaction`
   before executing anything. The Guard decodes the `multicall` batch, finds any `createOrder`
   calls, and reverts the *entire* Safe transaction if a position-opening order exceeds the
   configured size limit or would push the account over its daily trade-count limit. GMX never
   sees a violating order — it doesn't exist as far as the chain is concerned.

## What's verified

`test/GmxPositionLimitGuard.t.sol` — 12 unit tests against calldata shaped exactly like real GMX
v2 `IBaseOrderUtils.CreateOrderParams` (struct pulled directly from
`gmx-io/gmx-synthetics`'s own source, see the research notes): allows within-limit trades,
blocks oversized positions, blocks over-the-daily-count trades (including multiple orders
batched in one `multicall`), ignores decrease/closing orders, resets the daily counter on a new
UTC day, blocks `delegatecall` to the router, enforces identically for module-initiated
transactions (so a Zodiac module can't bypass the Guard), and restricts `setLimits`/
`setExchangeRouter` to the admin address only.

`test/GmxForkIntegration.t.sol` — 2 tests against a **live Arbitrum mainnet fork**, calling
GMX's real deployed `ExchangeRouter` (`0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41` as of Oct
2026) with calldata built the same way this Guard decodes it. Confirmed via trace inspection:
`sendWnt` genuinely wrapped ETH into WETH and transferred it to GMX's real `OrderVault` on live
chain state, and execution was dispatched via `delegatecall` into exactly the selector this
Guard computes for `createOrder` — strong evidence the struct layout and selector are correct
against GMX's real bytecode, not just our own re-derivation of their published source. (It then
reverts deeper inside GMX's own account/collateral validation, which is expected without a
funded trading account — the test asserts on gas-consumed as a robust proxy for "this reached
real GMX logic," not on the exact revert reason.)

**`test/GmxSafeEndToEnd.t.sol`** — closes the "no real Safe" gap from earlier passes: deploys a
genuine, unmodified Safe (via a real `SafeProxyFactory`/`Safe` singleton pair, same bytecode Safe
itself ships) on the same live Arbitrum fork, attaches this Guard via the Safe's own `setGuard`
(a real `execTransaction` call, not a shortcut), then drives further real `execTransaction` calls
against GMX exactly as a trader's wallet would — using Safe's native approved-hash signature
scheme, not a `vm.prank` shortcut around `checkTransaction`. Confirms: an oversized order reverts
the whole Safe transaction with the Guard's own `PositionSizeExceeded` error; a within-limit
order is let through by the Guard (proven by the revert, when GMX's own logic rejects it deeper
in for lack of real collateral, NOT carrying the Guard's error selector) — exactly the two
outcomes this Guard exists to produce.

**Not yet done / explicitly out of scope for this pass:**
- No real funded-account test actually placing and confirming a GMX order (would need real
  WETH collateral and a funded Safe — the next real-money-adjacent step, same caution as the
  Hyperliquid mainnet proof elsewhere in this repo: prepare it, have the account owner run it).
- No deployment scripts/infra yet for provisioning a Safe + this Guard per MyPropGuard account,
  or backend wiring to call `setLimits` when an account's rules change in Postgres.
- `ExchangeRouter`'s address is owner-updatable (not hardcoded) because GMX has redeployed it
  across multiple protocol upgrades — re-verify the current address against
  `docs.gmx.io/docs/api/contracts-v2/` before any real deployment, don't trust this README's
  address indefinitely.

## PancakeSwap (BSC)

`PancakeSwapLimitGuard.sol` does the same job as the GMX Guard, for PancakeSwap on BSC. Since
spot swaps have no "position" or "leverage" concept, the two enforced rules are **max amount of
a given input token spent per trade** (in that token's own units - no price oracle) and **max
trades per day**.

Covers **both the V2 Router** (`0x10ED43C718714eb63d5aA57B78B54704E256024E`) **and the V3
SmartRouter** (`0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`), including swaps wrapped in any of
the three `multicall` overloads V3 routers support. A small on-chain registry
(`routerKind(address) => RouterKind`) tracks which decode logic applies to which router address -
only MyPropGuard's admin can add/remove entries. **Not covered**: PancakeSwap's Universal Router
(Infinity) - see "Universal Router: deliberately not covered" below.

**On PooCoin/GMGN**, per
`research_notes/EVM on-chain trading risk enforcement/pancakeswap_router_and_frontend_routing.md`
and the follow-up `gmgn_bsc_routing_confirmed.md`:
- **PooCoin**: community evidence suggests it calls PancakeSwap's router directly (no PooCoin
  contract in between) - if true, PooCoin trades would already be covered. Not confirmed from a
  primary source.
- **GMGN**: evidence leans toward GMGN using its own backend-mediated execution path (its live
  BSC trading UI requires a site account login before it'll even quote a trade - unlike
  PancakeSwap/Uniswap, which only require a connected wallet - consistent with, though not proof
  of, a GMGN-controlled intermediary contract). Treat GMGN trades as **not covered** until this
  is confirmed via a real GMGN account + transaction inspection, deliberately not pursued further
  since that's a bigger step than research.

**Verified**: 18 unit tests (within-limit trades for both V2 and V3, both struct shapes - with
and without a `deadline` field - all three V3 `multicall` wrapping overloads, multi-hop
`exactInput`'s packed-path token extraction, rejecting the `amountIn == 0`
"spend-my-whole-balance" sentinel outright rather than silently mis-checking it as zero,
ignoring unrecognized router addresses, `delegatecall` blocking, module-path parity, admin-only
configuration) plus 4 tests against a **live BSC mainnet fork** calling the real V2 Router and
V3 SmartRouter - two of which are complete, successful real swaps (0.1 BNB for BUSD via V2, and
0.1 WBNB for BUSD via V3's `exactInputSingle`), confirmed via the trader's real BUSD balance.

**`test/PancakeSwapSafeEndToEnd.t.sol`** — the same real-Safe proof as GMX's: a genuine Safe
deployed on the live BSC fork, Guard attached via its own `setGuard`, real `execTransaction`
calls signed via Safe's native approved-hash scheme. Since a V2 swap needs no pre-existing
collateral/account setup (unlike GMX), the within-limit case here completes a full, successful
real swap through the real Safe - the trader's real BUSD balance increases - not just "the Guard
let it through before something else failed."

## Uniswap (Ethereum)

`UniswapLimitGuard.sol` is the same logic as the PancakeSwap Guard, pointed at Uniswap's real
contracts on Ethereum mainnet. This is possible because PancakeSwap's routers are confirmed
near-exact forks of Uniswap's own (line-by-line source diffs - see
`research_notes/Uniswap V2 Router Ethereum parity/` and
`research_notes/EVM on-chain trading risk enforcement/v3_and_universal_router_abi.md`), so the
same decode logic applies to both with only addresses changed. Kept as a separate contract
rather than a shared parameterized one, same reasoning as keeping the GMX Guard separate.

Covers the **V2 Router** (`0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`, stable since June 2020)
and **both V3 router generations**: the original `SwapRouter` (`0xE592427A0AEce92De3Edee1F18E0157C05861564`,
whose `ExactInputSingleParams`/`ExactInputParams` structs include a `deadline` field) and
`SwapRouter02` (`0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, which omits it entirely - decoding
one shape against the other's calldata silently misaligns every field after `recipient`, which is
exactly why each registered router carries its own `RouterKind`). **Not covered**: Uniswap's own
Universal Router - see below.

**Verified**: 18 unit tests (identical coverage pattern to the PancakeSwap suite, plus a
dedicated test proving the with-deadline struct decodes correctly despite the extra field) plus
4 tests against a **live Ethereum mainnet fork** calling the real V2 Router and real
`SwapRouter02` - two of which are complete, successful real swaps (0.1 ETH for DAI via V2, and
0.1 WETH for DAI via V3's `exactInputSingle`), confirmed via the trader's real DAI balance - the
V3 one in particular is strong proof the "no-deadline" 7-field struct genuinely matches
`SwapRouter02`'s live deployed bytecode, not just our own re-derivation of its published source.

**`test/UniswapSafeEndToEnd.t.sol`** — same real-Safe, real-`execTransaction`, complete
successful-swap proof as PancakeSwap's, against Uniswap's real V2 Router on the live Ethereum
fork.

## Deploying for a trader without their signature: `SafeGuardSetup.sol`

`GuardManager.setGuard` is `authorized` (self-call only - `msg.sender` must be the Safe itself),
which would normally mean attaching a Guard needs a real `execTransaction` signed by an owner.
But the trader hasn't signed anything yet at the moment MyPropGuard creates their Safe - and
requiring them to sign a second transaction right after creation just to turn protection on
would be exactly the kind of avoidable friction this product is trying to remove.

`SafeGuardSetup.sol` is a tiny helper (one function, no state) that exploits the standard Safe
pattern for this: `Safe.setup()` itself takes a `to`/`data` pair that it `delegatecall`s as part
of the *same* creation transaction. Passing `to = address(SafeGuardSetup)` and
`data = abi.encodeWithSelector(SafeGuardSetup.setupGuard.selector, guardAddress)` makes the new
Safe delegatecall into `setupGuard`, which then calls `setGuard` - running in the Safe's own
execution context, so `msg.sender == address(this)` is satisfied without any owner signature.
MyPropGuard's backend (paying its own gas) ends up as the Safe's *deployer*, never an owner or
controller of it - the trader is the sole owner from block zero, with the Guard already active.

**Verified** (`test/SafeGuardSetup.t.sol`, 3 tests on a live Arbitrum fork): a deployer address
that is explicitly NOT the trader creates a Safe with the Guard already attached, confirmed by
reading the Safe's own `GUARD_STORAGE_SLOT` directly (not just trusting an event); the Guard is
live from the very first transaction attempt (an unconfigured brand-new Safe's first trade
reverts with `LimitsNotConfigured`, proving there's no unguarded window right after creation);
and the deployer itself cannot act as the Safe afterward (only the trader, as sole owner, can
approve/execute transactions) - confirming MyPropGuard's backend gains no control over the
trader's funds by deploying for them.

## Universal Router: deliberately not covered (both chains)

Per `research_notes/EVM on-chain trading risk enforcement/v3_and_universal_router_abi.md`,
Uniswap's (and PancakeSwap's) Universal Router is not one stable ABI:
- At least two live Ethereum-mainnet deployments decode the *same* command IDs
  (`V2_SWAP_EXACT_IN`, `V3_SWAP_EXACT_IN`, etc.) into **different tuple shapes** (a 5-field vs.
  6-field input encoding) - a Guard must know which deployed address it's looking at to decode
  correctly, and getting this wrong silently misreads the real trade size.
- The newest deployment has a **third top-level entry point**, `executeSigned(...)`, whose
  authorization/attribution semantics (who can trigger it, whether it can relay someone else's
  pre-signed intent) were not confirmed in this research pass.
- PancakeSwap's Universal Router adds its own extra command IDs (`INFI_SWAP`,
  `STABLE_SWAP_EXACT_IN`, etc.) that aren't in Uniswap's set and must be explicitly handled, not
  assumed safe-by-default.

Shipping a Guard against Universal Router with these specific gaps unresolved risks creating
**false confidence** - claiming a trade is blocked/limited when the real calldata shape wasn't
actually understood. That's a worse outcome than plainly not supporting it yet, so it's left out
until the gaps above are closed (see `ROADMAP.md`).

## Development

```bash
# one-time: install Foundry if not already present
curl -L https://foundry.paradigm.xyz | bash
foundryup

forge build
forge test                                            # unit tests, no network needed
forge test --match-contract GmxForkIntegrationTest          # needs network access (forks Arbitrum mainnet)
forge test --match-contract PancakeSwapForkIntegrationTest  # needs network access (forks BSC mainnet)
forge test --match-contract UniswapForkIntegrationTest      # needs network access (forks Ethereum mainnet)
```

Set `ARBITRUM_RPC_URL` / `BSC_RPC_URL` / `ETH_RPC_URL` to override the default public RPCs
(`https://arb1.arbitrum.io/rpc` / `https://bsc-dataseed.binance.org` / `https://ethereum.publicnode.com`)
used by the fork tests.
