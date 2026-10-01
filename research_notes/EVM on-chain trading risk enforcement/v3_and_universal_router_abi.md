# V3 & Universal Router ABI Reference — Uniswap (Ethereum) + PancakeSwap (BSC)

Consolidated from three research passes (full notes: `uniswap_universal_router.md`, `uniswap_v3_swaprouter02.md`, `pancakeswap_universal_router.md` in this same folder). Each of the 11 questions below is labeled CONFIRMED (primary source cited) or NOT CONFIRMED/PARTIAL exactly as the task required — no blending.

## TOP-LINE WARNING FOR THE GUARD DESIGN

Universal Router is **not a single fixed ABI**. On Ethereum mainnet there are at least two live deployments whose `Dispatcher.sol` decodes the *same* command IDs into *different* tuple shapes (5-field vs 6-field, see Q3). A Guard must branch its decoding on the target router **address**, not assume one global layout. The same caution applies on BSC, where PancakeSwap runs two generations of Universal Router plus Pancake-only command IDs that must not be treated as "unknown = safe."

---

## PART 1 — Uniswap Universal Router (Ethereum)

### Q1. Current deployed address(es) on Ethereum mainnet
**CONFIRMED** (primary source: `Uniswap/universal-router` repo file `deploy-addresses/mainnet.json`, cross-checked against Etherscan verified source and Sourcify-matched bytecode).

| Name | Address | Status |
|---|---|---|
| UniversalRouterV1 | `0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B` | legacy, pre-V2 support |
| UniversalRouterV1_2_V2Support | `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD` | legacy |
| UniversalRouterV2 | `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` | still live, Etherscan-labeled "Uniswap V4: Universal Router", verified exact match |
| UniversalRouterV2_1_1 | `0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA` | still live |
| UniversalRouterV2_1_2 | `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` | newest, still live |

None are deprecated/self-destructed — all remain callable. Treat V2, V2_1_1, and V2_1_2 as all "currently active" (older front-end/SDK integrations may still target V2). Gap: could not load `developers.uniswap.org/contracts/universal-router/deployments` directly (404 at research time) to get Uniswap's own "canonical/current" framing — the GitHub JSON was used as the authoritative substitute instead; recommend a manual re-check of that docs page before shipping.

### Q2. Exact command-ID constants from `Commands.sol`
**CONFIRMED** (primary source: raw `contracts/libraries/Commands.sol` at tags v1.6.0/2.0.0/2.1.1/2.1.2/2.2.0, re-confirmed against Sourcify-matched bytecode for both `0x66a9...` and `0x2361...`). Stable across every version checked:

```solidity
uint256 constant V3_SWAP_EXACT_IN  = 0x00;
uint256 constant V3_SWAP_EXACT_OUT = 0x01;
uint256 constant V2_SWAP_EXACT_IN  = 0x08;
uint256 constant V2_SWAP_EXACT_OUT = 0x09;
uint256 constant WRAP_ETH          = 0x0b;
uint256 constant UNWRAP_WETH       = 0x0c;
```

Safe to hardcode for all current mainnet Universal Router versions. (What is NOT version-stable: the mask width and the inputs tuple shape — see Q3/Q4.)

### Q3. ABI-decode shape for `V2_SWAP_EXACT_IN` (and `V3_SWAP_EXACT_IN`) inputs
**CONFIRMED** (primary source: `Dispatcher.sol`/`V2SwapRouter.sol`/`V3SwapRouter.sol`, raw GitHub + Sourcify-matched deployed source for both relevant addresses) — **but the shape differs by deployed router version:**

- **Older shape** (`UniversalRouterV2` @ `0x66a9...`, and all tags ≤ v1.6.0/2.0.0) — `V2_SWAP_EXACT_IN` inputs, per Dispatcher.sol's own decode comment `// equivalent: abi.decode(inputs, (address, uint256, uint256, address[], bool))`:
  ```
  (address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser)
  ```
  `V3_SWAP_EXACT_IN` mirrors this but with `bytes path` (packed `token|fee(3B)|token...` V3 path encoding) instead of `address[] path`:
  ```
  (address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
  ```
  `payerIsUser` is a raw `bool` in calldata; `Dispatcher.dispatch()` resolves it to a concrete `payer` address internally (`payerIsUser ? lockedBy : address(this)`).

