# UniswapV2Router02 — Ethereum Mainnet Address & Source Verification

## What is the UniswapV2Router02 contract address on Ethereum mainnet? Quote it exactly as given on Etherscan and/or docs.uniswap.org (these should agree — note if they don't).

### Takeaway
Both Etherscan and Uniswap's own developer docs give the identical mainnet address for UniswapV2Router02: `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`. No discrepancy found.

### Cited Findings
- Etherscan's verified-contract page for this address shows Contract Name "UniswapV2Router02" at address `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` — [Etherscan](https://etherscan.io/address/0x7a250d5630B4cF539739dF2C5dAcb4c659F2488d#code)
- Uniswap's developer docs (v2 deployments page) list the same address, `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`, for Router 2 on Ethereum Mainnet — [Uniswap Developer Docs (v2 deployments, via llms.mdx redirect)](http://developers.uniswap.org/llms.mdx/docs/protocols/v2/deployments)
- The canonical docs.uniswap.org URL (`https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments`) 301-redirects to `developers.uniswap.org`, which itself 303-redirects to the URL actually fetched above — i.e., this is the current/live version of that reference page, not a stale mirror — [docs.uniswap.org redirect chain observed directly during fetch]

### Inferences
- Since both the independently-operated block explorer (Etherscan) and Uniswap's own documentation agree on the byte-identical address, this address can be treated as confirmed from two independent primary sources.

### Gaps
- I could not independently verify the exact contract-creation transaction hash or deployer address with full confidence — the fetched Etherscan summary returned a creation transaction hash (`0x4fc1580e7f66c58b7c26881cce0aab9c3509afe6e507527f30566fbf8039bcd0`, 33 bytes — one byte too long for a valid 32-byte tx hash) and a deployer address (`0x9c33eacc2f50e39940d3afaf2c7b8246b681a374`, 20 hex chars short of the standard 40) that are almost certainly garbled by the AI summarization step (WebFetch) rather than genuine data from the page. Treat both of those specific values as unconfirmed; only the contract address itself, contract name, and compiler version were cross-checked and are reliable.

## Is this address verified on Etherscan as "UniswapV2Router02"? What is the verified contract name and compiler version shown?

### Takeaway
Yes — Etherscan shows the contract as verified with an "Exact Match," contract name "UniswapV2Router02," compiled with Solidity v0.6.6+commit.6c089d02.

### Cited Findings
- Etherscan page for `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488d` reports: Contract Name "UniswapV2Router02"; Compiler Version "v0.6.6+commit.6c089d02"; Verification Status "Exact Match" (deployed bytecode matches submitted source exactly) — [Etherscan](https://etherscan.io/address/0x7a250d5630B4cF539739dF2C5dAcb4c659F2488d#code)
- Per the same page, compiler optimization is enabled with 999,999 runs, targeting the Istanbul EVM version, licensed under GNU GPLv3 — [Etherscan](https://etherscan.io/address/0x7a250d5630B4cF539739dF2C5dAcb4c659F2488d#code)
- This matches the pragma directive in the primary GitHub source, `pragma solidity =0.6.6;` (line 1 of `contracts/UniswapV2Router02.sol` in `Uniswap/v2-periphery`) — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol)

### Inferences
- The compiler-version pin (`=0.6.6`) in the GitHub source matching the `v0.6.6` compiler version reported on Etherscan is consistent with (though not conclusive proof of) the "Exact Match" claim — the two primary sources are at least mutually consistent.

### Gaps
- I did not independently re-derive/byte-compare the deployed bytecode against a from-scratch compile of the GitHub source; I am relying on Etherscan's own "Exact Match" verification claim rather than independently reproducing it. This should be flagged as "verification claim taken from Etherscan, not independently recompiled."

## Reading github.com/Uniswap/v2-periphery contracts/UniswapV2Router02.sol directly, quote the exact function signatures for all six functions above. Note the exact Solidity source file path and, if visible, a commit hash or tag.

### Takeaway
All six target functions exist in `contracts/UniswapV2Router02.sol` on the `master` branch of `Uniswap/v2-periphery`, with parameter types/order and payability exactly as specified in the objective. Verbatim signatures below, fetched directly from the raw GitHub file (not a summary or fork).

### Cited Findings
Source file: `contracts/UniswapV2Router02.sol`, repository `Uniswap/v2-periphery`, branch `master`, fetched directly via `https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol` — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol)

