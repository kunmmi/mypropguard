# EVM expansion roadmap

Spot-trading risk enforcement first (fast to ship, no oracle dependency). Leveraged/perps risk
enforcement (max leverage, max daily loss) is deferred to its own later track - see "Deferred"
at the bottom for why, and what unlocks it.

## Done

| # | Chain | Exchange | Router covered | Rules enforced | Proof |
|---|---|---|---|---|---|
| 1 | Arbitrum | GMX v2 (Classic Trading) | ExchangeRouter | max position size, max trades/day | 12 unit tests + 2 live-fork tests against real GMX contract |
| 2 | BSC | PancakeSwap | V2 Router only | max $ per trade (per token), max trades/day | 13 unit tests + 3 live-fork tests, incl. one complete real swap |

Both: one Guard contract per exchange, shared across every MyPropGuard Safe, admin-only
configuration (trader can't loosen their own limits), fail-closed if limits were never set.

## Next: Ethereum - Uniswap V2

Same shape as PancakeSwap (literally the router PancakeSwap forked), so this should be the
fastest of the remaining items. Steps, same process as the first two:

1. Research Uniswap's V2 Router (confirm current mainnet address, confirm ABI matches
   PancakeSwap's - expected to be near-identical since PancakeSwap V2 is a direct fork -
   confirm no EOA-only gating, same standard as prior research passes).
2. Build `UniswapV2LimitGuard.sol` - almost certainly a near-copy of `PancakeSwapV2LimitGuard.sol`
   with the router address and WETH constant swapped in (Ethereum's "native-in" functions are
   named `...ETH...` already, same convention).
3. Unit tests mirroring the PancakeSwap suite.
4. Live Ethereum-mainnet-fork tests against the real deployed Uniswap V2 Router, including at
   least one complete real swap (same bar as the PancakeSwap proof).

## After that: close the V3 / Universal Router gap (both chains)

Both PancakeSwap and Uniswap have a V3 SmartRouter/Universal Router path that the V1 Guards
don't cover yet - a trade routed through either (which the official frontends sometimes pick for
better pricing) currently passes through unchecked. This needs:

1. Direct GitHub source reads of PancakeSwap's `MulticallExtended`/Universal Router and Uniswap's
   own Universal Router, to pin down the exact (and possibly differing) multicall selector
   variants and command-ID encodings - flagged as unconfirmed gaps in the existing research
   notes.
2. A Guard (or an extension of the existing one) that handles three calldata shapes instead of
   one: bare top-level call, optionally-multicall-wrapped call, and Universal Router's
   `execute(commands, inputs)` batch format.
3. Handle the `amountIn == 0` ("use my whole balance") edge case flagged in the PancakeSwap
   research - a naive Guard reading `amountIn` from calldata would miss the real spend amount in
   this case.
4. Same test bar: unit tests + live fork tests with at least one real successful swap through
   each additional router.

## Open question: GMGN

Left unresolved deliberately (see
`research_notes/EVM on-chain trading risk enforcement/gmgn_bsc_routing_confirmed.md`) - evidence
leans toward GMGN using its own backend-mediated execution path on BSC (would need its own Guard
support, not covered by the PancakeSwap one), but this isn't confirmed. Resolving it needs either
someone sharing a real GMGN BSC transaction hash, or creating a real GMGN account and inspecting
a trade's wallet-confirmation payload directly - deliberately not done without explicit sign-off,
since it's a bigger step than research.

## Then: wire this into the actual MyPropGuard product

Everything above lives only in `packages/evm-guard` as standalone, tested Solidity - none of it
is connected to MyPropGuard's real account/rule system yet (contrast with the Hyperliquid side,
where `apps/api` actually provisions wallets and signs real orders). To make this a real,
usable feature:

1. **Provisioning**: when a user creates an EVM-chain account in MyPropGuard, deploy a real Safe
   for them (via Safe's `SafeProxyFactory`) with the relevant Guard(s) attached, instead of a
   Privy-managed EOA.
2. **Rule sync**: when a user sets/changes a rule in MyPropGuard's existing Postgres-backed rule
   system, call the Guard's `setLimits`/`setTokenLimit`/`setMaxTradesPerDay` on-chain from
   `apps/api` (this needs a funded admin wallet on each chain to pay gas for these calls - a new
   operational requirement, unlike Hyperliquid's gas-free signing model).
3. **Dashboard**: a new "EVM accounts" panel showing the Safe's address (what the trader actually
   connects to GMX/PancakeSwap/Uniswap's own UI with), current limits, and trade history read
   back from the Guard's emitted events.
4. **Real funded proof**: the same bar as the Hyperliquid mainnet proof - a real Safe, real
   funds, a real trade through the real exchange UI, with a rule violation genuinely reverting
   on-chain. Not attempted yet; this is the final verification step once 1-3 exist.

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