- **Newer shape** (`UniversalRouterV2_1_1` @ `0x4C82...`, `UniversalRouterV2_1_2` @ `0x2361...`) — Sourcify-matched source shows a **6th trailing field**, `uint256[] minHopPriceX36` (per-hop minimum-price array, 1e36 fixed point), appended to both V2 and V3 variants:
  ```
  (address recipient, uint256 amountIn, uint256 amountOutMin, address[]|bytes path, bool payerIsUser, uint256[] minHopPriceX36)
  ```

`_EXACT_OUT` variants mirror their `_IN` counterparts with `amountOut`/`amountInMaximum` swapped in.

**Decoding risk**: decoding the 5-field shape against 6-field-encoded calldata (or vice versa) misreads the dynamic-array offset/length words — a classic silent-failure vector. The Guard MUST pick the decode shape based on which Universal Router address is the call target.

Gap: the 6-field claim for `UniversalRouterV2_1_1` specifically (`0x4C82...`) was confirmed via tag-matching (git tag `2.1.1`) rather than a second independent Sourcify pull against that exact address — one step less direct than the V2 and V2_1_2 claims, but highly likely correct.

### Q4. `commands` byte structure — 1 byte per command + allow-revert flag bit
**CONFIRMED** (primary source: `Commands.sol`, multiple tags + Sourcify-matched bytecode for both addresses). Each `commands` entry is exactly `bytes1`.

```solidity
bytes1 internal constant FLAG_ALLOW_REVERT = 0x80;
// Older (V2 @ 0x66a9..., tags ≤2.0.0):
bytes1 internal constant COMMAND_TYPE_MASK = 0x3f;
// Newer (V2_1_1/V2_1_2, tags 2.1.1/2.1.2/2.2.0):
bytes1 internal constant COMMAND_TYPE_MASK = 0x7f;
```

Dispatch: `uint256 command = uint8(commandType & Commands.COMMAND_TYPE_MASK);`. Allow-revert check: `command & FLAG_ALLOW_REVERT == 0` means a failing command reverts the whole batch; if the bit is set, failure is swallowed and execution continues. Example: `V2_SWAP_EXACT_IN` with allow-revert set = `0x08 | 0x80 = 0x88`. A Guard must mask before comparing against known command IDs (masking with `0x7f` is safe defensively across both mask eras, since all real command IDs are ≤ `0x40`).

### Q5. Does `execute()` need `msg.value`, or is ETH wrapped via an explicit command?
**CONFIRMED** (primary source: `UniversalRouter.sol`, `Payments.sol`, `Dispatcher.sol`, `Constants.sol`, raw GitHub + conceptually cross-checked newer deployed source). Both `execute()` overloads are `payable` — ETH is sent as `msg.value` on the top-level call. Universal Router does **not** auto-wrap `msg.value`; an explicit `WRAP_ETH` command must appear in the same `commands`/`inputs` batch.

`WRAP_ETH` inputs: `(address recipient, uint256 amount)`, decoded and passed to `Payments.wrapETH`, which operates on `address(this).balance` (i.e., ETH already sitting in the router, placed there by `msg.value`):
```solidity
function wrapETH(address recipient, uint256 amount) internal {
    if (amount == Constants.CONTRACT_BALANCE) amount = address(this).balance;
    else if (amount > address(this).balance) revert InsufficientETH();
    if (amount > 0) {
        WETH9.deposit{value: amount}();
        if (recipient != address(this)) WETH9.transfer(recipient, amount);
    }
}
```
Sentinel constants (`Constants.sol`): `ETH = address(0)`, `MSG_SENDER = address(1)`, `ADDRESS_THIS = address(2)`, `CONTRACT_BALANCE = 1 << 255`.

