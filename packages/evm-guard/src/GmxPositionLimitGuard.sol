// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BaseGuard} from "safe-smart-account/contracts/examples/guards/BaseGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @title GmxPositionLimitGuard
/// @notice A Safe Guard enforcing MyPropGuard risk rules (max position size, max trades/day)
/// on GMX v2 "Classic Trading" position-opening orders, no matter which front-end (GMX's own
/// UI, a bot, MetaMask) submits the Safe transaction. Every GMX order-opening call must pass
/// through this Guard's checkTransaction/checkModuleTransaction before the Safe will execute
/// it - a violating transaction reverts and never reaches GMX at all.
///
/// Scope (v1, per MyPropGuard's EVM expansion plan): only max position size (per order) and
/// max trades per day are enforced here. Max leverage and max daily loss are deferred - they
/// need cross-trade P&L/position-value accounting this Guard has no way to compute from
/// calldata alone (see the "EVM on-chain trading risk enforcement" research report).
///
/// One Guard instance is meant to be shared across many Safes: `msg.sender` inside
/// checkTransaction/checkModuleTransaction is the calling Safe itself (Safe's GuardManager
/// invokes the Guard as `guard.checkTransaction(...)` from within its own execTransaction), so
/// per-account state is keyed by that address rather than needing one deployment per account.
contract GmxPositionLimitGuard is BaseGuard {
    /// @notice GMX's ExchangeRouter is the only contract this Guard gates. Everything else a
    /// Safe does passes through untouched - this is a trading-risk gate, not a general-purpose
    /// transaction firewall.
    address public exchangeRouter;

    /// @notice The only address allowed to configure limits - MyPropGuard's own backend/admin
    /// key, set once at deploy time. Deliberately NOT the Safe owner: if the trader could set
    /// their own limits, the gate would be decorative, not enforced by a third party.
    address public immutable admin;

    bytes4 private constant MULTICALL_SELECTOR = bytes4(keccak256("multicall(bytes[])"));
    bytes4 private constant CREATE_ORDER_SELECTOR =
        bytes4(
            keccak256(
                "createOrder((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))"
            )
        );

    /// @dev Mirrors GMX v2's IBaseOrderUtils.CreateOrderParams (gmx-synthetics,
    /// contracts/order/IBaseOrderUtils.sol) - decoding target for the inner multicall element,
    /// not GMX's own storage layout (Order.Props), which differs slightly.
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

    /// @dev Order of values matters - must match GMX's Order.OrderType enum exactly, since a
    /// trader never sends the enum name, only its integer encoding.
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

    struct CreateOrderParams {
        CreateOrderParamsAddresses addresses;
        CreateOrderParamsNumbers numbers;
        OrderType orderType;
        uint8 decreasePositionSwapType;
        bool isLong;
        bool shouldUnwrapNativeToken;
        bool autoCancel;
        bytes32 referralCode;
        bytes32[] dataList;
    }

    struct AccountLimits {
        /// @dev 30-decimal USD, matching GMX's own sizeDeltaUsd precision. 0 means "not set".
        uint256 maxPositionSizeUsd;
        uint256 maxTradesPerDay;
    }

    struct AccountState {
        uint256 lastTradeDay;
        uint256 tradesToday;
    }

    mapping(address => AccountLimits) public limits;
    mapping(address => AccountState) public tradeState;

    event ExchangeRouterUpdated(address indexed newRouter);
    event LimitsSet(address indexed account, uint256 maxPositionSizeUsd, uint256 maxTradesPerDay);
    event OrderChecked(address indexed account, uint256 sizeDeltaUsd, uint256 tradesToday);

    error NotAdmin();
    error LimitsNotConfigured(address account);
    error PositionSizeExceeded(uint256 requested, uint256 max);
    error TradeCountExceeded(uint256 attempted, uint256 max);
    error DelegateCallNotAllowed();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin, address _exchangeRouter) {
        admin = _admin;
        exchangeRouter = _exchangeRouter;
    }

    /// @notice GMX redeploys ExchangeRouter across protocol upgrades (confirmed: at least 4
    /// distinct addresses have existed) - this must stay admin-updatable, never hardcoded.
    function setExchangeRouter(address newExchangeRouter) external onlyAdmin {
        exchangeRouter = newExchangeRouter;
        emit ExchangeRouterUpdated(newExchangeRouter);
    }

    /// @notice Sets (or updates) the risk limits for one Safe. Only MyPropGuard's admin key can
    /// call this - the trader themselves cannot loosen their own limits.
    function setLimits(address account, uint256 maxPositionSizeUsd, uint256 maxTradesPerDay) external onlyAdmin {
        limits[account] = AccountLimits(maxPositionSizeUsd, maxTradesPerDay);
        emit LimitsSet(account, maxPositionSizeUsd, maxTradesPerDay);
    }

    /// @notice Safe Guard hook (see ITransactionGuard/IModuleGuard)
    function checkTransaction(
        address to,
        uint256,
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
        _enforce(msg.sender, to, data, operation);
    }

    /// @notice Safe Guard hook (see ITransactionGuard/IModuleGuard)
    function checkAfterExecution(bytes32, bool) external override {
        // Both rules enforced here are fully decidable from pending calldata alone - nothing
        // additional to verify once the GMX call has actually executed.
    }

    /// @notice Safe Guard hook (see ITransactionGuard/IModuleGuard)
    function checkModuleTransaction(
        address to,
        uint256,
        bytes memory data,
        Enum.Operation operation,
        address
    ) external override returns (bytes32) {
        _enforce(msg.sender, to, data, operation);
        return bytes32(0);
    }

    /// @notice Safe Guard hook (see ITransactionGuard/IModuleGuard)
    function checkAfterModuleExecution(bytes32, bool) external override {}

    /// @dev Shared enforcement path for both owner-initiated (checkTransaction) and
    /// module-initiated (checkModuleTransaction) Safe transactions - a rule bypass via a
    /// Zodiac module would otherwise defeat the whole point of this Guard.
    function _enforce(address account, address to, bytes memory data, Enum.Operation operation) private {
        if (to != exchangeRouter) return;
        if (operation == Enum.Operation.DelegateCall) revert DelegateCallNotAllowed();

        AccountLimits memory accountLimits = limits[account];
        if (accountLimits.maxTradesPerDay == 0 && accountLimits.maxPositionSizeUsd == 0) {
            revert LimitsNotConfigured(account);
        }

        if (_selector(data) != MULTICALL_SELECTOR) return;

        bytes[] memory calls = abi.decode(_stripSelector(data), (bytes[]));

        uint256 newOrders = 0;
        for (uint256 i = 0; i < calls.length; i++) {
            bytes memory inner = calls[i];
            if (inner.length < 4 || _selector(inner) != CREATE_ORDER_SELECTOR) continue;

            CreateOrderParams memory params = abi.decode(_stripSelector(inner), (CreateOrderParams));
            if (!_isPositionIncreasing(params.orderType)) continue;

            newOrders += 1;
            if (accountLimits.maxPositionSizeUsd != 0 && params.numbers.sizeDeltaUsd > accountLimits.maxPositionSizeUsd) {
                revert PositionSizeExceeded(params.numbers.sizeDeltaUsd, accountLimits.maxPositionSizeUsd);
            }
        }

        if (newOrders == 0) return;

        uint256 today = block.timestamp / 1 days;
        AccountState memory existing = tradeState[account];
        uint256 tradesToday = (existing.lastTradeDay == today ? existing.tradesToday : 0) + newOrders;

        if (accountLimits.maxTradesPerDay != 0 && tradesToday > accountLimits.maxTradesPerDay) {
            revert TradeCountExceeded(tradesToday, accountLimits.maxTradesPerDay);
        }

        tradeState[account] = AccountState(today, tradesToday);
        emit OrderChecked(account, 0, tradesToday);
    }

    function _isPositionIncreasing(OrderType orderType) private pure returns (bool) {
        return orderType == OrderType.MarketIncrease || orderType == OrderType.LimitIncrease || orderType == OrderType.StopIncrease;
    }

    function _selector(bytes memory data) private pure returns (bytes4 sel) {
        require(data.length >= 4, "GmxGuard: calldata too short");
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
