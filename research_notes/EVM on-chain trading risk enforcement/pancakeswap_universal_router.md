# PancakeSwap Universal Router & MulticallExtended (BSC) — Cross-check vs Uniswap

## Q10: PancakeSwap Universal Router command-ID constants vs Uniswap's Commands.sol; deployed BSC address

### Takeaway
PancakeSwap has **two** distinct Universal Router generations deployed on BSC mainnet, with two different GitHub repos found. The current/latest one — `github.com/pancakeswap/infinity-universal-router` ("Universal Router 2", address `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB`) — reuses Uniswap's exact numeric values for every command the two protocols share (V2/V3 swap-exact-in/out, WRAP_ETH, UNWRAP_WETH, Permit2 ops, SWEEP, TRANSFER, PAY_PORTION), and then **appends new, Pancake-only command IDs** at higher byte values (0x10, 0x13, 0x14, 0x21, 0x22, 0x23) for Infinity CL/Bin pools, StableSwap, and sub-plans — none of which exist in Uniswap's router. No renumbering or reordering of the shared commands was found. This is CONFIRMED from the dedicated repo's primary source for the shared command IDs, but with an important gap noted below: I could not verify this repo's source against on-chain bytecode, nor find/verify the source for the *older*, still-separately-deployed "PancakeSwap: Universal Router" (non-Infinity, address `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416`), which a security Guard must also be able to decode if it still receives traffic.

