# Uniswap Universal Router (Ethereum Mainnet) — ABI-Decoding Reference for a Safe Guard Contract

## IMPORTANT CROSS-CUTTING FINDING (read before anything else)

There are **multiple actively-relevant Universal Router deployments on Ethereum mainnet with DIFFERENT calldata ABI shapes for the same command IDs**. A Guard that hardcodes one shape will misparse (and therefore potentially fail-open on) transactions sent to a different deployed version. This was CONFIRMED by diffing verified/matched source code pulled directly for each deployed address (see Q1 and Q3). Specifically:

- The older-but-still-live `UniversalRouterV2` at `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` decodes `V2_SWAP_EXACT_IN` / `V3_SWAP_EXACT_IN` / etc. inputs as the "classic" 5-field shape (no per-hop price-protection array), and uses `COMMAND_TYPE_MASK = 0x3f` (no `ACROSS_V4_DEPOSIT_V3` command).
- The newer `UniversalRouterV2_1_1` / `UniversalRouterV2_1_2` deployments decode the **same command IDs** with an **extra trailing `uint256[] minHopPriceX36` field**, and use `COMMAND_TYPE_MASK = 0x7f` plus an additional `ACROSS_V4_DEPOSIT_V3 = 0x40` command and an additional top-level `executeSigned(...)` entry point not present on the older deployment.