Commit/provenance note: the GitHub API's commit history for this file's most recent change (as queried via `https://api.github.com/repos/Uniswap/v2-periphery/commits?path=contracts/UniswapV2Router02.sol`) shows the file's origin commit SHA `69617118cda519dab608898d62aaa79877a61004` ("UniswapV2Router02 skeleton (#31)", authored by Noah Zinsmeister, merged 2020-06-05, GPG-signature verified by GitHub) — [GitHub API commits](https://api.github.com/repos/Uniswap/v2-periphery/commits?path=contracts/UniswapV2Router02.sol&per_page=1). Note: this is the commit that introduced the file's skeleton, not necessarily the exact HEAD commit of `master` at time of fetch (no specific tag was pinned in this fetch — the `master` branch ref was used, which can move; the file's current content is the one quoted below as fetched on 2026-10-01).

Verbatim signatures (line numbers as in the fetched raw file):

1. `swapExactTokensForTokens` (line 224–230):
```solidity
function swapExactTokensForTokens(
    uint amountIn,
    uint amountOutMin,
    address[] calldata path,
    address to,
    uint deadline
) external virtual override ensure(deadline) returns (uint[] memory amounts)
```

2. `swapExactTokensForTokensSupportingFeeOnTransferTokens` (line 339–345):
```solidity
function swapExactTokensForTokensSupportingFeeOnTransferTokens(
    uint amountIn,
    uint amountOutMin,
    address[] calldata path,
    address to,
    uint deadline
) external virtual override ensure(deadline)
```
(no explicit `returns` clause — this function has no return value)

3. `swapExactETHForTokens` (line 252–259):
```solidity
function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline)
    external
    virtual
    override
    payable
    ensure(deadline)
    returns (uint[] memory amounts)
```

4. `swapExactETHForTokensSupportingFeeOnTransferTokens` (line 356–367):
```solidity
function swapExactETHForTokensSupportingFeeOnTransferTokens(
    uint amountOutMin,
    address[] calldata path,
    address to,
    uint deadline
)
    external
    virtual
    override
    payable
    ensure(deadline)
```
(no explicit `returns` clause)

5. `swapExactTokensForETH` (line 284–289):
```solidity
function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline)
    external
    virtual
    override
    ensure(deadline)
    returns (uint[] memory amounts)
```

6. `swapExactTokensForETHSupportingFeeOnTransferTokens` (line 379–390):
```solidity
function swapExactTokensForETHSupportingFeeOnTransferTokens(
    uint amountIn,
    uint amountOutMin,
    address[] calldata path,
    address to,
    uint deadline
)
    external
    virtual
    override
    ensure(deadline)
```
(no explicit `returns` clause)

All six confirmed from [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol).

Parameter-type/order match check against the objective's listed signatures:
- `swapExactTokensForTokens(uint256,uint256,address[],address,uint256)` — matches (`uint`≡`uint256` in Solidity; `amountIn, amountOutMin, path[], to, deadline`)
- `swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)` — matches
- `swapExactETHForTokens(uint256,address[],address,uint256) payable` — matches, confirmed `payable`
- `swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable` — matches, confirmed `payable`
- `swapExactTokensForETH(uint256,uint256,address[],address,uint256)` — matches, confirmed NOT payable
- `swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)` — matches, confirmed NOT payable

### Inferences
- None needed — this is a direct, verbatim primary-source confirmation.

### Gaps
- No specific git tag/release (e.g., `v1.0.0-beta.0`) was visible in the raw-file fetch; only the `master` branch ref was used and a historical commit SHA for the file's origin was retrieved separately via the GitHub API. If an exact pinned release tag is required for the record, that would need a separate lookup against `Uniswap/v2-periphery` releases/tags.

## Does UniswapV2Router02.sol, or any modifier/base contract it inherits, use tx.origin anywhere? Search the full file (and UniswapV2Library.sol if relevant) for "tx.origin" and report any hits verbatim with surrounding context, or explicitly state none were found.

### Takeaway
No occurrences of `tx.origin` (or any `msg.sender == tx.origin` / EOA-only gating pattern) were found anywhere in `UniswapV2Router02.sol` or `UniswapV2Library.sol`, which were both fetched and read in full directly from the primary GitHub source.

### Cited Findings
- Full-text read of `contracts/UniswapV2Router02.sol` (446/429 lines depending on line-ending count, full file contents retrieved and inspected end-to-end) contains zero matches for the string `tx.origin` — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol)
- The contract's only custom modifier is `ensure(uint deadline)`, which only checks `require(deadline >= block.timestamp, 'UniswapV2Router: EXPIRED'); _;` — no caller-origin check of any kind — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol), lines 18–21
- `UniswapV2Router02` inherits only from the interface `IUniswapV2Router02` (`contract UniswapV2Router02 is IUniswapV2Router02`, line 12) — an interface, which by definition contains no implementation/logic and therefore cannot contain a `tx.origin` check — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol), line 12
- Full-text read of `contracts/libraries/UniswapV2Library.sol` (the library the router calls into for pair address derivation, reserve/quote math) contains zero matches for `tx.origin` — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/libraries/UniswapV2Library.sol)
- The router's authorization model throughout both files relies exclusively on `msg.sender` (e.g., `TransferHelper.safeTransferFrom(path[0], msg.sender, ...)`), never `tx.origin` — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol), e.g. lines 73–74, 233–235, 346–348

