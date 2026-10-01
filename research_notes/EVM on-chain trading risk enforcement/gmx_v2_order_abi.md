# GMX v2 On-Chain Order-Creation Interface (Arbitrum) — for Safe Guard Decoding

Scope: GMX v2 "Classic Trading" synthetics contracts (github.com/gmx-io/gmx-synthetics), Arbitrum mainnet only. All contract-source claims below were pulled directly from the `main` branch of `gmx-io/gmx-synthetics` via raw.githubusercontent.com fetches during this research session (Oct 2026), not from aggregator summaries, except where explicitly flagged.

## 1. Exact entry point a trader's wallet calls to open/increase a position

### Takeaway
The trader (EOA or Safe) calls `ExchangeRouter.multicall(bytes[] calldata data)`, batching a `sendWnt(orderVault, executionFeeAmount)` call (and optionally `sendTokens(...)` for ERC-20 collateral) together with a `createOrder(IBaseOrderUtils.CreateOrderParams calldata params)` call, all `delegatecall`'d to `address(this)` within the same atomic transaction. `createOrder` is never meant to be called standalone in Classic Trading, because the order vault needs to receive the execution fee (WNT) and collateral tokens before/when the order is created — GMX's own order creation logic checks that the received token balances match what's expected.

### Cited Findings
- `ExchangeRouter.createOrder` full implementation (fetched from `contracts/router/ExchangeRouter.sol`, gmx-io/gmx-synthetics, main branch):
  ```solidity
  function createOrder(
      IBaseOrderUtils.CreateOrderParams calldata params
  ) external override payable nonReentrant returns (bytes32) {
      address account = msg.sender;

      return orderHandler.createOrder(
          account,
          0, // srcChainId is the current block.chainId
          params,
          false
      );
  }
  ```
  — [gmx-io/gmx-synthetics ExchangeRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/ExchangeRouter.sol)