A Guard must therefore branch its decoding logic on **which Universal Router address** (`msg.to` / the Safe transaction's `to`) is being called, not assume a single global ABI layout for all "Universal Router" calls.

---

## Key Question 1: Current deployed address(es) on Ethereum mainnet (latest + still-active older ones)

### Takeaway
CONFIRMED (primary source: Uniswap's own `deploy-addresses/mainnet.json` in the `Uniswap/universal-router` GitHub repo, cross-checked against Etherscan and Sourcify verified/matched bytecode). There are six named mainnet deployments tracked by Uniswap, the three most relevant for current integrations being `UniversalRouterV2`, `UniversalRouterV2_1_1`, and `UniversalRouterV2_1_2` (newest). All are still live contracts on mainnet (none are self-destructed/deprecated in the sense of being removed — "older" ones remain callable).

### Cited Findings
- Full mainnet deployment address list, taken verbatim from `https://raw.githubusercontent.com/Uniswap/universal-router/main/deploy-addresses/mainnet.json` — [Uniswap/universal-router deploy-addresses/mainnet.json](https://github.com/Uniswap/universal-router/blob/main/deploy-addresses/mainnet.json):
  ```json
  {
    "UniversalRouterV1": "0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B",
    "UnsupportedProtocol": "0x76D631990d505E4e5b432EEDB852A60897824D68",
    "UniversalRouterV1_2_V2Support": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    "UniversalRouterV2": "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    "UniversalRouterV2_1_1": "0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA",
    "UniversalRouterV2_1_2": "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85"
  }
  ```
  (`UnsupportedProtocol` is a decoy/placeholder contract Uniswap deploys at addresses of deprecated routers on some chains, not a router itself — not relevant to decoding.)
- `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` is verified on Etherscan as contract name `UniversalRouter`, "Exact Match", compiler `v0.8.26+commit.8a97fa7a`, and is publicly labeled "Uniswap V4: Universal Router" — [Etherscan](https://etherscan.io/address/0x66a9893cc07d91d95644aedd05d03f95e1dba8af).
- Sourcify (`https://sourcify.dev/server/v2/contract/1/<address>`) returns a full verified/matched source tree for `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` whose `Commands.sol` uses `COMMAND_TYPE_MASK = 0x3f` (no `ACROSS_V4_DEPOSIT_V3`), i.e. it matches the `2.0.0` git tag's command set — fetched directly from Sourcify's contract API (chain id 1 = Ethereum mainnet).
- Sourcify also returns a full verified/matched source tree for `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` (`UniversalRouterV2_1_2`) whose `Commands.sol` uses `COMMAND_TYPE_MASK = 0x7f` plus `ACROSS_V4_DEPOSIT_V3 = 0x40`, matching the `2.1.1`/`2.1.2`/`2.2.0` git tags.
- The `Uniswap/universal-router` GitHub repo has git tags up through `2.2.0` as of research date (2026-10-01); tags observed: `v1.0.0-beta.3/4/5, v1.0.0, v1.0.1, v1.1.0, v1.2.2, v1.4.0, v1.4.1, v1.4.2, v1.4.3, v1.6.0, 2.0.0, 2.1.1, 2.1.2, 2.2.0` — [github.com/Uniswap/universal-router/tags](https://github.com/Uniswap/universal-router/tags).
- Uniswap's own developer docs page title/URL indicates a canonical deployments page exists at `https://developers.uniswap.org/contracts/universal-router/deployments` (the `docs.uniswap.org` URL redirects there with HTTP 301), but the fetch of that specific path returned HTTP 404 at research time, so its exact current content could not be directly quoted — treat the GitHub JSON file above as the authoritative primary source instead.

### Inferences
- `UniversalRouterV2_1_2` (`0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`) is the most recently added/newest-numbered deployment tracked in the repo's own address registry, and is therefore the best candidate for "current/latest" — but this is an inference from version ordering and file content, not a direct Uniswap statement naming it "the current default."
- `UniversalRouterV2` (`0x66a9893cc07d91d95644aedd05d03f95e1dba8af`) is almost certainly still routed to by a meaningful share of existing integrations/front-ends built before `2.1.x` shipped (it is the contract Etherscan publicly labels as "Uniswap V4: Universal Router"), so a Guard protecting an account that could receive calls from either an older integrator SDK or the newest one should treat **all three of V2, V2_1_1, V2_1_2 as "currently active"** rather than assuming only the newest is in use.
- `UniversalRouterV1` and `UniversalRouterV1_2_V2Support` are legacy (pre-V4) deployments; they remain deployed/callable on-chain but reflect command sets without `V4_SWAP` — include them in an allow-list only if the protected account is expected to still interact with pre-V4 integrators.

### Gaps
- Could not directly load `developers.uniswap.org/contracts/universal-router/deployments` to quote Uniswap's own prose description of which version is "canonical" for new integrations (got HTTP 404 on the exact path tried); the GitHub JSON registry was used as the authoritative substitute. If a guard implementation needs Uniswap's own current recommendation text (not just addresses), that specific docs page should be re-fetched/re-verified by a human before relying on it.
- No independent on-chain transaction-volume check was performed to quantify how much current swap volume flows through each address; "still-active" above is based on contract existence/verification, not live usage telemetry.

---

## Key Question 2: Exact command-ID constants from `Commands.sol`

### Takeaway
CONFIRMED (primary source: raw file content fetched directly from `github.com/Uniswap/universal-router`, `contracts/libraries/Commands.sol`, both at the `v1.6.0`/`2.0.0`/`2.1.1`/`2.1.2`/`2.2.0` tags AND independently re-confirmed against the verified/matched deployed bytecode via Sourcify for the two mainnet addresses `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` and `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`). The six requested command IDs have been **stable across every tagged version and every deployed mainnet address checked** — they are not where the version differences live (the version differences are in the mask and in some decode shapes — see Q3/Q4).

### Cited Findings
- Exact quoted values for the six requested commands, verbatim from `contracts/libraries/Commands.sol` (identical in `v1.6.0`, `2.0.0`, `2.1.1`, `2.1.2`, `2.2.0`, and in both deployed-bytecode sources pulled via Sourcify):
  ```solidity
  uint256 constant V3_SWAP_EXACT_IN  = 0x00;
  uint256 constant V3_SWAP_EXACT_OUT = 0x01;
  uint256 constant V2_SWAP_EXACT_IN  = 0x08;
  uint256 constant V2_SWAP_EXACT_OUT = 0x09;
  uint256 constant WRAP_ETH          = 0x0b;
  uint256 constant UNWRAP_WETH       = 0x0c;
  ```
  — [raw.githubusercontent.com/Uniswap/universal-router/v1.6.0/contracts/libraries/Commands.sol](https://github.com/Uniswap/universal-router/blob/v1.6.0/contracts/libraries/Commands.sol), [.../2.1.1/...](https://github.com/Uniswap/universal-router/blob/2.1.1/contracts/libraries/Commands.sol)
- Full command list at `v1.6.0` (mask `0x3f`, no V4, includes NFT-marketplace commands like Seaport/X2Y2/Sudoswap): `V3_SWAP_EXACT_IN=0x00, V3_SWAP_EXACT_OUT=0x01, PERMIT2_TRANSFER_FROM=0x02, PERMIT2_PERMIT_BATCH=0x03, SWEEP=0x04, TRANSFER=0x05, PAY_PORTION=0x06, [0x07 placeholder], V2_SWAP_EXACT_IN=0x08, V2_SWAP_EXACT_OUT=0x09, PERMIT2_PERMIT=0x0a, WRAP_ETH=0x0b, UNWRAP_WETH=0x0c, PERMIT2_TRANSFER_FROM_BATCH=0x0d, BALANCE_CHECK_ERC20=0x0e, SEAPORT_V1_5=0x10, LOOKS_RARE_V2=0x11, NFTX=0x12, CRYPTOPUNKS=0x13, OWNER_CHECK_721=0x15, OWNER_CHECK_1155=0x16, SWEEP_ERC721=0x17, X2Y2_721=0x18, SUDOSWAP=0x19, NFT20=0x1a, X2Y2_1155=0x1b, FOUNDATION=0x1c, SWEEP_ERC1155=0x1d, ELEMENT_MARKET=0x1e, SEAPORT_V1_4=0x20, EXECUTE_SUB_PLAN=0x21, APPROVE_ERC20=0x22`.
- Full command list at `2.0.0` (mask `0x3f`, matches deployed `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` exactly per Sourcify): same core swap/payment commands as above but V4 era — `PERMIT2_TRANSFER_FROM=0x02, PERMIT2_PERMIT_BATCH=0x03, SWEEP=0x04, TRANSFER=0x05, PAY_PORTION=0x06, PERMIT2_PERMIT=0x0a, PERMIT2_TRANSFER_FROM_BATCH=0x0d, BALANCE_CHECK_ERC20=0x0e, V4_SWAP=0x10, V3_POSITION_MANAGER_PERMIT=0x11, V3_POSITION_MANAGER_CALL=0x12, V4_INITIALIZE_POOL=0x13, V4_POSITION_MANAGER_CALL=0x14, EXECUTE_SUB_PLAN=0x21`.
- Full command list at `2.1.1`/`2.1.2`/`2.2.0` (mask `0x7f`, matches deployed `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` exactly per Sourcify): identical to `2.0.0`'s list **plus** `PAY_PORTION_FULL_PRECISION=0x07` and `ACROSS_V4_DEPOSIT_V3=0x40` (reserved range "0x40–0x5f...for 3rd party integrations").

### Inferences
- Because the six requested command IDs are byte-identical across every version and every live deployed address checked, a Guard can safely hardcode `V2_SWAP_EXACT_IN=0x08, V2_SWAP_EXACT_OUT=0x09, V3_SWAP_EXACT_IN=0x00, V3_SWAP_EXACT_OUT=0x01, WRAP_ETH=0x0b, UNWRAP_WETH=0x0c` for all mainnet Universal Router versions currently relevant. What must NOT be hardcoded identically across versions is (a) the `COMMAND_TYPE_MASK` (0x3f vs 0x7f — see Q4) and (b) the inputs decode shape for swap commands (see Q3).

### Gaps
- None for this specific question — directly confirmed from both source and deployed bytecode.

---

## Key Question 3: Exact ABI-decode field order for `V2_SWAP_EXACT_IN` and `V3_SWAP_EXACT_IN` inputs

### Takeaway
CONFIRMED (primary source: `Dispatcher.sol` `dispatch()` function, fetched as raw GitHub source for tag `v1.6.0` and independently re-fetched from Sourcify's verified/matched source for both the `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` and `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` deployed addresses). **The shape differs by deployed version** — this is the single most important decoding detail for a Guard.

### Cited Findings
- On `UniversalRouterV2` (`0x66a9893cc07d91d95644aedd05d03f95e1dba8af`) and on all tags up to and including `2.0.0`/`v1.6.0`, `Dispatcher.sol` decodes `V2_SWAP_EXACT_IN` inputs with the comment `// equivalent: abi.decode(inputs, (address, uint256, uint256, address[], bool))`, i.e.:
  ```
  (address recipient, uint256 amountIn, uint256 amountOutMin, address[] path, bool payerIsUser)
  ```
  decoded via inline assembly `calldataload` at offsets `0x00` (recipient), `0x20` (amountIn), `0x40` (amountOutMin), `0x80` (payerIsUser), with the `address[] path` extracted separately via the helper `inputs.toAddressArray(3)` (the "3" is the tuple-slot index for the dynamic array head). Source: `contracts/base/Dispatcher.sol` at tag `v1.6.0` — [github.com/Uniswap/universal-router/blob/v1.6.0/contracts/base/Dispatcher.sol](https://github.com/Uniswap/universal-router/blob/v1.6.0/contracts/base/Dispatcher.sol); re-confirmed identical in the Sourcify-matched source for `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`.
- The matching internal function signature (same tag) is:
  ```solidity
  function v2SwapExactInput(
      address recipient,
      uint256 amountIn,
      uint256 amountOutMinimum,
      address[] calldata path,
      address payer
  ) internal
  ```
  (note: the 5th field is the already-resolved `payer` **address**, not the raw `payerIsUser` **bool** — `payerIsUser` is decoded as a bool from calldata, then `Dispatcher.dispatch()` converts it to a concrete payer address via `address payer = payerIsUser ? lockedBy : address(this);` before calling `v2SwapExactInput`. The raw calldata field at byte offset 0x80 is a `bool`, encoded as a full 32-byte word per standard ABI bool encoding.) Source: `contracts/modules/uniswap/v2/V2SwapRouter.sol` at tag `v1.6.0`.
- On the newer deployed routers `UniversalRouterV2_1_1`/`UniversalRouterV2_1_2` (confirmed directly against Sourcify-matched source for `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`), `Dispatcher.sol` instead decodes `V2_SWAP_EXACT_IN` with the comment `// equivalent: abi.decode(inputs, (address, uint256, uint256, address[], bool, uint256[]))` — an added **6th field**, `uint256[] minHopPriceX36`, a per-hop minimum-price array (in Q96-like 1e36 fixed-point) used for intra-route price protection. The corresponding internal function signature in the same deployed source is:
  ```solidity
  function v2SwapExactInput(
      address recipient,
      uint256 amountIn,
      uint256 amountOutMinimum,
      address[] calldata path,
      address payer,
      uint256[] calldata minHopPriceX36
  ) internal
  ```
  Source: `contracts/modules/uniswap/v2/V2SwapRouter.sol` and `contracts/base/Dispatcher.sol`, pulled as verified/matched source for mainnet address `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85` via the Sourcify API (`sourcify.dev/server/v2/contract/1/<address>?fields=sources`).
- For `V3_SWAP_EXACT_IN`, the older-shape (`UniversalRouterV2` / tag `v1.6.0`/`2.0.0`) decode is, per `Dispatcher.sol` comment `// equivalent: abi.decode(inputs, (address, uint256, uint256, bytes, bool))`:
  ```
  (address recipient, uint256 amountIn, uint256 amountOutMin, bytes path, bool payerIsUser)
  ```
  where `path` is the V3-style packed `bytes` encoding (`token0 | fee(3 bytes) | token1 | fee(3 bytes) | token2 ...`), extracted via `inputs.toBytes(3)`. The matching internal signature (`V3SwapRouter.sol`, tag `v1.6.0`) is:
  ```solidity
  function v3SwapExactInput(
      address recipient,
      uint256 amountIn,
      uint256 amountOutMinimum,
      bytes calldata path,
      address payer
  ) internal
  ```
- On the newer deployed routers (`V2_1_1`/`V2_1_2`), `V3_SWAP_EXACT_IN`'s decode comment becomes `// equivalent: abi.decode(inputs, (address, uint256, uint256, bytes, bool, uint256[]))` — again adding the trailing `uint256[] minHopPriceX36` field, confirmed directly against the Sourcify-matched source for `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`.
- `V2_SWAP_EXACT_OUT` / `V3_SWAP_EXACT_OUT` mirror the same field pattern as their `_IN` counterparts, with `amountOut`/`amountInMaximum` swapped in for `amountIn`/`amountOutMinimum` (confirmed from the same `v1.6.0` `Dispatcher.sol`/`V2SwapRouter.sol`/`V3SwapRouter.sol` source).

### Inferences
- A Guard **must** know which Universal Router address a transaction targets before choosing a decode shape: 5-field tuple (no price array) for `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` and any pre-`2.1.1` deployment; 6-field tuple (trailing `uint256[] minHopPriceX36`) for `0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA` and `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`. Decoding the 5-field shape against a 6-field-encoded calldata (or vice versa) will either revert or, worse, silently misread the dynamic-array offset/length words, which could make amount/slippage fields look like something else — a textbook way for a hand-rolled Guard to "silently pass through unchecked trades" if it isn't version-aware.
- The first four semantic fields (`recipient`, `amountIn`/`amountOut`, `amountOutMinimum`/`amountInMaximum`, `path`) are at fixed, version-stable calldata offsets (`0x00`, `0x20`, `0x40`, dynamic-array head at tuple slot 3) in both shapes, and the `payerIsUser` bool is always at the word after the path's static head region before the array grows — so a Guard that only needs `recipient`/`amountIn`/`amountOutMin`/`path` (e.g., to enforce an allow-listed token/pool and a minimum-received floor) can likely read just the fixed-offset prefix and the `path` dynamic field without needing to fully decode the trailing `minHopPriceX36` array, as long as it correctly accounts for `inputs` being a nested dynamic `bytes` blob (standard Solidity ABI encoding rules for a `bytes[]` outer array) — but this was not independently stress-tested against raw calldata bytes in this research pass; verify with a concrete encoded example before relying on it.

### Gaps
- Did not pull `V2SwapRouter.sol`/`V3SwapRouter.sol`/`Dispatcher.sol` for the `UniversalRouterV2_1_1` address (`0x4C82D1fBFe28C977cBB58D8C7FF8FCF9F70a2cCA`) specifically via Sourcify — only via the `2.1.1` git tag (raw GitHub) — so the "6-field shape" claim for that specific address is confirmed via tag-matching (tag `2.1.1`'s `Commands.sol` byte-matches what Sourcify returned for the `2.1.2`-tagged *address*, and the repo's CHANGELOG/tag history strongly implies `2.1.1`'s deployed contract uses the same Dispatcher as `2.1.2`), not via a second independent Sourcify pull against that exact address. Treat the V2_1_1 claim as highly likely but one step less directly confirmed than the V2 and V2_1_2 claims.
- Did not verify whether `minHopPriceX36 = []` (empty array) is accepted/required when a caller wants to disable the per-hop price check — the `V2SwapRouter.sol` source does mention `if (minHopPriceX36.length != 0 && minHopPriceX36.length != path.length - 1) revert V2InvalidHopP...` (truncated in the fetched excerpt), implying an empty array disables the check, but the full revert-condition text and edge-case semantics were not fully captured — recommend re-fetching `contracts/modules/uniswap/v2/V2SwapRouter.sol` in full for the `2.1.2` deployed source before encoding exact validation logic against it in the Guard.

---

## Key Question 4: `commands` byte structure — 1-byte command ID + flag bit

### Takeaway
CONFIRMED (primary source: `Commands.sol`, raw GitHub source for multiple tags, cross-checked against Sourcify-matched deployed bytecode for both relevant mainnet addresses). Each entry in the `commands` bytes string is exactly 1 byte (`bytes1`). The top bit (`0x80`) is `FLAG_ALLOW_REVERT`; the remaining 7 bits (masked via `COMMAND_TYPE_MASK`) encode the command type. The mask's width differs by version.

### Cited Findings
- Exact quoted constants, `contracts/libraries/Commands.sol`:
  - Tags `v1.6.0` and `2.0.0` (and the deployed `0x66a9893cc07d91d95644aedd05d03f95e1dba8af`):
    ```solidity
    bytes1 internal constant FLAG_ALLOW_REVERT = 0x80;
    bytes1 internal constant COMMAND_TYPE_MASK = 0x3f;
    ```
  - Tags `2.1.1`, `2.1.2`, `2.2.0` (and the deployed `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`):
    ```solidity
    bytes1 internal constant FLAG_ALLOW_REVERT = 0x80;
    bytes1 internal constant COMMAND_TYPE_MASK = 0x7f;
    ```
  Source: raw GitHub fetches of `contracts/libraries/Commands.sol` at each tag, plus Sourcify `sources` payload for both deployed addresses.
- Usage in `Dispatcher.sol` (identical pattern across all versions checked): `uint256 command = uint8(commandType & Commands.COMMAND_TYPE_MASK);` — i.e., the command type is obtained by masking the full byte with `COMMAND_TYPE_MASK`, discarding the top bit(s) reserved for flags.
- Usage in `UniversalRouter.sol`'s `execute()` loop (identical across `v1.6.0` and the newest deployed `2.1.2` source): `function successRequired(bytes1 command) internal pure returns (bool) { return command & Commands.FLAG_ALLOW_REVERT == 0; }` — a command's execution failure only reverts the whole `execute()` call if its top bit (`0x80`) is **not** set; if set, a failing command is swallowed and execution continues to the next command.

### Inferences
- To set the "allow revert" flag for, e.g., `V2_SWAP_EXACT_IN` (`0x08`), the byte placed in the `commands` string would be `0x08 | 0x80 = 0x88`. A Guard decoding `commands` must always mask with the correct `COMMAND_TYPE_MASK` for the target router version (`0x3f` for `UniversalRouterV2`, `0x7f` for `V2_1_1`/`V2_1_2`) before comparing against a known command ID — comparing the raw unmasked byte against `0x08` would fail to recognize `0x88` (allow-revert V2 swap) as a V2 swap.
- Because masking only strips the top bit, a Guard whose job is "does this commands+inputs batch contain command X" can safely iterate `commands` byte-by-byte, mask each byte with `0x7f` (the superset mask, safe even for the `0x3f`-era router since real command IDs there never exceed `0x3f` anyway), and switch on the result — a single masking constant of `0x7f` is safe to use defensively across both known mask eras, since the `0x3f`-router's valid command IDs are all ≤ `0x22`, well within both masks' "command type" bit range.

### Gaps
- None of substance — directly confirmed from source across versions.

---

## Key Question 5: Native-ETH-input swaps — `msg.value` vs. `WRAP_ETH` command

### Takeaway
CONFIRMED (primary source: `Payments.sol`, `Dispatcher.sol`, `UniversalRouter.sol` raw GitHub source at `v1.6.0`, cross-checked conceptually against the newer deployed `Dispatcher.sol`'s identical `WRAP_ETH`/`UNWRAP_WETH` decode block). `execute()` is `payable`, so ETH is sent via `msg.value` on the top-level call; the router does **not** auto-wrap `msg.value` into WETH for a V2/V3 swap. Instead, an explicit `WRAP_ETH` command must be included earlier in the same `commands`/`inputs` batch, targeting the router's own balance as the source of ETH to wrap, using the `ADDRESS_THIS` (`address(2)`) sentinel as the "recipient" when the WETH should stay in the router for the swap to consume.

### Cited Findings
- `execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable checkDeadline(deadline)` and the inner `execute(bytes calldata commands, bytes[] calldata inputs) public payable override isNotLocked` — both marked `payable`, confirming ETH is sent as `msg.value` on the call itself. Source: `contracts/UniversalRouter.sol`, tag `v1.6.0`.
- `WRAP_ETH` dispatch (`Dispatcher.sol`, identical logic in both the `v1.6.0` and the newest deployed `2.1.2` source):
  ```solidity
  } else if (command == Commands.WRAP_ETH) {
      // equivalent: abi.decode(inputs, (address, uint256))
      address recipient;
      uint256 amountMin; // ("amount" in the 2.1.2-deployed source)
      assembly {
          recipient := calldataload(inputs.offset)
          amountMin := calldataload(add(inputs.offset, 0x20))
      }
      Payments.wrapETH(map(recipient), amountMin);
  }
  ```
  i.e. `WRAP_ETH`'s inputs are `(address recipient, uint256 amount)`.
- `Payments.wrapETH` implementation, `contracts/modules/Payments.sol`, tag `v1.6.0`:
  ```solidity
  function wrapETH(address recipient, uint256 amount) internal {
      if (amount == Constants.CONTRACT_BALANCE) {
          amount = address(this).balance;
      } else if (amount > address(this).balance) {
          revert InsufficientETH();
      }
      if (amount > 0) {
          WETH9.deposit{value: amount}();
          if (recipient != address(this)) {
              WETH9.transfer(recipient, amount);
          }
      }
  }
  ```
  This operates on `address(this).balance` — i.e., ETH that is **already sitting in the router's own balance** (put there by `msg.value` on the `execute()` call, or left over from a prior step) — not a value pulled from the caller directly at wrap time.
- The `Constants.sol` sentinel addresses used throughout the router for the `recipient`/`payer` fields (`contracts/libraries/Constants.sol`, tag `v1.6.0`):
  ```solidity
  address internal constant ETH = address(0);
  address internal constant MSG_SENDER = address(1);
  address internal constant ADDRESS_THIS = address(2);
  uint256 internal constant CONTRACT_BALANCE = 1 << 255; // 0x8000...000
  ```
  So to wrap "the router's own current ETH balance" and keep the resulting WETH in the router (so a subsequent `V2_SWAP_EXACT_IN`/`V3_SWAP_EXACT_IN` command can consume it), a typical encoded `WRAP_ETH` input is `(ADDRESS_THIS, CONTRACT_BALANCE)` i.e. `(address(2), 1<<255)` — `recipient = ADDRESS_THIS` keeps the WETH in the router rather than transferring it out, and `amount = CONTRACT_BALANCE` tells `wrapETH` to use the router's full current ETH balance rather than a fixed amount.
- `UniversalRouter.sol`'s `receive() external payable {}` (tag `v1.6.0`) / the newer deployed version's `receive()` which additionally checks `msg.sender == address(WETH9) || msg.sender == address(poolManager)` — confirms the router is designed to receive ETH both as `execute()`'s `msg.value` and as unwrap proceeds from WETH9/PoolManager mid-execution.

### Inferences
- End-to-end flow for "swap exact ETH in for TOKEN via V2" (inference built directly from the cited mechanics, matching the well-known pattern used by Uniswap's own SDK/front-end): caller sends `msg.value = amountIn` with the `execute()` call; `commands` bytes = `[WRAP_ETH, V2_SWAP_EXACT_IN]`; `WRAP_ETH`'s input = `(ADDRESS_THIS, amountIn or CONTRACT_BALANCE)` so the router wraps the ETH it just received into WETH held by itself; `V2_SWAP_EXACT_IN`'s input uses `path[0] = WETH9` and `payerIsUser = false` (so the Dispatcher resolves `payer = address(this)`, i.e. the router pays from its own WETH balance rather than trying to pull from the user via Permit2, since the user never approved WETH — they sent raw ETH).
- Conversely, swapping TOKEN for ETH out end-to-end: `commands = [V2_SWAP_EXACT_IN (path ending in WETH9, recipient=ADDRESS_THIS), UNWRAP_WETH (recipient=MSG_SENDER or the real recipient, amountMin=...)]` — the swap deposits WETH into the router, then `UNWRAP_WETH` converts it to ETH and sends it out. This mirrors `UNWRAP_WETH`'s decode shape `(address recipient, uint256 amountMin)` and `Payments.unwrapWETH9` logic (`WETH9.withdraw(value); if (recipient != address(this)) recipient.safeTransferETH(value);`).
- A Guard that wants to catch "attacker tries to move ETH out via a disguised swap" should treat a `WRAP_ETH`/`UNWRAP_WETH` command pair as a normal, expected part of any ETH-involved swap route (not inherently suspicious), but should still validate the `recipient` sentinel/amount and the surrounding swap commands' `path`/`amountOutMinimum` fields for its own policy.

### Gaps
- Did not locate or fetch an official Uniswap prose doc (e.g., an "Universal Router Technical Reference" guide on `docs.uniswap.org`/`developers.uniswap.org`) that spells out the ETH-in/ETH-out command sequencing as a worked example — the sequencing described above is reconstructed/inferred directly from the cited source code mechanics rather than quoted from an official walkthrough. Flagged as an inference, not a directly-quoted confirmed fact, per the instruction to separate the two.

---

## Key Question 6: Full `execute()` signature(s) and other top-level entry points

### Takeaway
CONFIRMED (primary source: `UniversalRouter.sol`, raw GitHub source at tag `v1.6.0`, AND independently re-confirmed against Sourcify-matched deployed source for both `0x66a9893cc07d91d95644aedd05d03f95e1dba8af` and `0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`). The answer **differs by deployed version**: the older `UniversalRouterV2` has exactly two execute-family entry points; the newer `V2_1_1`/`V2_1_2` deployments have a third one, `executeSigned`.

### Cited Findings
- On `UniversalRouterV2` (`0x66a9893cc07d91d95644aedd05d03f95e1dba8af`) and tag `v1.6.0`, `contracts/UniversalRouter.sol` defines exactly:
  ```solidity
  function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline)
      external
      payable
      checkDeadline(deadline)
  {
      execute(commands, inputs);
  }

  function execute(bytes calldata commands, bytes[] calldata inputs) public payable override isNotLocked {
      ... // loops commands, calls dispatch(), reverts via ExecutionFailed if a non-allow-revert command fails
  }
  ```
  No other external/public function in this file or in the inherited `Dispatcher`/`RewardsCollector` (per the `v1.6.0` source tree) exposes an alternate way to run swap commands — `execute()` (either arity) is the sole entry point for commands/inputs execution in this version.
- On `UniversalRouterV2_1_2` (`0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85`), the deployed, Sourcify-matched `contracts/UniversalRouter.sol` additionally defines:
  ```solidity
  function executeSigned(
      bytes calldata commands,
      bytes[] calldata inputs,
      bytes32 intent,
      bytes32 data,
      bool verifySender,
      bytes32 nonce,
      bytes calldata signature,
      uint256 deadline
  ) external payable checkDeadline(deadline) {
      _setSignatureContext(commands, inputs, intent, data, verifySender, nonce, signature, deadline);
      execute(commands, inputs);
      _resetSignatureContext();
  }
  ```
  — a third top-level entry point, layered on top of (and ultimately still calling) the same `execute(commands, inputs)` dispatch loop, but gated by an EIP-712-style signature/intent check (the contract inherits `RouteSigner` and constructs `EIP712('UniversalRouter', '2')`). There is also a public view function `signedRouteContext()` that exposes the currently-set signer/intent/data, and the contract inherits `ChainedActions` (constructed with a `spokePool` parameter, suggesting Across-protocol cross-chain intent integration, consistent with the `ACROSS_V4_DEPOSIT_V3` command seen in Q2).

### Inferences
- A Guard protecting a Safe that might interact with `UniversalRouterV2_1_1`/`V2_1_2` must also recognize and validate `executeSigned(...)` calls (function selector distinct from `execute(...)`), not just `execute(...)`, since `executeSigned` is a genuine alternate path into the same command-dispatch loop and therefore the same swap-execution surface. A Guard that only whitelists the `execute(bytes,bytes[],uint256)` / `execute(bytes,bytes[])` selectors against the newest router addresses would miss `executeSigned` calls entirely, which is exactly the kind of "silently pass through unchecked trades" risk the user flagged.
- Against the older `UniversalRouterV2` address specifically, `execute()` (either arity) is confirmed to be the only entry point, so a Guard scoped only to that address does not need to handle `executeSigned`.

### Gaps
- Did not fully decode the `ChainedActions`/`RouteSigner` modules' internal logic (e.g., exactly how `_setSignatureContext`/`verifySender`/`nonce` affect who is authorized to trigger `executeSigned`, or whether `executeSigned` can be invoked by an arbitrary caller relaying a pre-signed intent from someone else) — this matters for a Guard trying to attribute "who initiated this trade" when `executeSigned` is used, and should be researched separately (likely needs `RouteSigner.sol` and `ChainedActions.sol` full source, which were not fetched in this pass) before the Guard logic assumes `msg.sender`/Safe-owner semantics carry over unchanged to `executeSigned` calls.
