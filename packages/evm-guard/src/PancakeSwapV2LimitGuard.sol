// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseGuard} from "safe-smart-account/contracts/examples/guards/BaseGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @title PancakeSwapV2LimitGuard
/// @notice A Safe Guard enforcing MyPropGuard risk rules (max amount spent per trade, max
/// trades/day) on PancakeSwap's V2 Router, on BSC - no matter which front-end submits the Safe
/// transaction (pancakeswap.finance itself, PooCoin, a bot, MetaMask). A trade that breaks the
/// configured limits reverts on-chain and never reaches PancakeSwap at all.
///
/// Scope (v1, per MyPropGuard's EVM expansion plan): only PancakeSwap's **V2 Router**
/// (`0x10ED43C718714eb63d5aA57B78B54704E256024E` as of Oct 2026 - admin-updatable, see
/// `setRouter`) is covered. PancakeSwap also has a V3 SmartRouter and a Universal Router, both
/// of which optionally wrap swaps inside a `multicall`/`execute` batch with a more complex
/// decode shape (see research_notes/EVM on-chain trading risk enforcement/
/// pancakeswap_router_and_frontend_routing.md) - a trader routed through V3/Universal Router
/// (which pancakeswap.finance's own UI sometimes picks for better pricing) is NOT yet covered
/// by this Guard. Whether PooCoin/GMGN route through this V2 Router directly or through their
/// own intermediary contract is also unconfirmed (GMGN especially looks likely to use its own
/// contract) - trades through either are only covered here if they really do call this router
/// directly.
///
/// There is no "position size" or "leverage" concept in spot swaps - the two rules here are
/// max amount of a given input token spent in one trade, and max trades per day. Unlike GMX's
/// sizeDeltaUsd, these limits are in the INPUT TOKEN's own units (e.g., "max 100 USDT per
/// trade", "max 0.5 BNB per trade") rather than a universal USD figure, since converting an
/// arbitrary input token to USD on-chain would require a price oracle - deliberately avoided
/// here, same reasoning as why max-leverage/max-daily-loss are out of scope for the GMX Guard.
///
/// One Guard instance is meant to be shared across many Safes - `msg.sender` inside
/// checkTransaction/checkModuleTransaction is the calling Safe itself.
contract PancakeSwapV2LimitGuard is BaseGuard {
    /// @notice PancakeSwap's V2 Router - the only contract this Guard gates.
    address public router;

    /// @notice The only address allowed to configure limits - MyPropGuard's own backend, not
    /// the trader. Same reasoning as GmxPositionLimitGuard: a trader-configurable limit isn't a
    /// real third-party-enforced rule.
    address public immutable admin;

    /// @dev Sentinel used in the per-token limit mappings to represent native BNB (there is no
    /// real token address for it - V2 Router's `...ETH...` functions spend `msg.value`, not an
    /// ERC-20 `transferFrom`).
    address public constant NATIVE_BNB = address(0);

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

    /// @dev account => input token (NATIVE_BNB for BNB) => max amount spendable in one trade.
    /// 0 means "not configured" - see LimitsNotConfigured below for the fail-closed default.
    mapping(address => mapping(address => uint256)) public maxAmountPerTrade;
    mapping(address => uint256) public maxTradesPerDay;

    struct AccountState {
        uint256 lastTradeDay;
        uint256 tradesToday;
    }

    mapping(address => AccountState) public tradeState;

    event RouterUpdated(address indexed newRouter);
    event TokenLimitSet(address indexed account, address indexed token, uint256 maxAmountPerTrade);
    event TradeCountLimitSet(address indexed account, uint256 maxTradesPerDay);
    event SwapChecked(address indexed account, address indexed token, uint256 amount, uint256 tradesToday);

    error NotAdmin();
    error LimitsNotConfigured(address account);
    error TradeAmountExceeded(address token, uint256 requested, uint256 max);
    error TradeCountExceeded(uint256 attempted, uint256 max);
    error DelegateCallNotAllowed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin, address _router) {
        admin = _admin;
        router = _router;
    }

    /// @notice PancakeSwap could redeploy its router, or MyPropGuard may want to point this at
    /// a different router entirely - never hardcode, same lesson as GMX's ExchangeRouter.
    function setRouter(address newRouter) external onlyAdmin {
        router = newRouter;
        emit RouterUpdated(newRouter);
    }

    /// @notice Sets the max amount of `token` (NATIVE_BNB for BNB) that `account` may spend in
    /// a single swap. Only MyPropGuard's admin key can call this.
    function setTokenLimit(address account, address token, uint256 amount) external onlyAdmin {
        maxAmountPerTrade[account][token] = amount;
        emit TokenLimitSet(account, token, amount);
    }

    /// @notice Sets the max number of swaps `account` may make per UTC day. Required to be set
    /// (non-zero) before this Guard will allow any PancakeSwap trade at all - see
    /// LimitsNotConfigured.
    function setMaxTradesPerDay(address account, uint256 limit) external onlyAdmin {
        maxTradesPerDay[account] = limit;
        emit TradeCountLimitSet(account, limit);
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

    function checkAfterExecution(bytes32, bool) external override {
        // Both rules here are fully decidable from pending calldata/value alone.
    }

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
        if (to != router) return;
        if (operation == Enum.Operation.DelegateCall) revert DelegateCallNotAllowed();

        // Trade-count limit must always be explicitly set before any trade is allowed - fail
        // closed, same principle as GmxPositionLimitGuard. Per-token amount limits are optional
        // on top of that (0 = no amount cap configured for that specific token yet).
        uint256 tradeLimit = maxTradesPerDay[account];
        if (tradeLimit == 0) revert LimitsNotConfigured(account);

        (address inputToken, uint256 inputAmount, bool isSwap) = _decodeSwap(data, value);
        if (!isSwap) return; // not a swap call this Guard understands (e.g. addLiquidity) - out of v1 scope, passes through

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

    /// @dev Returns (inputToken, inputAmount, matched). `matched` is false for any selector this
    /// Guard doesn't recognize (addLiquidity, removeLiquidity, other routers' functions, etc.) -
    /// those pass through unchecked in v1.
    function _decodeSwap(bytes memory data, uint256 value) private pure returns (address, uint256, bool) {
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
            // Input amount is msg.value, not a calldata field - path[0] isn't even read here
            // since the spend side is always native BNB for these functions.
            return (NATIVE_BNB, value, true);
        }

        return (address(0), 0, false);
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
