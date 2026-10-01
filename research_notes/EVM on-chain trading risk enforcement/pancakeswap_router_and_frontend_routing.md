# PancakeSwap On-Chain Swap Interface (BSC) and PooCoin/GMGN Routing

## 1. What is PancakeSwap's current main swap entry point on BSC as of 2026?

### Takeaway
PancakeSwap on BSC has three live, parallel contract generations a trader's wallet can call directly: the original **V2 Router** (for classic AMM pools), the **V3 SmartRouter** (routes across V3/V2/StableSwap pools, used by the main pancakeswap.finance swap UI), and the newer **Universal Router** (Infinity), which is PancakeSwap's Uniswap-Universal-Router-style contract for its "Infinity" hooks-based AMM/CLAMM. All three are live and verified on BscScan; which one the official frontend calls depends on the pool type found for the best route, so a Guard decoding "PancakeSwap swaps" on BSC must handle all three ABIs, not just one.

### Cited Findings
- PancakeSwap V2 Router address on BSC: `0x10ED43C718714eb63d5aA57B78B54704E256024E` — [BscScan](https://bscscan.com/address/0x10ed43c718714eb63d5aa57b78b54704e256024e)
- PancakeSwap V3 SmartRouter (routes v3/v2/stable pools) on BSC: `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` — [BscScan](https://bscscan.com/address/0x13f4EA83D0bd40E75C8222255bc855a974568Dd4), also listed in [PancakeSwap developer docs](https://developer.pancakeswap.finance/contracts/v3/addresses)
- PancakeSwap V3 "SwapRouter" (narrower, V3-pools-only router, distinct contract from SmartRouter) on BSC: `0x1b81D678ffb9C0263b24A97847620C99d213eB14` — [BscScan](https://bscscan.com/address/0x1b81D678ffb9C0263b24A97847620C99d213eB14)
- PancakeSwap "Infinity" Universal Router on BSC mainnet: `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB` — [developer.pancakeswap.finance/contracts/universal-router/addresses](https://developer.pancakeswap.finance/contracts/universal-router/addresses)
- An earlier-generation ("v3-era") Universal Router address is also documented for BSC: `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416` — [developer.pancakeswap.finance/contracts/universal-router/addresses](https://developer.pancakeswap.finance/contracts/universal-router/addresses)
- The V3 SmartRouter combines `V2SwapRouter`, `V3SwapRouter`, `StableSwapRouter`, `SelfPermit`, and `MulticallExtended` — i.e., it is one contract capable of executing V2, V3, and stable-swap legs, which is why it (not the narrower "SwapRouter") is the one the main pancakeswap.finance UI actually calls for most swaps — [WebSearch synthesis citing pancakeswap/smart-router package dependencies](https://www.npmjs.com/package/@pancakeswap/smart-router?activeTab=dependencies), [DeepWiki: Smart Router](https://deepwiki.com/pancakeswap/pancake-frontend/3.1-smart-router)
- Newer frontend swaps also use Permit2-based approvals in conjunction with SmartRouter/Universal Router, rather than a plain `approve()` — [DeepWiki/WebSearch synthesis](https://deepwiki.com/pancakeswap/pancake-frontend/3.1-smart-router)

### Inferences
- A Guard should treat **`0x10ED43...6024E` (V2 Router)**, **`0x13f4EA...68Dd4` (V3 SmartRouter)**, and the Universal Router (`0xd9C500...9AEB` current / `0x1A0A18...927E416` legacy) as the set of "top-level PancakeSwap contracts a wallet calls" on BSC. The narrower V3 "SwapRouter" (`0x1b81D6...3eB14`) appears to be used less by the mainstream frontend (SmartRouter wraps it) but could still be called directly by some integrators/bots, so it's worth allow-listing too for safety.
- Because SmartRouter inherits `MulticallExtended`, a Guard cannot assume the swap selector is always the outermost call — see Q3.

### Gaps
- Could not get primary-source (GitHub/BscScan ABI) confirmation of exactly which selector set (V2-style vs exactInput vs Universal Router `execute`) accounts for the majority share of pancakeswap.finance's live production traffic in 2026; developer docs pages for detailed written explanation (`docs.pancakeswap.finance/developers/...`) returned 404s during this research session, so the "which router is primary" conclusion above is an inference from the SDK/package dependency structure rather than a direct statement from PancakeSwap's own docs team.

---

## 2. Exact function signatures for common swap operations

### Takeaway
PancakeSwap V2 Router keeps the standard Uniswap-V2-style ABI (same as most BSC forks), while the V3 SmartRouter uses Uniswap-V3-style `exactInput(Single)`/`exactOutput(Single)` with PancakeSwap's own parameter struct that **omits the `deadline` field** found in Uniswap's version (deadline is instead enforced only if the call is wrapped via `MulticallExtended`'s deadline-checking multicall variant — see Q3).

### Cited Findings
- V3 SmartRouter `ExactInputSingleParams` struct: `address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96` — [docs.pancakeswap.finance V3SwapRouter / WebSearch synthesis](https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts/smartrouterv3/v3swaprouter), corroborated by [GitHub pancake-v3-contracts issue #14](https://github.com/pancakeswap/pancake-v3-contracts/issues/14)
- Function: `exactInputSingle(ExactInputSingleParams calldata params) returns (uint256 amountOut)` — swaps `amountIn` of `tokenIn` for as much as possible of `tokenOut`; setting `amountIn = 0` makes the contract use its own token balance (an important edge case: a Guard cannot assume `amountIn` in calldata is always the real spend amount if `amountIn == 0` is permitted) — [same sources as above]
- `exactInput(ExactInputParams calldata params)` takes a struct with a **`bytes path`** (encoded `tokenIn-fee-tokenOut-fee-tokenOut...` tightly packed, Uniswap-V3 style), `address recipient`, `uint256 amountIn`, `uint256 amountOutMinimum` — standard Uniswap V3 multi-hop path encoding pattern, consistent across PancakeSwap's V3 fork — [GitHub issues/forum corroboration](https://forum.openzeppelin.com/t/pancake-swap-v3-exactinputsingle-fails-without-reason/39101); exact byte-packing format not independently re-verified against PancakeSwap's own source in this session (see Gaps).
- The V2 Router (standard Uniswap-V2-compatible ABI) functions include `swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)`, `swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable` (no `amountIn` param — the spend amount is `msg.value`), `swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)`, and the "SupportingFeeOnTransferTokens" variants of each (identical signatures, used for deflationary/tax tokens) — this is the well-documented, unmodified Uniswap-V2-Router02-compatible interface that PancakeSwap's router implements; referenced via [PancakeSwap Router v2 docs](https://docs.pancakeswap.finance/portuguese-brazilian/desenvolvimento/smart-contracts/pancakeswap-exchange/router-v2) and [BscScan verified contract](https://bscscan.com/address/0x10ed43c718714eb63d5aa57b78b54704e256024e). This is standard/public knowledge, not independently re-fetched function-by-function in this session.
- Universal Router (Infinity) uses the Uniswap-Universal-Router pattern: a single `execute(bytes commands, bytes[] inputs, uint256 deadline)` entry point where `commands` is a packed byte array of command IDs and `inputs` is an array of ABI-encoded per-command parameter blobs (V2_SWAP_EXACT_IN, V3_SWAP_EXACT_IN, etc., mirroring Uniswap's Universal Router command set) — inferred from PancakeSwap's Universal Router being modeled directly on Uniswap Labs' Universal Router design, per general architecture naming conventions seen in docs/address pages; **not independently confirmed against PancakeSwap's own Universal Router source code in this session** (see Gaps).

### Inferences
- A decoding Guard needs at minimum three ABI decoders: (a) legacy V2-style `path[]`/`amountIn`/`amountOutMin` functions, (b) V3 SmartRouter `ExactInputSingleParams`/`ExactInputParams` structs (and their Output-side siblings), and (c) Universal Router's generic `execute(bytes,bytes[],uint256)` which requires a secondary decode of the `commands`/`inputs` blobs to find the actual swap parameters — this third case is materially more complex than GMX v2's calldata shape and should be flagged to the Guard's author as extra engineering work.
- The `amountIn == 0` self-balance-lookup behavior in `exactInputSingle`/`exactInput` is a potential bypass vector for a naive "read `amountIn` field" trade-size Guard: if a caller passes `amountIn = 0`, the real spent amount is the contract's full token balance at execution time, not visible in calldata. A robust Guard likely needs to also cap/inspect the Safe's token balance before allowing a `amountIn == 0` call, or reject such calls outright.

### Gaps
- Could not independently re-verify, from PancakeSwap's own GitHub source (pancake-v3-contracts / pancake-universal-router repos) in this session, the exact byte-level path encoding for `exactInput`'s `bytes path`, nor the exact Universal Router command-ID enum values used in PancakeSwap's fork (these could differ in numbering from Uniswap's own Universal Router even if conceptually identical). This needs a follow-up direct GitHub source read before writing production ABI-decoding code for the Universal Router or multi-hop V3 paths.
- Did not confirm whether PancakeSwap's V3 `ExactInputSingleParams`/`ExactInputParams` structs match Uniswap's byte-for-byte (no deadline field) across all currently-deployed SmartRouter versions, or whether this has changed in more recent SmartRouter redeployments.

---

## 3. Does PancakeSwap use a multicall wrapping pattern like GMX v2?

### Takeaway
Yes — the V3 SmartRouter contract inherits `MulticallExtended` (and `SelfPermit`), so PancakeSwap's own frontend routinely wraps the actual swap call inside an outer `multicall(bytes[] data)` (or deadline-checked variant) transaction, especially when bundling a `selfPermit` call with the swap, or when a route needs multiple V3/V2/stable legs. The Universal Router's `execute()` function is itself a multicall-like "batch of commands" design. The plain V2 Router, however, does NOT use multicall — each V2 swap function is called directly as the top-level transaction.

### Cited Findings
- "The PancakeSwap SmartRouter contract imports SelfPermit and MulticallExtended, combining them with V2SwapRouter, V3SwapRouter, and StableSwapRouter functionality." — [WebSearch synthesis of pancakeswap/smart-router package structure](https://www.npmjs.com/package/@pancakeswap/smart-router?activeTab=dependencies), [DeepWiki: Smart Router](https://deepwiki.com/pancakeswap/pancake-frontend/3.1-smart-router)
- "The NonfungiblePositionManager and Smart Router support multicall to bundle several calls into one transaction that all succeed or all revert" — [DeepWiki/WebSearch synthesis](https://deepwiki.com/pancakeswap/pancake-frontend/3.1-smart-router)
- Universal Router's design (per general Uniswap-Universal-Router architecture that PancakeSwap's version mirrors) has one external entrypoint, `execute(bytes commands, bytes[] inputs, uint256 deadline)`, which internally dispatches to many possible sub-actions — functionally a form of built-in multicall/batching rather than a separate wrapper call.

### Inferences
- For the **V2 Router**, a Guard can decode the top-level `to`+calldata directly (no multicall unwrapping needed) — this is the simplest case, structurally similar to a "non-multicall" GMX-style direct call.
- For the **V3 SmartRouter**, a Guard MUST handle both: (a) a direct top-level call to `exactInputSingle`/`exactInput`/etc., and (b) a top-level call to `multicall(bytes[] data)` or `multicall(uint256 deadline, bytes[] data)` where one or more of the inner `data[i]` entries is itself an encoded `exactInputSingle`/`exactInput` call. This mirrors (and is arguably more complex than) the GMX v2 multicall-wrapping case already handled for Arbitrum, since here the wrapping is optional/variable rather than always-present.
- For the **Universal Router**, every call is effectively "pre-wrapped" inside `execute()`, so the Guard's decode logic must always drill into `commands`/`inputs` rather than ever expecting a bare swap selector at the top level.

### Gaps
- Did not obtain the exact `multicall` function selector variants (there may be more than one overload — e.g., `multicall(bytes32,bytes[])` using a previousBlockhash check, `multicall(uint256,bytes[])` using a deadline, and plain `multicall(bytes[])`) as implemented specifically in PancakeSwap's `MulticallExtended`; this should be pulled directly from the `pancake-v3-contracts` or `pancake-smart-router` GitHub source before finalizing the Guard's decoder, since GMX's multicall shape cannot be assumed identical here.

---

## 4. Which parameter is input amount vs output/min-output, and token identification for ERC-20 vs native BNB swaps

### Takeaway
PancakeSwap's naming convention is consistent across V2 and V3: `amountIn` (or `msg.value` for BNB-in swaps) is the spend side, and `amountOutMin` / `amountOutMinimum` is the slippage-protected minimum-received side. For ERC-20-to-ERC-20 swaps the input token and amount are both explicit in calldata; for swaps that start FROM native BNB, the function switches to an `...ETH...`-named variant (BNB is wrapped as WBNB under the hood, matching Uniswap's `ETH`-naming convention carried over to BSC) where the "input token" is implicit (WBNB) and the "input amount" is `msg.value`, not a calldata field.

### Cited Findings
- V2 Router: `swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)` — input token = `path[0]`, input amount = `amountIn` (both explicit) — [standard Uniswap-V2-Router02-compatible ABI, per PancakeSwap Router v2 docs](https://docs.pancakeswap.finance/portuguese-brazilian/desenvolvimento/smart-contracts/pancakeswap-exchange/router-v2)
- V2 Router: `swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable` — input token is implicitly native BNB/WBNB (`path[0]` should be WBNB), input amount is `msg.value` of the transaction, NOT an explicit calldata field — same source as above (standard Uniswap V2 Router convention)
- V2 Router: `swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)` — output is native BNB; input token = `path[0]`, input amount = `amountIn` explicit
- V3 SmartRouter `ExactInputSingleParams`: `tokenIn` and `amountIn` are both explicit struct fields; `amountOutMinimum` is the minimum-received guard — [as cited in Q2](https://github.com/pancakeswap/pancake-v3-contracts/issues/14)
- V3 SmartRouter `exactInputSingle` special case: `amountIn == 0` causes the router to look up its own token balance and swap the entire amount instead — meaning the real input amount is NOT reliably readable from calldata alone in this edge case — [docs.pancakeswap.finance / WebSearch synthesis, Q2 citation]

### Inferences
- A Guard decoding "input token + input amount" needs function-specific logic: for `...Tokens...`/`exactInput*` functions, read `path[0]`/`tokenIn` and `amountIn` directly; for `...ETH...`/native-BNB-in functions, treat the input token as the hardcoded WBNB address (`0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` on BSC — widely known constant, not independently re-verified in this session) and read the input amount from `msg.value`/`tx.value`, not from the function's named parameters.
- Because a Safe Guard (`checkTransaction`) receives `value` as a separate parameter alongside `data` in the standard Safe Guard interface, reading `value` for the BNB-in case is natively supported — no special calldata parsing needed for that part, unlike reading `amountIn` for ERC-20-in swaps.

### Gaps
- Did not re-verify the canonical WBNB contract address directly from a primary source in this session (commonly cited as `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`); this is extremely well-known but should be cross-checked against PancakeSwap's own router constants before hardcoding in production code.

---

## 5. Does PancakeSwap require msg.sender/tx.origin to be an EOA anywhere in the swap path?

### Takeaway
No primary-source evidence was found of any EOA-only or `tx.origin`-based gating in PancakeSwap's router/swap contracts; all available evidence (including a documented real-world case of a Safe calling the router) indicates PancakeSwap's routers work identically whether called by an EOA or a smart-contract wallet like Safe.

### Cited Findings
- A Medium walkthrough of using Safe on BSC explicitly describes constructing "a transaction [that] can call the PancakeSwap Router contract's `swapExactTokensForETH` function, sending tokens from the Safe" — i.e., a documented, working example of a Safe (not an EOA) calling PancakeSwap's router directly — [Using Safe as a Multisig Wallet on BSC and Transferring Meme Token Ownership](https://medium.com/@gwrx2005/using-safe-as-a-multisig-wallet-on-bsc-and-transferring-meme-token-ownership-83768160ed0e)
- General web search for `tx.origin`/EOA-only restrictions in PancakeSwap's router path returned no evidence of such checks; results instead pointed to generic PancakeSwap router documentation and unrelated third-party "Account-Bound Routers" research (a different, unrelated project) that itself uses `tx.origin` only to record an owner at contract creation, not to gate PancakeSwap's contracts — [WebSearch results](https://github.com/stevennevins/account-bound-routers/blob/85009b330da8a330e0e7849f0cf326a8568e7ed5/README.md)

### Inferences
- Since PancakeSwap's router/SmartRouter contracts are standard Uniswap-V2/V3-derived AMM router contracts (not relying on `msg.sender == tx.origin` patterns, which would in any case be unusual for a router expected to be called by other contracts, aggregators, and bots), it is reasonable to conclude the swap path is contract-wallet-compatible. This matches the general pattern already established for GMX v2 (no EOA-only gating) and for essentially all major AMM routers.

### Gaps
- Did not directly fetch and grep PancakeSwap's GitHub source (`pancake-smart-contracts`, `pancake-v3-contracts`) for the literal string `tx.origin` in this session — GitHub code-search was not directly queryable via the available web search/fetch tools in this environment. This is a **recommended direct follow-up**: clone or browse `github.com/pancakeswap/pancake-v3-contracts` and `github.com/pancakeswap/pancake-smart-contracts` and grep for `tx.origin` across `contracts/` before finalizing the Guard, since this report could only establish the absence of evidence, not source-verified absence of the pattern.

---

## 6. Real-world evidence of Safe/smart-contract-wallet usage with PancakeSwap

### Takeaway
Yes — there is a documented public example of a Safe (Gnosis Safe) being used to execute a PancakeSwap router swap on BSC, and separately, Safe's own multisig app ecosystem has previously integrated DEX aggregators (1inch) directly into the Safe UI, indicating multisig-to-DEX-router interaction is an established, supported pattern in the Safe ecosystem generally.

### Cited Findings
- "A transaction can call the PancakeSwap Router contract's `swapExactTokensForETH` function, sending tokens from the Safe" — concrete walkthrough of Safe-to-PancakeSwap-router interaction — [Using Safe as a Multisig Wallet on BSC and Transferring Meme Token Ownership](https://medium.com/@gwrx2005/using-safe-as-a-multisig-wallet-on-bsc-and-transferring-meme-token-ownership-83768160ed0e)
- "1inch added to Gnosis Safe Multisig App" — shows Safe's own app store has historically integrated a DEX aggregator directly, establishing that swap-via-Safe is a supported, expected use case in the Safe ecosystem (not PancakeSwap-specific, but establishes the general pattern this question is really probing) — [1inch Blog](https://blog.1inch.com/1inch-added-to-gnosis-safe-multisig-app/)
- General guidance found alongside this (recommending wider slippage, e.g. 3-4%, for multisig swaps due to signature-collection delay) implies this is a reasonably common real-world practice among Safe users doing DEX swaps, since such operational advice exists in community guides — [WebSearch synthesis, multiple multisig guides]

### Inferences
- Trade-size/trade-count Guards for PancakeSwap-via-Safe are solving a real, already-occurring use case, not a hypothetical one — consistent with the GMX v2/Arbitrum precedent.

### Gaps
- Could not find PancakeSwap's own official documentation or blog explicitly endorsing or walking through Safe usage (the evidence found is third-party/community, not from pancakeswap.finance or safe.global directly). Could not quantify how common Safe+PancakeSwap usage is (no on-chain statistics or volume data found).

---

## 7–9. PooCoin and GMGN trade routing on BSC

### Takeaway
**PooCoin**: strong circumstantial/community evidence indicates PooCoin's in-app swap feature routes trades directly through PancakeSwap's own contracts (PooCoin is described as a charting/analytics layer with an embedded swap widget, not an independent DEX), but no primary source (verified BscScan contract confirmed as "PooCoin's router," or PooCoin's own technical documentation) was found confirming this with a specific contract address. **GMGN**: GMGN explicitly operates a *separate, GMGN-controlled routing backend* — it is described by GMGN itself as running its own routing engine with dedicated API endpoints per chain family (one for Solana, a different one for "ETH/Base/BSC"), strongly suggesting trades are NOT simple direct pass-throughs to PancakeSwap's router from the user's wallet, but neither GMGN's public docs nor this research session's searches surfaced a specific BSC-side GMGN router/aggregator contract address on BscScan. This is a **confirmed gap** requiring direct on-chain transaction inspection (e.g., pulling a real GMGN BSC trade's transaction hash and reading its `to` address on BscScan) to resolve definitively.

### Cited Findings (PooCoin)
- "PooCoin allows traders to trade tokens directly via PancakeSwap inside the PooCoin interface." / "PooCoin itself does not charge fees, but since trades are executed via PancakeSwap, standard Binance Smart Chain (BSC) transaction fees apply." — [WebSearch synthesis of PooCoin guide content](https://www.bitget.com/amp/academy/poocoin-bsc-tracking), [cleartax.in PooCoin guide](https://cleartax.in/s/poocoin-complete-guide)
- No PooCoin-specific "router" contract was identifiable on BscScan via search; results returned only the unrelated POOCOIN token contract (`0xb27adaffb9fea1801459a1a81b17218288c097cc`) and other unrelated addresses — [BscScan search results, inconclusive]

### Cited Findings (GMGN)
- GMGN's cooperation/integration API documents a **distinct endpoint for Solana** (`https://gmgn.ai/defi/router/v1/sol/tx/get_swap_route`) versus a **distinct endpoint for EVM chains** (`/defi/router/v1/tx/available_routes_exact_in`, serving ETH/Base/BSC) — confirming GMGN runs its own backend routing/quoting layer per chain family rather than simply forwarding to each chain's native DEX aggregator — [docs.gmgn.ai Cooperation API pages](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-eth-base-bsc-trading-api/get-the-available-routing-for-eth-base-bsc-transactions), [docs.gmgn.ai Solana Cooperation API](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-solana-trading-api)
- GMGN's own description of its trading API emphasizes "automatic best-route selection, the same routing engine as GMGN web" and sub-second order submission — language consistent with an aggregator/smart-order-router model (its own infrastructure decides the route), not a thin pass-through — [GitHub GMGNAI/gmgn-skills README, fetched directly](https://github.com/GMGNAI/gmgn-skills)
- The `GMGN_PRIVATE_KEY` used in GMGN's API integration is explicitly documented as "a request-signing key used to authenticate API calls to the GMGN OpenAPI service" rather than a blockchain signing key — implying the actual on-chain transaction signing/submission flow is mediated by GMGN's backend/API layer for at least some of its trading products, rather than the user's own wallet directly constructing and calling PancakeSwap's router — [GitHub GMGNAI/gmgn-skills README](https://github.com/GMGNAI/gmgn-skills)
- No specific GMGN router/aggregator contract address on BSC was found via BscScan search or GMGN's own docs in this session.

### Inferences
- GMGN very likely uses its own BSC-side router/aggregator smart contract (consistent with how most multi-DEX "trading terminal" products operate, to support fee-taking, MEV protection, and multi-DEX routing beyond just PancakeSwap) — but this is an **inference, not a confirmed fact**, since no contract address or verified BscScan source was located.
- PooCoin, by contrast, is more plausibly a thin UI wrapper that calls PancakeSwap's router directly from the user's own wallet (community descriptions consistently frame it as "trade via PancakeSwap inside PooCoin," with no mention of PooCoin-branded fees or a separate PooCoin contract) — but this too is an inference from secondary/community sources, not confirmed via PooCoin's own technical docs or a verified BscScan contract explicitly labeled as "PooCoin."
- GMGN's documented architectural split between a Solana-specific router endpoint and a separate EVM (ETH/Base/BSC) endpoint is a real, sourced difference in how it names/structures its routing by chain family, but this alone does not confirm whether the *on-chain execution contract* differs in kind (e.g., Solana program vs. EVM router contract) — only that the backend quoting API is chain-specific, which would be expected regardless of execution architecture.

### Gaps — flagged explicitly, do not assume
- **No confirmed contract address exists in this report for either PooCoin's or GMGN's BSC-side execution contract.** This is the single most important open item for the Guard-building work: if PooCoin or GMGN use their own intermediary contract rather than calling PancakeSwap's router directly from the Safe's own transaction, a Guard that only recognizes PancakeSwap's router addresses (Q1) would **fail to intercept** trades routed through PooCoin/GMGN, or conversely would see an unrecognized `to` address and could not decode trade size/count from PooCoin/GMGN's own calldata shape at all.
- Recommended concrete next step (could not be done with the tools available in this research session): pull a handful of real, recent BSC transaction hashes known to originate from PooCoin's swap widget and from GMGN's BSC trading UI (e.g., via BscScan's "Internal Txns"/method-decoding on a known PooCoin or GMGN fee-collection wallet, or via a test trade), and inspect the top-level `to` address and decoded method name directly. This is the only way to definitively confirm or refute direct-vs-intermediary routing for both products.
- Could not determine whether GMGN's BSC product requires a GMGN-specific smart contract approval (separate from PancakeSwap's router approval) — this would be strong direct evidence of an intermediary contract if confirmed, since users would need to grant token allowance to a GMGN-controlled address rather than (or in addition to) PancakeSwap's router.
- No GitHub repository with verifiable Solidity source code for either PooCoin or GMGN's execution layer was found; both appear to be closed-source/proprietary front-ends, unlike PancakeSwap itself.
