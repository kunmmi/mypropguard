# Uniswap V3 SwapRouter02 — Technical Detail for Safe Guard ABI Decoding (Ethereum Mainnet)

## Key Question 1: Confirm current SwapRouter02 (or equivalent) deployed address on Ethereum mainnet. Note original SwapRouter vs SwapRouter02, both addresses, which is "current".

### Takeaway
Two distinct, both still-deployed and functioning V3 routers exist on Ethereum mainnet: the original `SwapRouter` at `0xE592427A0AEce92De3Edee1F18E0157C05861564`, and the newer, gas-optimized `SwapRouter02` at `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`. SwapRouter02 is the one described by Uniswap docs/GitHub as the current standalone V3 router (used outside Universal Router); the original SwapRouter is older and its interface/struct layout differs (has `deadline` in swap params — see Q3).

### Cited Findings
- SwapRouter02 contract address on Ethereum mainnet: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, confirmed via Etherscan where it is verified ("Exact Match"), contract name `SwapRouter02`, display label "Uniswap V3: Router 2" — [Etherscan](https://etherscan.io/address/0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45)
- Same address `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` is also referenced for SwapRouter02 on other EVM chains (Arbitrum, BSC, Goerli), consistent cross-chain deployment address pattern — [Arbiscan](https://www.arbiscan.io/address/0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45), [Goerli Etherscan](https://goerli.etherscan.io/address/0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45)
- Original V3 `SwapRouter` contract address: `0xE592427A0AEce92De3Edee1F18E0157C05861564`, labeled "Uniswap V3: Router" on Etherscan, also deployed at the identical address on Polygon and Arbitrum (CREATE2 deterministic deployment) — [Etherscan](https://etherscan.io/address/0xe592427a0aece92de3edee1f18e0157c05861564), [Polygonscan](https://polygonscan.com/address/0xe592427a0aece92de3edee1f18e0157c05861564), [Arbiscan](https://arbiscan.io/address/0xe592427a0aece92de3edee1f18e0157c05861564)
- Uniswap's own `v3-periphery` GitHub issue tracker references the original SwapRouter deployment as part of the "latest" `@uniswap/v3-periphery`/`@uniswap/swap-router-contracts` package set, but does not state it is deprecated outright — [GitHub issue #390](https://github.com/Uniswap/v3-periphery/issues/390)
- WebFetch attempts to pull the canonical `docs.uniswap.org`/`developers.uniswap.org` "Ethereum Deployments" reference page redirected twice (first 301 to `developers.uniswap.org`, then 303 to an `llms.mdx` content-negotiation URL) and could not be completed within this research pass — the specific docs page listing both addresses side-by-side with an explicit "current" designation was NOT directly fetched.

### Inferences
- Etherscan's verified "Exact Match" status for `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` combined with the contract name `SwapRouter02` is strong evidence this is the correct, current standalone V3 router address to target for Guard decoding on mainnet.
- Because the original `SwapRouter` (`0xE592427A0AEce92De3Edee1F18E0157C05861564`) remains deployed, verified, and not formally sunset, a Guard that only recognizes `SwapRouter02` could be bypassed (or could silently fail to flag risk) if a counterparty/attacker routes a trade through the original SwapRouter instead. **A robust Guard should treat both addresses as "the V3 standalone router" and apply decoding logic appropriate to each one's distinct struct layout (see Q3).**

### Gaps
- Could not directly confirm, via the official Uniswap docs deployments page itself (fetch was blocked by redirects), an explicit statement from Uniswap calling one router "current" vs "legacy/deprecated." The "SwapRouter02 is current" conclusion here is an inference from Etherscan's verified-contract metadata and from the GitHub repo being named `swap-router-contracts` (plural, newer) rather than a confirmed quote from Uniswap's own docs. **Recommend an additional manual check of `https://docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments` in a normal browser before relying on this for production security code**, since this is a load-bearing fact (wrong address = Guard checks nothing).
- Did not find a primary-source statement that the original `SwapRouter` is "deprecated" — it appears to simply be an earlier, still-functional deployment that frontends have largely moved off of in favor of SwapRouter02 and Universal Router.

---

## Key Question 2: Are exactInputSingle/exactInput calls on this router typically wrapped in multicall(bytes[]) by frontends, or called directly as top-level txs? Does SwapRouter02 support ETH refunds/unwrapping bundled via multicall (refundETH/unwrapWETH9)?

### Takeaway
SwapRouter02 is designed around `multicall` as the standard batching entry point, and it exposes **three different `multicall` overloads** (plain, deadline-gated, and blockhash-gated) in addition to each swap function being independently callable as a top-level call. `unwrapWETH9`/`refundETH`-family functions are explicitly intended to be bundled inside the same `multicall` as the swap call (e.g., `exactInputSingle` + `unwrapWETH9` when swapping into ETH, or `exactOutputSingle` + `refundETH` when paying with excess ETH). **This means a Guard cannot assume the top-level selector is `exactInputSingle`/`exactInput` — it must also handle `multicall(bytes[])`, `multicall(uint256,bytes[])`, and `multicall(bytes32,bytes[])` as top-level selectors and recursively decode each inner call.**

### Cited Findings
- SwapRouter02's base `Multicall` capability comes from `Multicall.sol` in `v3-periphery`, which defines `function multicall(bytes[] calldata data) public payable override returns (bytes[] memory results)`, implemented by looping and calling `address(this).delegatecall(data[i])` for each entry, reverting with the bubbled-up revert reason on failure — [GitHub: Uniswap/v3-periphery contracts/base/Multicall.sol](https://github.com/Uniswap/v3-periphery/blob/main/contracts/base/Multicall.sol) (primary source, fetched directly)
- SwapRouter02 additionally implements `IMulticallExtended`, which defines two further overloads beyond the base one:
  ```solidity
  function multicall(uint256 deadline, bytes[] calldata data)
      external payable returns (bytes[] memory results);

  function multicall(bytes32 previousBlockhash, bytes[] calldata data)
      external payable returns (bytes[] memory results);
  ```
  — [GitHub: Uniswap/swap-router-contracts contracts/interfaces/IMulticallExtended.sol](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IMulticallExtended.sol) (primary source, fetched directly). This is the mechanism by which SwapRouter02 reintroduces a `deadline`/`previousBlockhash` check at the **multicall level**, compensating for dropping `deadline` from the individual swap-params structs (see Q3).
- `unwrapWETH9` (and fee-variant `unwrapWETH9WithFee`) and `refundETH`/`sweepTokenWithFee` are defined in the `IPeripheryPaymentsWithFeeExtended`/`IPeripheryPaymentsExtended`/`IPeripheryPaymentsWithFee` interface chain that SwapRouter02 implements, with `unwrapWETH9WithFee(uint256 amountMinimum, uint256 feeBips, address feeRecipient)` as one concrete signature — [GitHub: Uniswap/swap-router-contracts contracts/interfaces/IPeripheryPaymentsWithFeeExtended.sol](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IPeripheryPaymentsWithFeeExtended.sol) (primary source, fetched directly; note the base, non-fee `unwrapWETH9(uint256 amountMinimum, address recipient)` and `refundETH()` signatures are declared in the parent interfaces this file inherits, which were not independently fetched in this pass — see Gaps)
- General web-search-sourced description (secondary, not a GitHub/Etherscan primary source) states: "A swap into ether typically reads as exactInputSingle followed by unwrapWETH9, where a multicall carries these operations decoded under it," and that `refundETH` "is useful for bundling with mint or increase liquidity that uses ether, or exact output swaps that use ether for the input amount" — [search summary, uncredited aggregation]; directionally consistent with the primary-source interface definitions above but the exact wording is not from Uniswap's own docs/code comments and should be treated as corroborating color, not a citation-grade source.

### Inferences
- Because SwapRouter02 supports calling `exactInputSingle`/`exactInput` either (a) directly as the top-level transaction `to`-selector, or (b) nested inside any of three different `multicall` selectors, **a Guard's ABI-decoding logic must branch on the top-level 4-byte selector first**: if it's one of the swap-function selectors, decode directly; if it's one of the three `multicall` selectors, iterate the `bytes[] data` array, slice each element's own leading 4 bytes, and recursively dispatch to the same per-function decoder. Missing the multicall branch (or missing any of its 3 selector variants) would let a Guard "see" a transaction as a benign/unrecognized call and pass it through unchecked — a silent-bypass risk flagged explicitly in the task framing.
- Because ETH-denominated swaps commonly bundle `unwrapWETH9`/`refundETH` alongside the swap call inside the same multicall, a Guard that only decodes the swap-params struct and ignores sibling calls in the `data[]` array could miss ETH-handling edge cases (e.g., fee-skimming variants `unwrapWETH9WithFee`/`sweepTokenWithFee` which divert a portion of proceeds to an arbitrary `feeRecipient` — a parameter worth flagging/validating in its own right).

### Gaps
- Did not find a primary-source (Uniswap docs or code comment) statement of how *commonly* (quantitatively) real-world frontends/aggregators choose multicall-wrapping vs direct top-level calls — the "typically wrapped when ETH is involved, otherwise callable directly" conclusion is inferred from the interface design (why would `unwrapWETH9`/`refundETH` exist and be documented as bundling partners if not commonly used that way) rather than from an explicit frequency statement or empirical calldata survey. Treat the "typically" framing as an architecture-level inference, not a measured statistic.
- Did not fetch the base (non-"Extended", non-fee) `unwrapWETH9(uint256,address)` and `refundETH()` signatures directly from their original defining interface file (likely `IPeripheryPayments.sol` in `v3-periphery`, inherited transitively) — only the fee-extended variants were fetched as primary source. Field order for the non-fee versions should be double-checked against `github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/IPeripheryPayments.sol` before being hard-coded into decoder logic.
- Did not independently verify, via Etherscan's "Read/Write Contract" or 4byte-directory selector lookups, that all three multicall selectors are actually reachable/non-reverting on the live mainnet SwapRouter02 bytecode (vs. being declared in the interface but potentially using a different ABI due to compiler/linearization quirks) — this should be cross-checked against the verified source code tab on Etherscan directly (not just the GitHub interface) before shipping.

---

## Key Question 3: Exact ExactInputSingleParams / ExactInputParams struct field order/types from Uniswap's own GitHub source for both the original SwapRouter and SwapRouter02 — does SwapRouter02 omit `deadline`?

### Takeaway
**CONFIRMED from primary source (direct GitHub raw-file fetch of both interfaces): the original `SwapRouter`'s structs INCLUDE a `deadline` field (as `uint256`, positioned after `recipient`); SwapRouter02's `IV3SwapRouter` structs OMIT `deadline` entirely.** All other fields are identical in name, type, and relative order between the two versions (deadline is simply removed from the SwapRouter02 struct, not replaced or reordered).

### Cited Findings
- **Original SwapRouter** (`v3-periphery`, `contracts/interfaces/ISwapRouter.sol`) — exact struct definitions as fetched directly from GitHub raw source:
  ```solidity
  struct ExactInputSingleParams {
      address tokenIn;
      address tokenOut;
      uint24 fee;
      address recipient;
      uint256 deadline;
      uint256 amountIn;
      uint256 amountOutMinimum;
      uint160 sqrtPriceLimitX96;
  }
  ```
  ```solidity
  struct ExactInputParams {
      bytes path;
      address recipient;
      uint256 deadline;
      uint256 amountIn;
      uint256 amountOutMinimum;
  }
  ```
  — [GitHub: Uniswap/v3-periphery contracts/interfaces/ISwapRouter.sol](https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/ISwapRouter.sol) **CONFIRMED (primary source: direct fetch of GitHub repo file)**

- **SwapRouter02** (`swap-router-contracts`, `contracts/interfaces/IV3SwapRouter.sol`) — exact struct definitions as fetched directly from GitHub raw source:
  ```solidity
  struct ExactInputSingleParams {
      address tokenIn;
      address tokenOut;
      uint24 fee;
      address recipient;
      uint256 amountIn;
      uint256 amountOutMinimum;
      uint160 sqrtPriceLimitX96;
  }
  ```
  ```solidity
  struct ExactInputParams {
      bytes path;
      address recipient;
      uint256 amountIn;
      uint256 amountOutMinimum;
  }
  ```
  — [GitHub: Uniswap/swap-router-contracts contracts/interfaces/IV3SwapRouter.sol](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/interfaces/IV3SwapRouter.sol) **CONFIRMED (primary source: direct fetch of GitHub repo file)**. No `deadline` field and no inline code comment referencing deadline appear anywhere in this struct's definition.

- Note: the function name in SwapRouter02's interface is `IV3SwapRouter` (not `ISwapRouter`) — the exported Solidity struct/function names (`exactInputSingle`, `exactInput`, `ExactInputSingleParams`, `ExactInputParams`) are unchanged, but the **interface file/contract name differs**, which matters if a Guard's decoding code imports/references interface names directly rather than just ABI-encoding raw tuples.
- Deadline handling is NOT removed from SwapRouter02 altogether — it is relocated to the `multicall(uint256 deadline, bytes[] data)` overload (see Q2/`IMulticallExtended.sol`), i.e., SwapRouter02 enforces deadline at the batch level rather than per-swap-struct level. This is a primary-source-confirmed architectural point, not speculation, since it is drawn directly from the fetched `IMulticallExtended.sol` interface.

### Inferences
- **For Guard ABI-decoding code**: when decoding a raw `exactInputSingle`/`exactInput` calldata blob, the decoder MUST first determine *which* router/ABI version it is decoding against (by checking the `to` address against the two known router addresses from Q1, or by attempting to decode against both struct shapes and checking calldata length/offsets for consistency) before choosing the tuple type to `abi.decode` against. Decoding SwapRouter02 calldata (7-field struct) using the original SwapRouter's 8-field struct ABI type (or vice versa) will misalign every field after the point of divergence — most dangerously, it would read `amountIn`'s `uint256` value into what the decoder thinks is `deadline`, and read `amountOutMinimum` into what it thinks is `amountIn`, which could cause a security Guard to validate the wrong field as a trade-size/slippage limit. This is exactly the "wrong struct field order" failure mode the task flagged as highest risk, and it is now primary-source-confirmed as a real divergence (not a hypothetical).
- Because SwapRouter02 moves deadline-enforcement to the optional `multicall(uint256,bytes[])` overload, and that overload is optional (callers can use the plain `multicall(bytes[])` or call `exactInputSingle` directly with no deadline protection at all), **a Guard cannot assume any deadline/expiry protection exists on a SwapRouter02 transaction** — if deadline-bounding matters to the Guard's risk model, it must check which selector was used and treat "no deadline-bearing selector used" as its own risk condition, separate from decoding the swap struct itself.

### Gaps
- None for the core field-order/deadline question — both struct definitions were fetched directly from their respective canonical GitHub source files in this session, satisfying the "primary source" bar the task required. 
- Not independently verified against Etherscan's own displayed ABI/verified-source copy for `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` (only the GitHub repo copy was fetched) — GitHub `main` branch source and the exact deployed bytecode's source could in principle diverge if the deployed contract predates the current `main` branch tip. Recommend a final cross-check pulling the "Contract" → "Code" tab's struct definitions directly from Etherscan for the live deployed bytecode before finalizing decoder code, per the task's own suggested-sources list.
