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
   per-account state keyed by the calling Safe's address).
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

**Not yet done / explicitly out of scope for this pass:**
- No real Safe deployment + `execTransaction` end-to-end test (tests call `checkTransaction`
  directly with `vm.prank`, exercising this Guard's own logic — Safe's `GuardManager` plumbing
  that invokes the Guard this way is Safe's own separately-audited code, not re-tested here).
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

`PancakeSwapV2LimitGuard.sol` does the same job as the GMX Guard, for PancakeSwap's **V2
Router** on BSC (`0x10ED43C718714eb63d5aA57B78B54704E256024E` as of Oct 2026). Since spot swaps
have no "position" or "leverage" concept, the two enforced rules are **max amount of a given
input token spent per trade** (in that token's own units - no price oracle) and **max trades
per day**.

**Scope and what's confirmed vs. not**, per
`research_notes/EVM on-chain trading risk enforcement/pancakeswap_router_and_frontend_routing.md`:
- Only the **V2 Router** is covered. PancakeSwap also has a V3 SmartRouter and a Universal
  Router, both with a more complex, optionally-multicall-wrapped calldata shape - a trade routed
  through either of those (which pancakeswap.finance's own UI sometimes picks for better
  pricing) is **not yet covered** by this Guard.
- **PooCoin**: community evidence suggests it calls PancakeSwap's router directly (no PooCoin
  contract in between) - if true, PooCoin trades would already be covered. Not confirmed from a
  primary source.
- **GMGN**: documented to run its own backend routing/quoting layer, which strongly suggests
  (but doesn't confirm) it uses its own intermediary contract on BSC rather than calling
  PancakeSwap's router directly from the trader's Safe - if so, GMGN trades would **not** be
  covered by this Guard at all, the same way an unrecognized `to` address is never covered.
  Confirming this needs inspecting a real GMGN BSC transaction's `to` address on BscScan, which
  wasn't possible with this research pass's tools.

**Verified**: 13 unit tests (same coverage pattern as the GMX Guard: within-limit trades, both
ERC-20-input and native-BNB-input swap shapes, per-token vs. "not yet configured" limits,
daily-count enforcement and reset, ignoring non-swap router calls like `addLiquidity`,
`delegatecall` blocking, module-path parity, admin-only configuration) plus 3 tests against a
**live BSC mainnet fork** calling the real V2 Router - one of which is a complete, successful
real swap (0.1 BNB for BUSD against live liquidity, confirmed by checking the trader's real
BUSD balance afterward, not just a revert-reason check).

## Development

```bash
# one-time: install Foundry if not already present
curl -L https://foundry.paradigm.xyz | bash
foundryup

forge build
forge test                                            # unit tests, no network needed
forge test --match-contract GmxForkIntegrationTest          # needs network access (forks Arbitrum mainnet)
forge test --match-contract PancakeSwapForkIntegrationTest  # needs network access (forks BSC mainnet)
```

Set `ARBITRUM_RPC_URL` / `BSC_RPC_URL` to override the default public RPCs
(`https://arb1.arbitrum.io/rpc` / `https://bsc-dataseed.binance.org`) used by the fork tests.