Typical ETH-in pattern (inference built directly from cited mechanics, matching known SDK behavior, not a quoted walkthrough): `msg.value = amountIn`; `commands = [WRAP_ETH, V2_SWAP_EXACT_IN]`; `WRAP_ETH` input = `(ADDRESS_THIS, CONTRACT_BALANCE)`; swap's `path[0] = WETH9`, `payerIsUser = false` (router pays from its own just-wrapped WETH balance). ETH-out mirrors this with `UNWRAP_WETH` after the swap. Flagged as inference, not a directly quoted official example — no official worked-example doc page was found.

### Q6. Full `execute()` signature and whether it's the only entry point
**CONFIRMED, but version-dependent** (primary source: `UniversalRouter.sol`, raw GitHub + Sourcify-matched deployed source for both addresses).

Older (`UniversalRouterV2` @ `0x66a9...`): exactly two overloads, and these are the **only** entry points into command dispatch:
```solidity
function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline)
    external payable checkDeadline(deadline) { execute(commands, inputs); }

function execute(bytes calldata commands, bytes[] calldata inputs)
    public payable override isNotLocked { ... }
```

Newer (`UniversalRouterV2_1_2` @ `0x2361...`): adds a **third** top-level entry point, `executeSigned(...)`, which still funnels into the same `execute(commands, inputs)` dispatch loop but is gated by an EIP-712 signature/intent check (inherits `RouteSigner`, `ChainedActions`):
```solidity
function executeSigned(
    bytes calldata commands, bytes[] calldata inputs,
    bytes32 intent, bytes32 data, bool verifySender,
    bytes32 nonce, bytes calldata signature, uint256 deadline
) external payable checkDeadline(deadline) { ... }
```
A Guard covering the newer routers must recognize `executeSigned`'s distinct selector too, or it will miss a genuine alternate swap-execution path. Gap: `RouteSigner`/`ChainedActions` internals (who is authorized to trigger `executeSigned`, whether it can relay someone else's pre-signed intent) were not fully pulled — needs follow-up before assuming normal `msg.sender`-based attribution holds for `executeSigned`.

---

## PART 2 — Uniswap V3 SwapRouter / SwapRouter02 (Ethereum, non-Universal-Router path)

### Q7. Current `SwapRouter02` deployed address
**CONFIRMED** (primary source: Etherscan verified-contract metadata, cross-checked across chains). Two distinct, both still-deployed and functional:

- Original `SwapRouter`: `0xE592427A0AEce92De3Edee1F18E0157C05861564` (Etherscan label "Uniswap V3: Router"; also deployed via CREATE2 at the same address on Polygon/Arbitrum)
- `SwapRouter02` (current standalone V3 router): `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` (Etherscan "Exact Match", contract name `SwapRouter02`, label "Uniswap V3: Router 2"; same address reused on Arbitrum/BSC/Goerli)

Neither is confirmed by Uniswap's own docs text as formally "deprecated" (the docs deployments page could not be fetched directly — redirect loop). The "SwapRouter02 is current" conclusion is an inference from Etherscan metadata + repo naming (`swap-router-contracts` is the newer package), not a directly quoted Uniswap statement. **Recommend a manual check of `docs.uniswap.org/contracts/v3/reference/deployments/ethereum-deployments` before relying on this for production.** Because the original router remains live, a Guard that only recognizes SwapRouter02 could miss trades routed through the original SwapRouter.

### Q8. Are `exactInputSingle`/`exactInput` typically wrapped in `multicall`?
**CONFIRMED** (primary source: `Multicall.sol` in `v3-periphery`, `IMulticallExtended.sol`/`IPeripheryPaymentsWithFeeExtended.sol` in `swap-router-contracts`, all fetched directly). SwapRouter02 exposes swap functions callable either directly or nested inside **three** multicall overloads:

```solidity
function multicall(bytes[] calldata data) public payable returns (bytes[] memory results);              // base
function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory);   // IMulticallExtended
function multicall(bytes32 previousBlockhash, bytes[] calldata data) external payable returns (bytes[] memory); // IMulticallExtended
```
Implementation loops `address(this).delegatecall(data[i])`, bubbling up revert reasons. `unwrapWETH9`/`unwrapWETH9WithFee`/`refundETH`/`sweepTokenWithFee` are designed to be bundled in the same multicall as the swap (ETH-out swaps pair with `unwrapWETH9`; ETH-in exact-output swaps pair with `refundETH` for excess ETH). This is architecturally why `deadline` was dropped from the swap-param structs (Q9) — it moved to the multicall-level overload instead.

