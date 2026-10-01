// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseGuard} from "safe-smart-account/contracts/examples/guards/BaseGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @title PancakeSwapLimitGuard
/// @notice A Safe Guard enforcing MyPropGuard risk rules (max amount spent per trade, max
/// trades/day) on PancakeSwap, on BSC - no matter which front-end submits the Safe
/// transaction. Covers the **V2 Router** and the **V3 routers** (original SwapRouter and
/// SwapRouter02). Does NOT cover PancakeSwap's Universal Router - see "Universal Router: explicitly
/// not covered" below for why that's a deliberate scope decision, not an oversight.
///
/// Named without "V2" (unlike the first version of this contract, PancakeSwapV2LimitGuard) because
/// a Safe can only have ONE Guard active at a time (`GuardManager.setGuard` is a single storage
/// slot) - V3 coverage had to be added to this same contract rather than live in a separate one
/// a Safe would have to choose between. Same change made in parallel to UniswapLimitGuard.sol.
///
/// ## Router registry, not a single `router` field
/// The earlier version of this Guard had one `router` address. Supporting V2 and two V3 router
/// generations - each with a different calldata shape - means
/// this Guard now tracks a small registry of recognized router addresses, each tagged with how
/// to decode calls to it (see `RouterKind`). Only MyPropGuard's admin can add/remove entries.
///
/// ## V3 decode scope and real risks found during research
/// Per research_notes/EVM on-chain trading risk enforcement/v3_and_universal_router_abi.md:
/// - The ORIGINAL SwapRouter's `ExactInputSingleParams`/`ExactInputParams` structs include a
///   `deadline` field; SwapRouter02's omit it entirely. Decoding one shape against the other's
///   calldata silently misaligns every field after `recipient` - this Guard picks the struct
///   shape from the registry entry for the called address, never assumes one global shape.
/// - `exactInputSingle`/`exactInput` can be called directly OR wrapped inside any of THREE
///   `multicall` overloads (`multicall(bytes[])`, `multicall(uint256,bytes[])`,
///   `multicall(bytes32,bytes[])`) - all three are decoded here.
/// - `exactInputSingle`/`exactInput` accept `amountIn == 0` as a sentinel meaning "spend this
///   contract's entire current token balance" - the real spend amount is NOT present in calldata
///   in that case. This Guard treats `amountIn == 0` as **always rejected** (reverts), rather
///   than silently treating it as "zero" and letting an arbitrary real amount through unchecked -
///   this is a deliberate fail-closed choice, not a limitation to work around later.
///
/// ## Universal Router: explicitly not covered
/// Research found PancakeSwap's Universal Router is not one stable ABI: at least two live mainnet
/// deployments decode the identical command IDs into DIFFERENT tuple shapes (a 5-field vs.
/// 6-field `V2_SWAP_EXACT_IN`/`V3_SWAP_EXACT_IN` input shape), the newer deployment has a THIRD
/// top-level entry point (`executeSigned`) whose authorization/attribution semantics were not
/// confirmed, and getting any of this wrong would mean this Guard either (a) misreads a real
/// trade's size, silently enforcing the wrong number, or (b) fails to recognize a genuine
/// swap-execution path at all, letting it through completely unchecked - either of which is
/// worse than plainly not claiming coverage. A trade routed through Universal Router is NOT
/// covered by this Guard until these gaps are closed (see packages/evm-guard/ROADMAP.md).
///
/// There is no "position size" or "leverage" concept in spot swaps - the two rules here are max
/// amount of a given input token spent in one trade, and max trades per day.
///
/// One Guard instance is meant to be shared across many Safes - `msg.sender` inside
/// checkTransaction/checkModuleTransaction is the calling Safe itself.
contract PancakeSwapLimitGuard is BaseGuard {
    enum RouterKind {
        None,
        V2,
        V3NoDeadline, // SwapRouter02-style: ExactInputSingleParams/ExactInputParams omit deadline
        V3WithDeadline // original SwapRouter-style: structs include a deadline field
    }

    /// @notice Which decode logic applies to each recognized router address. `RouterKind.None`
    /// (the default for any address never configured) means "not a router this Guard watches at
    /// all" - calls to it pass through untouched, same as any other unrelated contract.
    mapping(address => RouterKind) public routerKind;

    address public immutable admin;

    address public constant NATIVE_BNB = address(0);

    // --- V2-style selectors (unchanged from the original V2-only Guard) ---
    bytes4 private constant SWAP_EXACT_TOKENS_FOR_TOKENS =
        bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"));
    bytes4 private constant SWAP_EXACT_TOKENS_FOR_TOKENS_FEE =
        bytes4(keccak256("swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"));
    bytes4 private constant SWAP_EXACT_TOKENS_FOR_ETH =
        bytes4(keccak256("swapExactTokensForETH(uint256,uint256,address[],address,uint256)"));
    bytes4 private constant SWAP_EXACT_TOKENS_FOR_ETH_FEE =
        bytes4(keccak256("swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)"));
    bytes4 private constant SWAP_EXACT_ETH_FOR_TOKENS =
        bytes4(keccak256("swapExactETHForTokens(uint256,address[],address,uint256)"));
    bytes4 private constant SWAP_EXACT_ETH_FOR_TOKENS_FEE =
        bytes4(keccak256("swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)"));

    // --- V3-style selectors (both router generations share these names/selectors) ---
    bytes4 private constant EXACT_INPUT_SINGLE_NO_DEADLINE = bytes4(keccak256(
        "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"
    ));
    bytes4 private constant EXACT_INPUT_NO_DEADLINE =
        bytes4(keccak256("exactInput((bytes,address,uint256,uint256))"));
    bytes4 private constant EXACT_INPUT_SINGLE_WITH_DEADLINE = bytes4(keccak256(
        "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"
    ));
    bytes4 private constant EXACT_INPUT_WITH_DEADLINE =
        bytes4(keccak256("exactInput((bytes,address,uint256,uint256,uint256))"));
    bytes4 private constant MULTICALL_PLAIN = bytes4(keccak256("multicall(bytes[])"));
    bytes4 private constant MULTICALL_DEADLINE = bytes4(keccak256("multicall(uint256,bytes[])"));
    bytes4 private constant MULTICALL_PREV_BLOCKHASH = bytes4(keccak256("multicall(bytes32,bytes[])"));

    mapping(address => mapping(address => uint256)) public maxAmountPerTrade;
    mapping(address => uint256) public maxTradesPerDay;

    struct AccountState {
        uint256 lastTradeDay;
        uint256 tradesToday;
    }

    mapping(address => AccountState) public tradeState;

    /// @notice The UTC day (block.timestamp / 1 days) through which an account is frozen, set by
    /// MyPropGuard's backend when it detects (off-chain - see packages/risk-ledger's
    /// checkAndEnforceDailyLossFreeze) that the account has breached its max-daily-loss rule.
    /// Realized P&L across multiple trades isn't derivable from a single transaction's calldata,
    /// so the backend's admin key is still the one that tells this contract a breach happened -
    /// that trust is unavoidable without a full on-chain accounting system. What IS enforced
    /// on-chain, with no admin override possible: once recorded, the freeze cannot be lifted early
    /// by anyone, including the admin - there is no function anywhere that clears this early. It
    /// expires automatically the moment `block.timestamp / 1 days` advances past the stored day,
    /// with zero transactions needed from anyone. A frozen account can still move its own funds
    /// through anything this Guard doesn't track as a router - only further trades are blocked.
    mapping(address => uint256) public frozenThroughDay;

    event RouterConfigured(address indexed router, RouterKind kind);
    event TokenLimitSet(address indexed account, address indexed token, uint256 maxAmountPerTrade);
    event TradeCountLimitSet(address indexed account, uint256 maxTradesPerDay);
    event SwapChecked(address indexed account, address indexed token, uint256 amount, uint256 tradesToday);
    event DailyLossBreachRecorded(address indexed account, uint256 day);

    error NotAdmin();
    error LimitsNotConfigured(address account);
    error AccountIsFrozen(address account);
    error TradeAmountExceeded(address token, uint256 requested, uint256 max);
    error TradeCountExceeded(uint256 attempted, uint256 max);
    error DelegateCallNotAllowed();
    error ZeroAmountInNotAllowed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @param _admin MyPropGuard's backend/admin key - the only address that can configure
    /// routers or limits.
    /// @param _v2Router PancakeSwap V2 Router address, registered as `RouterKind.V2` immediately so
    /// existing V2-only deployments of this Guard keep working with zero extra setup.
    constructor(address _admin, address _v2Router) {
        admin = _admin;
        routerKind[_v2Router] = RouterKind.V2;
        emit RouterConfigured(_v2Router, RouterKind.V2);
    }

    /// @notice Adds, updates, or removes (pass `RouterKind.None`) a recognized router address.
    /// Only MyPropGuard's admin key can call this - never the trader.
    function setRouterKind(address routerAddress, RouterKind kind) external onlyAdmin {
        routerKind[routerAddress] = kind;
        emit RouterConfigured(routerAddress, kind);
    }

    function setTokenLimit(address account, address token, uint256 amount) external onlyAdmin {
        maxAmountPerTrade[account][token] = amount;
        emit TokenLimitSet(account, token, amount);
    }

    function setMaxTradesPerDay(address account, uint256 limit) external onlyAdmin {
        maxTradesPerDay[account] = limit;
        emit TradeCountLimitSet(account, limit);
    }

    /// @notice Records that an account has breached its max-daily-loss rule today, freezing it
    /// through the end of the current UTC day. Admin-only, but deliberately one-directional and
    /// idempotent: this can only ever set the frozen day to the CURRENT day, never clear it, never
    /// extend it into the future, and never target a day that has already passed. There is no
    /// function on this contract, callable by anyone, that lifts a freeze before the day rolls
    /// over on its own.
    function recordDailyLossBreach(address account) external onlyAdmin {
        uint256 today = block.timestamp / 1 days;
        frozenThroughDay[account] = today;
        emit DailyLossBreachRecorded(account, today);
    }

    function checkTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes memory,
        address
    ) external override {
        _enforce(msg.sender, to, value, data, operation);
    }

    function checkAfterExecution(bytes32, bool) external override {}

    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes memory data,
        Enum.Operation operation,
        address
    ) external override returns (bytes32) {
        _enforce(msg.sender, to, value, data, operation);
        return bytes32(0);
    }

    function checkAfterModuleExecution(bytes32, bool) external override {}

    function _enforce(address account, address to, uint256 value, bytes memory data, Enum.Operation operation) private {
        RouterKind kind = routerKind[to];
        if (kind == RouterKind.None) return;
        if (operation == Enum.Operation.DelegateCall) revert DelegateCallNotAllowed();
        if (frozenThroughDay[account] == block.timestamp / 1 days) revert AccountIsFrozen(account);

        uint256 tradeLimit = maxTradesPerDay[account];
        if (tradeLimit == 0) revert LimitsNotConfigured(account);

        if (kind == RouterKind.V2) {
            _enforceV2(account, value, data, tradeLimit);
        } else {
            _enforceV3(account, data, tradeLimit, kind);
        }
    }

    function _enforceV2(address account, uint256 value, bytes memory data, uint256 tradeLimit) private {
        (address inputToken, uint256 inputAmount, bool isSwap) = _decodeV2Swap(data, value);
        if (!isSwap) return;
        _checkAndRecord(account, inputToken, inputAmount, tradeLimit);
    }

    /// @dev Handles both direct exactInputSingle/exactInput calls and the same wrapped inside
    /// any of the three multicall overloads. Only one level of multicall unwrapping - V3
    /// routers don't nest multicalls within multicalls.
    function _enforceV3(address account, bytes memory data, uint256 tradeLimit, RouterKind kind) private {
        if (data.length < 4) return;
        bytes4 sel = _selector(data);

        if (sel == MULTICALL_PLAIN) {
            bytes[] memory calls = abi.decode(_stripSelector(data), (bytes[]));
            _enforceV3Batch(account, calls, tradeLimit, kind);
            return;
        }
        if (sel == MULTICALL_DEADLINE) {
            (, bytes[] memory calls) = abi.decode(_stripSelector(data), (uint256, bytes[]));
            _enforceV3Batch(account, calls, tradeLimit, kind);
            return;
        }
        if (sel == MULTICALL_PREV_BLOCKHASH) {
            (, bytes[] memory calls) = abi.decode(_stripSelector(data), (bytes32, bytes[]));
            _enforceV3Batch(account, calls, tradeLimit, kind);
            return;
        }

        (address inputToken, uint256 inputAmount, bool isSwap) = _decodeV3Swap(sel, data, kind);
        if (!isSwap) return;
        _checkAndRecord(account, inputToken, inputAmount, tradeLimit);
    }

    function _enforceV3Batch(address account, bytes[] memory calls, uint256 tradeLimit, RouterKind kind) private {
        for (uint256 i = 0; i < calls.length; i++) {
            bytes memory inner = calls[i];
            if (inner.length < 4) continue;
            bytes4 innerSel = _selector(inner);
            (address inputToken, uint256 inputAmount, bool isSwap) = _decodeV3Swap(innerSel, inner, kind);
            if (!isSwap) continue;
            _checkAndRecord(account, inputToken, inputAmount, tradeLimit);
        }
    }

    function _checkAndRecord(address account, address inputToken, uint256 inputAmount, uint256 tradeLimit) private {
        uint256 tokenLimit = maxAmountPerTrade[account][inputToken];
        if (tokenLimit != 0 && inputAmount > tokenLimit) {
            revert TradeAmountExceeded(inputToken, inputAmount, tokenLimit);
        }

        uint256 today = block.timestamp / 1 days;
        AccountState memory existing = tradeState[account];
        uint256 tradesToday = (existing.lastTradeDay == today ? existing.tradesToday : 0) + 1;

        if (tradesToday > tradeLimit) {
            revert TradeCountExceeded(tradesToday, tradeLimit);
        }

        tradeState[account] = AccountState(today, tradesToday);
        emit SwapChecked(account, inputToken, inputAmount, tradesToday);
    }

    function _decodeV2Swap(bytes memory data, uint256 value) private pure returns (address, uint256, bool) {
        if (data.length < 4) return (address(0), 0, false);
        bytes4 sel = _selector(data);

        if (
            sel == SWAP_EXACT_TOKENS_FOR_TOKENS || sel == SWAP_EXACT_TOKENS_FOR_TOKENS_FEE || sel == SWAP_EXACT_TOKENS_FOR_ETH
                || sel == SWAP_EXACT_TOKENS_FOR_ETH_FEE
        ) {
            (uint256 amountIn,, address[] memory path,,) =
                abi.decode(_stripSelector(data), (uint256, uint256, address[], address, uint256));
            return (path[0], amountIn, true);
        }

        if (sel == SWAP_EXACT_ETH_FOR_TOKENS || sel == SWAP_EXACT_ETH_FOR_TOKENS_FEE) {
            return (NATIVE_BNB, value, true);
        }

        return (address(0), 0, false);
    }

    /// @dev `amountIn == 0` is GMX/PancakeSwap's "spend my whole balance" sentinel for these V3
    /// functions - the real amount isn't in calldata, so this reverts rather than silently
    /// mis-checking it as a zero-value trade. See the contract-level NatSpec.
    function _decodeV3Swap(bytes4 sel, bytes memory data, RouterKind kind) private pure returns (address, uint256, bool) {
        bool noDeadline = kind == RouterKind.V3NoDeadline;

        if (sel == EXACT_INPUT_SINGLE_NO_DEADLINE && noDeadline) {
            (address tokenIn,,, , uint256 amountIn,,) =
                abi.decode(_stripSelector(data), (address, address, uint24, address, uint256, uint256, uint160));
            if (amountIn == 0) revert ZeroAmountInNotAllowed();
            return (tokenIn, amountIn, true);
        }
        if (sel == EXACT_INPUT_SINGLE_WITH_DEADLINE && !noDeadline) {
            (address tokenIn,,, , uint256 deadline, uint256 amountIn,,) = abi.decode(
                _stripSelector(data), (address, address, uint24, address, uint256, uint256, uint256, uint160)
            );
            deadline; // unused - present only to preserve struct field alignment
            if (amountIn == 0) revert ZeroAmountInNotAllowed();
            return (tokenIn, amountIn, true);
        }
        if (sel == EXACT_INPUT_NO_DEADLINE && noDeadline) {
            (bytes memory path,, uint256 amountIn,) = abi.decode(_stripSelector(data), (bytes, address, uint256, uint256));
            if (amountIn == 0) revert ZeroAmountInNotAllowed();
            return (_firstTokenFromPath(path), amountIn, true);
        }
        if (sel == EXACT_INPUT_WITH_DEADLINE && !noDeadline) {
            (bytes memory path,,, uint256 amountIn,) =
                abi.decode(_stripSelector(data), (bytes, address, uint256, uint256, uint256));
            if (amountIn == 0) revert ZeroAmountInNotAllowed();
            return (_firstTokenFromPath(path), amountIn, true);
        }

        return (address(0), 0, false);
    }

    /// @dev V3's packed path encoding is `token(20B) | fee(3B) | token(20B) | fee(3B) | ...` -
    /// the input token is always the first 20 bytes.
    function _firstTokenFromPath(bytes memory path) private pure returns (address token) {
        require(path.length >= 20, "PancakeSwapLimitGuard: path too short");
        assembly {
            token := shr(96, mload(add(path, 32)))
        }
    }

    function _selector(bytes memory data) private pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(data, 32))
        }
    }

    function _stripSelector(bytes memory data) private pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i + 4];
        }
    }
}