### Cited Findings
- Dedicated repo exists: `github.com/pancakeswap/infinity-universal-router`, file `src/libraries/Commands.sol`. — [GitHub](https://github.com/pancakeswap/infinity-universal-router/blob/main/src/libraries/Commands.sol)
- Exact constants and values quoted from that file (WebFetch of the raw GitHub blob):
  - `bytes1 internal constant FLAG_ALLOW_REVERT = 0x80;`
  - `bytes1 internal constant COMMAND_TYPE_MASK = 0x3f;`
  - `uint256 constant V3_SWAP_EXACT_IN = 0x00;`
  - `uint256 constant V3_SWAP_EXACT_OUT = 0x01;`
  - `uint256 constant PERMIT2_TRANSFER_FROM = 0x02;`
  - `uint256 constant PERMIT2_PERMIT_BATCH = 0x03;`
  - `uint256 constant SWEEP = 0x04;`
  - `uint256 constant TRANSFER = 0x05;`
  - `uint256 constant PAY_PORTION = 0x06;`
  - `uint256 constant V2_SWAP_EXACT_IN = 0x08;`
  - `uint256 constant V2_SWAP_EXACT_OUT = 0x09;`
  - `uint256 constant PERMIT2_PERMIT = 0x0a;`
  - `uint256 constant WRAP_ETH = 0x0b;` (note: named `WRAP_ETH`, not `WRAP_BNB`, despite BSC deployment)
  - `uint256 constant UNWRAP_WETH = 0x0c;` (named `UNWRAP_WETH`, not `UNWRAP_WBNB`)
  - `uint256 constant PERMIT2_TRANSFER_FROM_BATCH = 0x0d;`
  - `uint256 constant BALANCE_CHECK_ERC20 = 0x0e;`
  - `uint256 constant INFI_SWAP = 0x10;` — **Pancake-only**, not in Uniswap's command set
  - `uint256 constant INFI_CL_INITIALIZE_POOL = 0x13;` — **Pancake-only**
  - `uint256 constant INFI_BIN_INITIALIZE_POOL = 0x14;` — **Pancake-only**
  - `uint256 constant EXECUTE_SUB_PLAN = 0x21;` — **Pancake-only**
  - `uint256 constant STABLE_SWAP_EXACT_IN = 0x22;` — **Pancake-only** (PancakeSwap StableSwap AMM has no Uniswap equivalent)
  - `uint256 constant STABLE_SWAP_EXACT_OUT = 0x23;` — **Pancake-only**
  — [Source: infinity-universal-router/src/libraries/Commands.sol](https://github.com/pancakeswap/infinity-universal-router/blob/main/src/libraries/Commands.sol)
- Comparing to the task's assumed Uniswap values (V2_SWAP_EXACT_IN=0x08, V2_SWAP_EXACT_OUT=0x09, V3_SWAP_EXACT_IN=0x00, V3_SWAP_EXACT_OUT=0x01, WRAP_ETH=0x0b, UNWRAP_WETH=0x0c): **all six match exactly**, byte-for-byte, in the Pancake repo. No difference found for these six IDs.
- PancakeSwap BSC mainnet deployed addresses (from official developer docs page):
  - "Infinity Universal Router" (latest / "Universal Router 2"): `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB` — [developer.pancakeswap.finance](https://developer.pancakeswap.finance/contracts/universal-router/addresses)
  - "v3 Universal Router" (previous generation, still listed/deployed): `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416` — [developer.pancakeswap.finance](https://developer.pancakeswap.finance/contracts/universal-router/addresses); also appears on BscScan as "PancakeSwap: Universal Router" — [BscScan](https://bscscan.com/address/0x1a0a18ac4becddbd6389559687d1a73d8927e416)
  - A "PancakeSwap: Universal Router 2" label on BscScan corresponds to the `0xd9C500...` address above. — [BscScan](https://bscscan.com/address/0xd9c500dff816a1da21a48a732d3498bf09dc9aeb)
- Search did not surface a dedicated, non-"infinity" repo named `pancake-universal-router`; only `infinity-universal-router` was found as a standalone Universal Router repo on `github.com/pancakeswap`. — [GitHub org listing search]

### Inferences
- Because PancakeSwap's Commands.sol preserves Uniswap's numeric values for every shared command and only adds new IDs above the existing range (plus a few PancakeSwap-only IDs interspersed at 0x10/0x13/0x14), a Guard contract that hardcodes Uniswap's V2/V3 swap and wrap/unwrap command bytes should decode correctly for the commands it already knows about on the **Infinity Universal Router**, but it must explicitly allow-list (or explicitly reject/flag) the Pancake-only command IDs (0x10, 0x13, 0x14, 0x21, 0x22, 0x23) rather than silently treating them as "unknown → safe" or "unknown → V2/V3 swap", since those are structurally different operations (Infinity CL/Bin pool init, StableSwap, sub-plans) that a naive decoder could misinterpret.
- The existence of two separately deployed Universal Router contracts on BSC (old "v3 Universal Router" at `0x1A0A18AC...` and new "Infinity Universal Router"/"Universal Router 2" at `0xd9C500...`) means a Guard must determine which router a given `to` address is before applying command-ID semantics, since the older router may not implement Infinity/Stable commands at all (and conversely may have a different byte layout that this research did not verify — see Gaps).

### Gaps
- **Not verified**: whether the GitHub source at `infinity-universal-router/src/libraries/Commands.sol` is the actual verified/deployed source for `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB` on BscScan. I attempted to fetch BscScan directly to cross-check verified source but the fetch tool refused the domain ("Unable to verify if domain bscscan.com is safe to fetch"). This should be independently re-checked via BscScan's "Contract" tab or `gh`/API-based retrieval before shipping Guard logic.
- **Not confirmed**: the exact Commands.sol / command-ID layout for the **older** "v3 Universal Router" at `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416`. No dedicated GitHub repo was found for this earlier version distinct from `infinity-universal-router`; it may predate that repo's history (check that repo's git tags/older commits, or BscScan verified source for that address directly) or live in `pancake-frontend`'s packages. If this older router is still reachable/whitelisted, the Guard needs its command table confirmed separately — do not assume it is identical to the Infinity version's table.
- Did not independently re-derive Uniswap's own Commands.sol values in this task (that is explicitly the parallel researcher's job); the "match" conclusion above is only as good as the task's stated assumed Uniswap values.

---

## Q11: MulticallExtended — exact multicall function signatures and 4-byte selectors

### Takeaway
A PancakeSwap V3 Smart Router contract deployed on BSC (`0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`, BscScan-labeled "PancakeSwap V3: Smart Router") exposes three `multicall` overloads — plain, deadline-checked, and previousBlockhash-checked — mirroring Uniswap's `MulticallExtended`/`IMulticallExtended` pattern. I could **not** locate a PancakeSwap-owned public GitHub repo containing `MulticallExtended.sol`/`IMulticallExtended.sol` source directly (search repeatedly surfaced only Uniswap's `swap-router-contracts` repo as the origin of this pattern); the selector/signature data below comes from a BscScan-derived third-party contract-dependency viewer (codeslaw.app), not a GitHub source file or direct BscScan fetch I could perform myself. This is therefore **NOT independently primary-source confirmed** by this research — it is one step removed (secondary aggregator of verified bytecode/ABI) and should be re-verified directly against BscScan's "Contract" / "Read/Write Contract" ABI for that address before use in a security Guard.

### Cited Findings
- Three multicall overloads and selectors reported for PancakeSwap V3 Smart Router at `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` (BNB Chain), per a WebFetch summary of codeslaw.app's dependency view of that verified contract:
  - `multicall(bytes[] data)` — selector `0xac9650d8`
  - `multicall(uint256 deadline, bytes[] data)` — selector `0x5ae401dc`
  - `multicall(bytes32 previousBlockhash, bytes[] data)` — selector `0x1f0464d1`
  — [codeslaw.app dependency view](https://www.codeslaw.app/contracts/bnbchain/0x13f4ea83d0bd40e75c8222255bc855a974568dd4?tab=dependencies)
- Supporting structural claim (same source, lower confidence/summarized by fetch tool, not a verbatim quote): the SmartRouter contract inherits `MulticallExtended`, which implements `IMulticallExtended` + a base `Multicall`; `MulticallExtended` reportedly lives at `contracts/base/MulticallExtended.sol` and `IMulticallExtended` at `contracts/interfaces/IMulticallExtended.sol` within the Smart Router's own contract tree (file paths as reported by the aggregator, not verified against a browsable GitHub tree). — [codeslaw.app](https://www.codeslaw.app/contracts/bnbchain/0x13f4ea83d0bd40e75c8222255bc855a974568dd4?tab=dependencies)
- Uniswap's own `MulticallExtended.sol`/`IMulticallExtended.sol` (the pattern PancakeSwap's is derived from) is public at `github.com/Uniswap/swap-router-contracts/contracts/base/MulticallExtended.sol` and `.../contracts/interfaces/IMulticallExtended.sol`, confirming the deadline- and previousBlockhash-checked overload pattern exists upstream. — [Uniswap/swap-router-contracts](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/base/MulticallExtended.sol)
- No PancakeSwap-owned repo (`pancake-v3-contracts`, `pancake-smart-router`, `pancake-universal-router`, `infinity-universal-router`) was found via search/fetch to contain a browsable `MulticallExtended.sol` file; `pancake-v3-contracts` exists on GitHub (`github.com/pancakeswap/pancake-v3-contracts`) but I could not locate/fetch the specific periphery/router subpath containing this file within the tool budget. — [GitHub - pancakeswap/pancake-v3-contracts](https://github.com/pancakeswap/pancake-v3-contracts)

### Inferences
- Because `multicall(bytes[])`, `multicall(uint256,bytes[])`, and `multicall(bytes32,bytes[])` are the exact same function signatures Uniswap uses, their 4-byte selectors (derived purely from `keccak256(signature)`) are necessarily identical regardless of which org deployed the bytecode — so even without a verbatim PancakeSwap source quote, the selector values `0xac9650d8`, `0x5ae401dc`, and `0x1f0464d1` are very likely correct for PancakeSwap's router **if** the aggregator's claim that it exposes these exact three signatures is accurate. The risk is not in the selector math but in whether PancakeSwap's contract truly exposes all three overloads unmodified (e.g., some forks drop the previousBlockhash variant or change parameter order within the deadline-checked overload's inner calldata).
- A Guard relying on these selectors should independently re-derive them from BscScan's verified ABI/source for the exact router/SmartRouter address(es) it is asked to protect, rather than trusting this secondary source alone, given the "NOT independently primary-source confirmed" status above.

### Gaps
- Could not fetch BscScan directly (tool refused the domain) to read the verified source/ABI myself for `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` or cross-check whether this is the correct/current "Smart Router" contract a Guard should care about (vs. the Universal Router addresses in Q10 — note Smart Router and Universal Router are different contracts in PancakeSwap's architecture; a Guard decoding Universal Router calldata should confirm whether `multicall` even appears on the Universal Router path or only on the separate V3 Smart Router).
- Could not locate and read the actual `MulticallExtended.sol`/`IMulticallExtended.sol` source text (function bodies, modifiers, parameter names) from any PancakeSwap-owned GitHub repo within the tool-call budget — only Uniswap's upstream equivalent was directly readable. This should be re-attempted (e.g., searching inside `pancake-v3-contracts` repo tree directly via GitHub's code search, or via `gh api` against that repo) before an implementation team copies exact selector/decoding logic into Solidity.
- Did not confirm whether the Universal Router contracts themselves (Q10's `0x1A0A18AC...` or `0xd9C500...`) expose any `multicall` variants at all, or whether `multicall` is exclusively a V3 Smart Router feature on PancakeSwap's BSC deployment — this distinction matters for which address(es) the Guard applies the MulticallExtended decoding logic to.