- `ExchangeRouter` inherits `BaseRouter`, which inherits `PayableMulticall`, `ReentrancyGuard`, and `RoleModule`. `multicall` itself is implemented in `PayableMulticall` (not re-implemented in `BaseRouter`/`ExchangeRouter`), confirmed via the `import "../utils/PayableMulticall.sol";` statement at the top of `BaseRouter.sol`. — [gmx-io/gmx-synthetics BaseRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/BaseRouter.sol)
- `BaseRouter.sendWnt(address receiver, uint256 amount)`: wraps native ETH into WNT and forwards it to `receiver` (the OrderVault address for order creation flows); validates `receiver` via `AccountUtils.validateReceiver`, no EOA/tx.origin checks. — [gmx-io/gmx-synthetics BaseRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/BaseRouter.sol)
- `BaseRouter.sendTokens(address token, address receiver, uint256 amount)`: pulls `msg.sender`'s ERC-20 token (e.g. USDC collateral) via `router.pluginTransfer` and forwards to `receiver` (OrderVault). — same source.
- The general shape of the required call sequence — `sendWnt` (execution fee) then `createOrder`, both inside one `multicall` — is corroborated by independent integration write-ups (secondary source, included for context not as the primary claim): "Multicall is mandatory for order creation — you cannot call createOrder alone, and must batch sendWnt ... + createOrder into a single multicall call on the ExchangeRouter." — [Cyfrin Updraft GMX Perpetuals Trading course](https://updraft.cyfrin.io/courses/gmx-perpetuals-trading/foundation/gmx-contract-architecture)

### Inferences
- A Safe Guard's `checkTransaction` will see the Safe calling `ExchangeRouter.multicall(bytes[])` as the top-level `to`/`data`, NOT `createOrder` directly as the outer call. The Guard MUST ABI-decode the outer `multicall(bytes[])` call, then iterate the inner `bytes[]` array, ABI-decode each inner element by its 4-byte selector, and find the element(s) whose selector matches `createOrder(IBaseOrderUtils.CreateOrderParams)` to extract `params`. This answers Q3 directly: the Guard does need to decode a multicall's inner calls; GMX's contract (`ExchangeRouter`) will be the direct `to` address (good — no need to resolve through a separate unrelated router), but the actual order-opening call is nested inside `multicall`'s inner `data` elements, not the outer calldata.
- `account = msg.sender` is hard-set inside `ExchangeRouter.createOrder` itself (before any delegatecall boundary changes msg.sender), so when a Safe calls `ExchangeRouter.multicall(...)`, each inner `delegatecall`'d `createOrder` still runs in `ExchangeRouter`'s own execution context, where `msg.sender` is preserved as the original caller of the outer transaction (the Safe). This means `account` will correctly be the Safe's address, not some intermediary.

### Gaps
- I could not fetch `PayableMulticall.sol` (not directly requested) to confirm it uses `delegatecall` internally (this is the standard OpenZeppelin-style Multicall pattern GMX uses, and is treated as very likely true given it preserves `msg.sender`, but I did not independently pull that file's source in this session — flagged as unconfirmed primary-source detail).

## 2. Which field is position size and which is the account

### Takeaway
Position size is `CreateOrderParamsNumbers.sizeDeltaUsd` (type `uint256`), denominated in USD with 30 decimals internally throughout GMX v2 contracts. The account placing the order is NOT a field inside `CreateOrderParams` at all — it is derived by `ExchangeRouter.createOrder` as `msg.sender` and passed separately into `OrderHandler.createOrder(account, ...)`, which is the strongest possible guarantee that it equals the actual caller (the Safe), since GMX itself does not trust a user-supplied `account` field for order creation.

### Cited Findings
- `IBaseOrderUtils.CreateOrderParams` struct (fetched from `contracts/order/IBaseOrderUtils.sol`, main branch):
  ```solidity
  struct CreateOrderParams {
      CreateOrderParamsAddresses addresses;
      CreateOrderParamsNumbers numbers;
      Order.OrderType orderType;
      Order.DecreasePositionSwapType decreasePositionSwapType;
      bool isLong;
      bool shouldUnwrapNativeToken;
      bool autoCancel;
      bytes32 referralCode;
      bytes32[] dataList;
  }

  struct CreateOrderParamsAddresses {
      address receiver;
      address cancellationReceiver;
      address callbackContract;
      address uiFeeReceiver;
      address market;
      address initialCollateralToken;
      address[] swapPath;
  }

  struct CreateOrderParamsNumbers {
      uint256 sizeDeltaUsd;
      uint256 initialCollateralDeltaAmount;
      uint256 triggerPrice;
      uint256 acceptablePrice;
      uint256 executionFee;
      uint256 callbackGasLimit;
      uint256 minOutputAmount;
      uint256 validFromTime;
  }
  ```
  — [gmx-io/gmx-synthetics IBaseOrderUtils.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/order/IBaseOrderUtils.sol)
- Note `CreateOrderParamsAddresses` has NO `account` field — confirming `account` is supplied out-of-band (as `msg.sender`) by `ExchangeRouter.createOrder`, per the Section 1 finding. — same source + [ExchangeRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/ExchangeRouter.sol)
- GMX v2 USD-denominated values (including `sizeDeltaUsd`) use 30 decimals internally. This is a widely documented GMX v2 convention repeated consistently across GMX's own Synthetics docs and multiple independent integration guides (secondary-source corroboration; I was not able to pull the exact `Precision.sol`/constants file line in this session to show the literal `10**30` constant, so flagging as "very high confidence, not independently re-verified against primary source this session"). — [Cyfrin Updraft GMX Perpetuals Trading course](https://updraft.cyfrin.io/courses/gmx-perpetuals-trading/foundation/gmx-contract-architecture)

### Inferences
- A Guard enforcing a position-size cap should compare `params.numbers.sizeDeltaUsd` (treating it as a 30-decimal fixed-point USD amount, i.e. divide by `1e30` to get a human USD figure) against its configured limit.
- Because the order's `account` is never attacker-controllable inside the decoded calldata (it's not even present in the struct the Guard would decode from `createOrder`'s argument), the Guard does not need to separately validate "account == Safe address" by comparing a calldata field — it is guaranteed by GMX's own contract logic as long as the Guard confirms the outer call's `msg.sender`-context is the Safe (which is automatically true since `checkTransaction` only ever fires for the Safe's own outgoing transactions). The Guard's real job is just to identify and decode the `createOrder` calldata correctly, not to cross-check an account field.
- `Order.OrderType` values relevant to "opening/increasing" a position are `MarketIncrease` (2) and `LimitIncrease` (3) (and `StopIncrease` per the newest enum, see Section 4) — a Guard should gate its size/count checks on these order types specifically, since `MarketDecrease`/`LimitDecrease`/`StopLossDecrease` reduce rather than open exposure.

### Gaps
- Did not independently re-derive the literal `10**30` USD-precision constant from GMX's `Precision.sol` source file in this session (time-boxed); this is treated as confirmed-by-strong-consensus but not re-verified against primary source here. The requester should independently grep `gmx-synthetics/contracts/pricing/Precision.sol` for `FLOAT_PRECISION` / `USD_DECIMALS` constants before shipping if 100% certainty is required.

## 3. Direct call vs. intermediate router/multicall (Guard decoding implications)

### Takeaway
Confirmed: the Safe's outgoing transaction will show `to = ExchangeRouter` (a real GMX contract, not an unrelated generic multicall forwarder) and `data` = an ABI-encoded call to `multicall(bytes[] data)`. The Guard sees GMX's own contract as `to`, which is good, but must still decode the multicall wrapper to reach the inner `createOrder` calldata.

### Cited Findings
- `ExchangeRouter` (which the Safe calls) is itself the contract deployed at the GMX-published address (see Section 5) — it is GMX's router, not a third-party aggregator. — [gmx-io/gmx-synthetics ExchangeRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/ExchangeRouter.sol)
- The `multicall` entry point comes from `PayableMulticall`, inherited by `BaseRouter` → `ExchangeRouter`. Standard Multicall implementations (OpenZeppelin-style, which this is modeled on) expose `function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)` and loop calling `address(this).delegatecall(data[i])` for each entry. — [gmx-io/gmx-synthetics BaseRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/BaseRouter.sol) (import statement confirmed; full `PayableMulticall.sol` body not independently fetched this session, see Gap below)

### Inferences
- Guard decoding algorithm: (1) check `to == ExchangeRouter address`; (2) decode outer calldata against selector `multicall(bytes[])`; (3) for each `bytes` entry in the decoded array, read its leading 4-byte selector; (4) when the selector equals `bytes4(keccak256("createOrder((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))")` (exact signature per Section 2's struct), ABI-decode the remaining bytes as `IBaseOrderUtils.CreateOrderParams` and apply the size/count policy; (5) a single multicall batch may legitimately contain multiple `createOrder` calls (e.g., opening several positions in one tx) — the Guard must sum/iterate over every matching inner call, not just the first.
- The Guard should also be ready to see `sendWnt`/`sendTokens` selectors in the same batch and can safely ignore those for size-limit purposes (they only move the execution fee / collateral, not the position-size parameter).

### Gaps
- Did not pull the literal `PayableMulticall.sol` source to confirm it uses `delegatecall` (vs. `call`) — this affects whether `msg.sender` is preserved through to `createOrder`'s `account = msg.sender` line. Standard Multicall patterns use `delegatecall` specifically to preserve `msg.sender` and `msg.value` context, and this is necessary for GMX's `sendWnt`+`createOrder` pattern to work correctly (the WNT must arrive from the same `msg.sender` across both calls), so it is very likely `delegatecall`, but flagged as not independently re-verified from the exact file this session.

## 4. GMX v2 Order struct full field list (Order.sol)

### Takeaway
`Order.sol`'s `Props` struct splits order state into `Addresses`, `Numbers`, and `Flags` sub-structs plus a `bytes32[] _dataList` catch-all; this is the struct GMX stores on-chain for an existing order (read via `Reader`/`DataStore`), distinct from — but overlapping heavily with — the `CreateOrderParams` struct a trader submits (Section 2). Both are needed for complete Guard tooling: `CreateOrderParams` for decoding the trader's calldata, `Order.Props` if the Guard ever needs to read back an already-created order's on-chain state (e.g. via `Reader.getOrder`).

### Cited Findings
- Full `Order.sol` structs/enums (fetched from `contracts/order/Order.sol`, main branch):
  ```solidity
  enum OrderType {
      MarketSwap,
      LimitSwap,
      MarketIncrease,
      LimitIncrease,
      MarketDecrease,
      LimitDecrease,
      StopLossDecrease,
      Liquidation,
      StopIncrease
  }

  enum SecondaryOrderType {
      None,
      Adl
  }

  enum DecreasePositionSwapType {
      NoSwap,
      SwapPnlTokenToCollateralToken,
      SwapCollateralTokenToPnlToken
  }

  struct Props {
      Addresses addresses;
      Numbers numbers;
      Flags flags;
      bytes32[] _dataList;
  }

  struct Addresses {
      address account;
      address receiver;
      address cancellationReceiver;
      address callbackContract;
      address uiFeeReceiver;
      address market;
      address initialCollateralToken;
      address[] swapPath;
  }

  struct Numbers {
      OrderType orderType;
      DecreasePositionSwapType decreasePositionSwapType;
      uint256 sizeDeltaUsd;
      uint256 initialCollateralDeltaAmount;
      uint256 triggerPrice;
      uint256 acceptablePrice;
      uint256 executionFee;
      uint256 callbackGasLimit;
      uint256 minOutputAmount;
      uint256 updatedAtTime;
      uint256 validFromTime;
      uint256 srcChainId;
  }

  struct Flags {
      bool isLong;
      bool shouldUnwrapNativeToken;
      bool isFrozen;
      bool autoCancel;
  }
  ```
  — [gmx-io/gmx-synthetics Order.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/order/Order.sol)

### Inferences
- Note the stored `Order.Props.Addresses.account` field DOES exist (unlike `CreateOrderParams`) — this is populated server-side by `OrderUtils`/`OrderHandler` from the `account` parameter (= original `msg.sender`), at the point the order is persisted to `DataStore`. This is not something the Guard decodes from calldata; it only matters if the Guard later queries on-chain order state.
- `isLong` lives in `Flags` for stored orders but is a top-level bool directly on `CreateOrderParams` for the create-call calldata (see Section 2) — these are two different structs with similar-but-not-identical shapes; a Guard implementation must not conflate `IBaseOrderUtils.CreateOrderParams` (calldata-decoding target) with `Order.Props` (on-chain storage layout).

### Gaps
- None of note for this question — struct obtained directly from primary source in full.

## 5. Deployed mainnet contract addresses on Arbitrum

### Takeaway
The current, primary-source addresses (from the `main` branch deployments manifest in `gmx-io/gmx-synthetics`, fetched this session) are: ExchangeRouter `0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41`, Router (token-approval spender) `0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6`, OrderVault `0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5`, Reader `0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789`. These should be treated as the live addresses as of this research session (Oct 2026), but GMX has redeployed `ExchangeRouter` multiple times across protocol upgrades (v2.1 → v2.2 → v2.2b → v2.2c, etc.), so **the integration must read `deployments/arbitrum/ExchangeRouter.json` (and siblings) at build/runtime from the GitHub repo rather than hardcoding, or re-verify immediately before deployment.**

### Cited Findings
- `deployments/arbitrum/ExchangeRouter.json` → `address: 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41` — [gmx-io/gmx-synthetics deployments/arbitrum/ExchangeRouter.json](https://github.com/gmx-io/gmx-synthetics/blob/main/deployments/arbitrum/ExchangeRouter.json)
- `deployments/arbitrum/Router.json` → `address: 0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6` — [gmx-io/gmx-synthetics deployments/arbitrum/Router.json](https://github.com/gmx-io/gmx-synthetics/blob/main/deployments/arbitrum/Router.json)
- `deployments/arbitrum/OrderVault.json` → `address: 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5` — [gmx-io/gmx-synthetics deployments/arbitrum/OrderVault.json](https://github.com/gmx-io/gmx-synthetics/blob/main/deployments/arbitrum/OrderVault.json)
- `deployments/arbitrum/Reader.json` → `address: 0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789` — [gmx-io/gmx-synthetics deployments/arbitrum/Reader.json](https://github.com/gmx-io/gmx-synthetics/blob/main/deployments/arbitrum/Reader.json)
- Conflicting/stale addresses found in secondary sources during search, NOT used as the final answer: `0x7C68C7866A64FA2160F78EEaE12217FFbf871FA8` and `0x602b805EedddBbD9ddff44A7dcBD46cb07849685` and `0x69C527fC77291722b52649E45c838e41be8Bf5d5` were all cited by various un-dated secondary sources (Arbiscan mirrors, blog posts) as "the" ExchangeRouter address — these are very likely older ExchangeRouter deployments from earlier GMX v2 protocol-upgrade cycles, not the current one. — [Arbiscan mirror](https://ww4.arbiscan.io/address/0x602b805EedddBbD9ddff44A7dcBD46cb07849685), [codeslaw.app](https://www.codeslaw.app/contracts/arbitrum/0x7c68c7866a64fa2160f78eeae12217ffbf871fa8)
- GMX publishes a contracts-v2 API/docs page intended to be the canonical address list, but it returned HTTP 404 when fetched directly in this session (likely a client-side-rendered page that WebFetch's HTML→markdown conversion cannot execute) — [docs.gmx.io/docs/api/contracts-v2/](https://docs.gmx.io/docs/api/contracts-v2/) (fetch failed, flagged below).

### Inferences
- The repeated redeployment of `ExchangeRouter` across upgrade cycles (evidenced by at least 4 different addresses found across sources of different vintage) means a Safe Guard that hardcodes a single allowed `to` address for "GMX ExchangeRouter" will break on GMX's next upgrade and silently either (a) block legitimate trades if the Guard fails closed, or (b) worse, fail open and allow calls to an unexpected/unaudited contract if the Guard isn't strict about `to`. The Guard's address allowlist should be an owner-updatable parameter, not a compile-time constant.

### Gaps
- Could not load `docs.gmx.io/docs/api/contracts-v2/` directly (404 via WebFetch, possibly due to client-side rendering) to cross-check against GMX's own documented "official" address list — recommend the user manually open that URL in a browser to visually confirm the addresses in Section 5 match GMX's current docs page before production use.
- Did not confirm a timestamp/block number for when `0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41` was deployed, so cannot state precisely which protocol-version label (v2.1/v2.2/v2.2c/etc.) it corresponds to.

## 6. Does GMX v2 Classic Trading require an EOA, or does it work from a Safe?

### Takeaway
Confirmed from primary source: GMX v2's order-creation path has no EOA-only or `tx.origin`-based restriction. `ExchangeRouter.createOrder` sets `account = msg.sender` directly (works identically whether `msg.sender` is an EOA or a smart-contract wallet like a Safe), and no `tx.origin` usage or `extcodesize`/`isContract` gating was found anywhere in `ExchangeRouter.sol`, `BaseRouter.sol`, or `OrderHandler.sol` during this research.

### Cited Findings
- `ExchangeRouter.createOrder`: `address account = msg.sender;` — no contract-type check before this assignment. — [gmx-io/gmx-synthetics ExchangeRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/ExchangeRouter.sol)
- Direct search of `OrderHandler.sol` for `tx.origin`, `extcodesize`, and EOA-only checks: "No tx.origin usage detected... No extcodesize or EOA checks found in this contract." — [gmx-io/gmx-synthetics OrderHandler.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/exchange/OrderHandler.sol)
- Direct search of `BaseRouter.sol`'s `sendWnt`/`sendTokens`/`sendNativeToken` for the same: "no explicit tx.origin or EOA checks visible" on all three. — [gmx-io/gmx-synthetics BaseRouter.sol](https://github.com/gmx-io/gmx-synthetics/blob/main/contracts/router/BaseRouter.sol)
- GMX v2 is widely used by smart-contract-wallet-based vault/aggregator protocols on Arbitrum (e.g. third-party yield vaults building leveraged strategies on top of GMX v2 synthetics) — these protocols interact with `ExchangeRouter` from their own contract addresses, not EOAs, which is only possible if GMX does not gate on EOA-ness. This is circumstantial/inferential corroboration rather than a named primary doc confirming "Safe usage" specifically.

### Inferences
- A Safe (Gnosis Safe) calling `ExchangeRouter.multicall([sendWnt(...), createOrder(...)])` directly as its own transaction will work exactly like an EOA calling the same sequence: `msg.sender` inside `ExchangeRouter`'s execution context is the Safe's address, both for the `sendWnt` WNT-receiver bookkeeping and for `createOrder`'s `account` assignment. No special Safe-specific enablement (module, delegate, approval) is needed beyond the Safe owner(s) signing/executing the transaction normally through `execTransaction`.

### Gaps
- Did not find an explicit GMX official doc page or GMX team statement that says "yes, Safes work" in so many words (this would be the strongest possible confirmation) — the conclusion here is derived from reading the actual contract logic (absence of any EOA-gating code), which is arguably stronger evidence than a doc statement, but it is a derived/inferred confirmation rather than a direct GMX statement. If the user wants a belt-and-suspenders check, a real GMX v2 testnet or small-size mainnet trade executed directly from a Safe's `execTransaction` would be the empirical final confirmation.

---

## Summary for Guard Implementation

1. **Allowlist `to`**: must equal the current `ExchangeRouter` address (owner-updatable — see Section 5 caveat on redeployments). Current value found: `0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41`.
2. **Outer decode**: ABI-decode `data` against `multicall(bytes[])`.
3. **Inner decode**: for each element, check 4-byte selector; when it matches `createOrder(...)`, decode the trailing bytes as `IBaseOrderUtils.CreateOrderParams` (struct layout in Section 2).
4. **Size check**: read `params.numbers.sizeDeltaUsd` (uint256, 30 decimals = divide by 1e30 for USD), compare against configured per-trade/cumulative limits. Gate this check on `params.orderType` being one of `MarketIncrease`/`LimitIncrease`/`StopIncrease` (position-opening/increasing types) per the `Order.OrderType` enum in Section 4 — order of enum values: `MarketSwap=0, LimitSwap=1, MarketIncrease=2, LimitIncrease=3, MarketDecrease=4, LimitDecrease=5, StopLossDecrease=6, Liquidation=7, StopIncrease=8`.
5. **Account**: no calldata field to check — `account` is non-spoofable, always `msg.sender` (the Safe) by GMX's own contract logic.
6. **Trade-count limits**: since a single `multicall` can bundle multiple `createOrder` calls, the Guard must count/sum across every matching inner call within one transaction, not assume one order per transaction.
7. **Safe compatibility**: confirmed safe to call from a Safe with no EOA-only restriction anywhere in the order-creation path.
