// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseGuard} from "safe-smart-account/contracts/examples/guards/BaseGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @title UniswapV2LimitGuard
/// @notice A Safe Guard enforcing MyPropGuard risk rules (max amount spent per trade, max
/// trades/day) on Uniswap's V2 Router, on Ethereum mainnet - no matter which front-end submits
/// the Safe transaction (app.uniswap.org itself, a bot, MetaMask). A trade that breaks the
/// configured limits reverts on-chain and never reaches Uniswap at all.
///
/// This is deliberately the same logic as PancakeSwapV2LimitGuard.sol - confirmed via a
/// line-by-line source diff (see research_notes/Uniswap V2 Router Ethereum parity/
/// safe_compatibility_and_fork_differences.md) that PancakeSwap's V2 Router is a near-exact fork
/// of Uniswap's own `UniswapV2Router02.sol` (same 446 lines, same logic order, only cosmetic
/// differences). Kept as a separate contract rather than one shared/parameterized contract so
/// each exchange's integration can evolve independently (e.g. if one fork diverges later) and
/// so a bug in one never risks the other - same reasoning as keeping GmxPositionLimitGuard and
/// PancakeSwapV2LimitGuard as separate contracts rather than one "generic AMM Guard."
///
/// Scope (v1, per MyPropGuard's EVM expansion plan): only Uniswap's **V2 Router**
/// (`0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` - stable since June 2020, unlike GMX's
/// ExchangeRouter which has been redeployed multiple times - still admin-updatable via
/// `setRouter` as a matter of principle, not because redeployment is expected here). Uniswap
/// also has a V3 SwapRouter and its own Universal Router, both with a more complex,
/// optionally-wrapped calldata shape - a trade routed through either (which Uniswap's own UI
/// sometimes picks for better pricing) is NOT yet covered by this Guard. See
/// packages/evm-guard/ROADMAP.md for the plan to close that gap.
///
/// There is no "position size" or "leverage" concept in spot swaps - the two rules here are max
/// amount of a given input token spent in one trade, and max trades per day, same as the
/// PancakeSwap Guard and for the same reason (no price oracle dependency, deliberately).
///
/// One Guard instance is meant to be shared across many Safes - `msg.sender` inside
/// checkTransaction/checkModuleTransaction is the calling Safe itself.
contract UniswapV2LimitGuard is BaseGuard {
    /// @notice Uniswap's V2 Router - the only contract this Guard gates.
    address public router;

    /// @notice The only address allowed to configure limits - MyPropGuard's own backend, not
    /// the trader.
    address public immutable admin;

    /// @dev Sentinel used in the per-token limit mappings to represent native ETH (there is no
    /// real token address for it - V2 Router's `...ETH...` functions spend `msg.value`, not an
    /// ERC-20 `transferFrom`).
    address public constant NATIVE_ETH = address(0);

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

    /// @dev account => input token (NATIVE_ETH for ETH) => max amount spendable in one trade.
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

    /// @notice Never hardcode downstream - same lesson as GMX's ExchangeRouter, even though
    /// Uniswap's V2 Router has in practice never been redeployed.
    function setRouter(address newRouter) external onlyAdmin {
        router = newRouter;
        emit RouterUpdated(newRouter);
    }

    /// @notice Sets the max amount of `token` (NATIVE_ETH for ETH) that `account` may spend in
    /// a single swap. Only MyPropGuard's admin key can call this.
    function setTokenLimit(address account, address token, uint256 amount) external onlyAdmin {
        maxAmountPerTrade[account][token] = amount;
        emit TokenLimitSet(account, token, amount);
    }

    /// @notice Sets the max number of swaps `account` may make per UTC day. Required to be set
    /// (non-zero) before this Guard will allow any Uniswap trade at all - see
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

        uint256 tradeLimit = maxTradesPerDay[account];
        if (tradeLimit == 0) revert LimitsNotConfigured(account);

        (address inputToken, uint256 inputAmount, bool isSwap) = _decodeSwap(data, value);
        if (!isSwap) return;

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
            return (NATIVE_ETH, value, true);
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