### Inferences
- Because the router's only parent is a pure interface and its only modifier is a deadline check, there is no code path — inherited or local — through which a `tx.origin` check could be hiding outside the two files directly reviewed.

### Gaps
- I did not fetch/read `IUniswapV2Router02.sol` (the interface) itself, since interfaces in Solidity cannot contain executable logic (no function bodies), making a `tx.origin` check there a compile-time impossibility — this is a logical inference rather than a direct text-search confirmation of that specific file. If full exhaustiveness is required, that interface file and `TransferHelper.sol` / `SafeMath.sol` (imported helper libraries, not expected to contain access-control logic) were not individually text-searched for `tx.origin` in this pass.

## Is there any multicall wrapping or EOA-only modifier in the router? State explicitly if none found.

### Takeaway
None found. UniswapV2Router02 has no multicall function/wrapper and no EOA-only (externally-owned-account-only) modifier of any kind.

### Cited Findings
- The full contract body (`contracts/UniswapV2Router02.sol`) defines only one modifier, `ensure(uint deadline)` (checks `deadline >= block.timestamp` only), and no function named `multicall` or any batching/delegatecall wrapper appears anywhere in the file — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol)
- There is no `require(msg.sender == tx.origin, ...)`, no `extcodesize`-based EOA check, and no other caller-type gating logic anywhere in the file — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol)
- The contract's full function list (by name, confirmed from direct reading of the file) is: `_addLiquidity` (internal), `addLiquidity`, `addLiquidityETH`, `removeLiquidity`, `removeLiquidityETH`, `removeLiquidityWithPermit`, `removeLiquidityETHWithPermit`, `removeLiquidityETHSupportingFeeOnTransferTokens`, `removeLiquidityETHWithPermitSupportingFeeOnTransferTokens`, `_swap` (internal), `swapExactTokensForTokens`, `swapTokensForExactTokens`, `swapExactETHForTokens`, `swapTokensForExactETH`, `swapExactTokensForETH`, `swapETHForExactTokens`, `_swapSupportingFeeOnTransferTokens` (internal), `swapExactTokensForTokensSupportingFeeOnTransferTokens`, `swapExactETHForTokensSupportingFeeOnTransferTokens`, `swapExactTokensForETHSupportingFeeOnTransferTokens`, `quote`, `getAmountOut`, `getAmountIn`, `getAmountsOut`, `getAmountsIn`, plus the `receive()` fallback — none named `multicall` or similar — [GitHub raw source](https://raw.githubusercontent.com/Uniswap/v2-periphery/master/contracts/UniswapV2Router02.sol)

### Inferences
- UniswapV2 (as opposed to V3, which does implement a `Multicall` base contract) predates Uniswap's introduction of multicall patterns in its periphery contracts; the absence here is consistent with V2's simpler, single-call-per-transaction router design.

### Gaps
- None — this was directly confirmed by full-file inspection of the only relevant primary source file.