**Guard implication**: it must branch on 4+ possible top-level selectors (3 multicall variants + direct swap calls) and recursively decode each inner `bytes` element of `data[]`. Gaps: did not independently verify all 3 selectors are reachable on the live mainnet bytecode (only GitHub interface was checked, not Etherscan's own ABI tab for cross-check); did not fetch the base non-fee `unwrapWETH9`/`refundETH` signatures directly (only the fee-extended variants were pulled) — verify those field orders before hardcoding.

### Q9. `ExactInputSingleParams`/`ExactInputParams` struct fields — does SwapRouter02 omit `deadline`?
**CONFIRMED** (primary source: direct GitHub raw-file fetch of both `ISwapRouter.sol` (v3-periphery) and `IV3SwapRouter.sol` (swap-router-contracts)).

Original `SwapRouter` (`ISwapRouter.sol`) — **includes `deadline`**:
```solidity
struct ExactInputSingleParams {
    address tokenIn; address tokenOut; uint24 fee; address recipient;
    uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
}
struct ExactInputParams {
    bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum;
}
```

`SwapRouter02` (`IV3SwapRouter.sol`) — **omits `deadline` entirely**, all other fields identical in name/type/order:
```solidity
struct ExactInputSingleParams {
    address tokenIn; address tokenOut; uint24 fee; address recipient;
    uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
}
struct ExactInputParams {
    bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum;
}
```

This confirms the suspected highest-risk failure mode is real: decoding SwapRouter02 calldata (7-field struct) with the original 8-field struct type misaligns every field after `recipient` — `amountIn`'s value would land in what the decoder thinks is `deadline`, and `amountOutMinimum` would land in what it thinks is `amountIn`. **A Guard must select the struct shape by which router address (Q7) is the call target, not assume one shape.** Also: since SwapRouter02's deadline protection is optional (lives only in the `multicall(uint256,bytes[])` overload, which callers may skip), a Guard cannot assume any deadline/expiry protection exists on a SwapRouter02 transaction. Gap: not cross-checked against Etherscan's own displayed verified-source copy for the live deployed bytecode (only GitHub `main` was fetched) — recommend that one final check before shipping.

---

## PART 3 — PancakeSwap Universal Router / Multicall (BSC)

### Q10. Do PancakeSwap's command-ID constants match Uniswap's exactly?
**CONFIRMED for the shared commands, with one real gap** (primary source: `github.com/pancakeswap/infinity-universal-router`, file `src/libraries/Commands.sol`, fetched directly).

All six requested command IDs **match Uniswap's values exactly**, byte-for-byte, and are still named `WRAP_ETH`/`UNWRAP_WETH` (not renamed to BNB/WBNB) despite being the BSC deployment:
```solidity
bytes1 internal constant FLAG_ALLOW_REVERT = 0x80;
bytes1 internal constant COMMAND_TYPE_MASK = 0x3f;
uint256 constant V3_SWAP_EXACT_IN  = 0x00;
uint256 constant V3_SWAP_EXACT_OUT = 0x01;
uint256 constant V2_SWAP_EXACT_IN  = 0x08;
uint256 constant V2_SWAP_EXACT_OUT = 0x09;
uint256 constant WRAP_ETH          = 0x0b;
uint256 constant UNWRAP_WETH       = 0x0c;
```

No renumbering/reordering of shared commands found. PancakeSwap **adds** Pancake-only command IDs not present in Uniswap's set: `INFI_SWAP=0x10`, `INFI_CL_INITIALIZE_POOL=0x13`, `INFI_BIN_INITIALIZE_POOL=0x14`, `EXECUTE_SUB_PLAN=0x21`, `STABLE_SWAP_EXACT_IN=0x22`, `STABLE_SWAP_EXACT_OUT=0x23` — a Guard must explicitly handle these (allow-list or reject), not treat unknown IDs as automatically safe.

Deployed BSC addresses (per official PancakeSwap developer docs):
- "Infinity Universal Router" / "Universal Router 2" (current): `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB`
- "v3 Universal Router" (previous generation, still deployed): `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416`

**Gaps**: (1) could not cross-check the `infinity-universal-router` GitHub source against BscScan's verified bytecode for `0xd9C500...` (tool refused to fetch bscscan.com directly) — re-check before shipping; (2) could not find or verify the command-ID table for the **older** v3 Universal Router (`0x1A0A18AC...`) — no dedicated repo found for it separate from `infinity-universal-router`; do not assume it matches the Infinity table if that older router is still in scope for the Guard.

### Q11. Exact `MulticallExtended` function selectors
**NOT independently primary-source confirmed** — flagged clearly per the task's instructions. Could not locate a browsable `MulticallExtended.sol`/`IMulticallExtended.sol` file in any PancakeSwap-owned GitHub repo within the research budget (searched `pancake-v3-contracts`, `pancake-smart-router`, `pancake-universal-router`, `infinity-universal-router`). Could not fetch BscScan directly either (tool domain restriction).

Best available data (from a third-party BscScan-dependency aggregator, codeslaw.app, viewing PancakeSwap's **V3 Smart Router** at `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` — note this is a *different contract* from the Universal Router addresses in Q10):
```
multicall(bytes[] data)                              -> 0xac9650d8
multicall(uint256 deadline, bytes[] data)             -> 0x5ae401dc
multicall(bytes32 previousBlockhash, bytes[] data)    -> 0x1f0464d1
```
These selectors are pure `keccak256(signature)` math and would be correct *if* PancakeSwap's contract truly exposes exactly these three signatures unmodified — but that exposure claim itself is only secondary-sourced here, not read from a primary GitHub/BscScan source. Uniswap's own upstream `MulticallExtended.sol`/`IMulticallExtended.sol` (the pattern this is modeled on) is confirmed to exist at `github.com/Uniswap/swap-router-contracts`.

**Gaps (all unresolved, flag before use):** (1) the signatures above are not verified against a primary PancakeSwap source; (2) unclear whether `multicall` exists on the Universal Router contracts at all (Q10 addresses) or is exclusive to the separate V3 Smart Router (Q11 address) — this determines which address(es) a Guard applies this decoding logic to; (3) selectors were not independently re-derived from BscScan's own ABI/verified-source tab for `0x13f4EA83...`.

---

## Summary confirmation table

| # | Question | Status |
|---|---|---|
| 1 | Universal Router mainnet address(es) | CONFIRMED (5 addresses, 3 "currently active") |
| 2 | Universal Router command IDs | CONFIRMED (stable across all versions) |
| 3 | V2_SWAP_EXACT_IN inputs shape | CONFIRMED (version-dependent: 5-field vs 6-field) |
| 4 | commands byte/flag-bit structure | CONFIRMED |
| 5 | msg.value vs WRAP_ETH command | CONFIRMED (mechanics); sequencing example is an inference, not a quoted walkthrough |
| 6 | execute() signature(s) / sole entry point | CONFIRMED (version-dependent: executeSigned added in newer router) |
| 7 | SwapRouter02 address | CONFIRMED (address); "current" framing is an inference, not a quoted Uniswap doc statement |
| 8 | multicall wrapping on SwapRouter02 | CONFIRMED (3 multicall overloads + direct calls) |
| 9 | ExactInputSingleParams/ExactInputParams fields, deadline presence | CONFIRMED (original includes deadline; SwapRouter02 omits it) |
| 10 | PancakeSwap command IDs vs Uniswap | CONFIRMED for shared IDs (match exactly) + Pancake-only additions found; older router's table NOT confirmed |
| 11 | PancakeSwap MulticallExtended selectors | NOT independently primary-source confirmed (secondary aggregator only) |

## Full underlying notes
- `uniswap_universal_router.md` (Part 1 detail)
- `uniswap_v3_swaprouter02.md` (Part 2 detail)
- `pancakeswap_universal_router.md` (Part 3 detail)

All in: `C:/mypropguard/research_notes/EVM on-chain trading risk enforcement/`
