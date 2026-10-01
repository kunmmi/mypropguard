// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GmxPositionLimitGuard} from "../src/GmxPositionLimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Exercises GmxPositionLimitGuard directly against calldata shaped exactly like a real
/// Safe->ExchangeRouter.multicall([... , createOrder(...)]) transaction, per the GMX v2
/// IBaseOrderUtils.CreateOrderParams struct confirmed from gmx-synthetics' own contract source
/// (see research_notes/EVM on-chain trading risk enforcement/gmx_v2_order_abi.md).
///
/// These tests call checkTransaction/checkModuleTransaction directly with `vm.prank(safe)`
/// rather than deploying a real Safe - GuardManager's own mechanics (that it calls the Guard
/// exactly this way, with the Safe as msg.sender) are Safe's own, already-audited code; what
/// needs proving here is this Guard's own decode/enforce logic.
contract GmxPositionLimitGuardTest is Test {
    GmxPositionLimitGuard guard;

    address admin = address(0xA11CE);
    address exchangeRouter = address(0xE1C4A4);
    address safeAccount = address(0x5AFE);
    address otherTarget = address(0xBEEF);

    uint256 constant USD_1X = 1e30; // GMX's 30-decimal USD precision

    function setUp() public {
        guard = new GmxPositionLimitGuard(admin, exchangeRouter);
    }

    // ---- helpers -----------------------------------------------------------------------

    function _createOrderCalldata(GmxPositionLimitGuard.OrderType orderType, uint256 sizeDeltaUsd)
        private
        pure
        returns (bytes memory)
    {
        GmxPositionLimitGuard.CreateOrderParamsAddresses memory addresses = GmxPositionLimitGuard
            .CreateOrderParamsAddresses({
            receiver: address(0x1),
            cancellationReceiver: address(0),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: address(0x2),
            initialCollateralToken: address(0x3),
            swapPath: new address[](0)
        });

        GmxPositionLimitGuard.CreateOrderParamsNumbers memory numbers = GmxPositionLimitGuard.CreateOrderParamsNumbers({
            sizeDeltaUsd: sizeDeltaUsd,
            initialCollateralDeltaAmount: 100e6,
            triggerPrice: 0,
            acceptablePrice: 0,
            executionFee: 0.001 ether,
            callbackGasLimit: 0,
            minOutputAmount: 0,
            validFromTime: 0
        });

        GmxPositionLimitGuard.CreateOrderParams memory params = GmxPositionLimitGuard.CreateOrderParams({
            addresses: addresses,
            numbers: numbers,
            orderType: orderType,
            decreasePositionSwapType: 0,
            isLong: true,
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0),
            dataList: new bytes32[](0)
        });

        return abi.encodeWithSignature(
            "createOrder((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))",
            params
        );
    }

    function _multicall(bytes[] memory calls) private pure returns (bytes memory) {
        return abi.encodeWithSignature("multicall(bytes[])", calls);
    }

    function _singleIncreaseOrderMulticall(uint256 sizeDeltaUsd) private pure returns (bytes memory) {
        bytes[] memory calls = new bytes[](1);
        calls[0] = _createOrderCalldata(GmxPositionLimitGuard.OrderType.MarketIncrease, sizeDeltaUsd);
        return _multicall(calls);
    }

    function _checkAsSafe(address to, bytes memory data) private {
        vm.prank(safeAccount);
        guard.checkTransaction(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }

    // ---- tests ---------------------------------------------------------------------------

    function test_RevertsWhenLimitsNotConfigured() public {
        bytes memory data = _singleIncreaseOrderMulticall(500 * USD_1X);
        vm.expectRevert(abi.encodeWithSelector(GmxPositionLimitGuard.LimitsNotConfigured.selector, safeAccount));
        _checkAsSafe(exchangeRouter, data);
    }

    function test_AllowsTradeWithinLimits() public {
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 5);

        bytes memory data = _singleIncreaseOrderMulticall(500 * USD_1X);
        _checkAsSafe(exchangeRouter, data); // must not revert

        (uint256 lastTradeDay, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
        assertEq(lastTradeDay, block.timestamp / 1 days);
    }

    function test_RevertsWhenPositionSizeExceeded() public {
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 5);

        bytes memory data = _singleIncreaseOrderMulticall(2000 * USD_1X);
        vm.expectRevert(
            abi.encodeWithSelector(GmxPositionLimitGuard.PositionSizeExceeded.selector, 2000 * USD_1X, 1000 * USD_1X)
        );
        _checkAsSafe(exchangeRouter, data);
    }

    function test_RevertsWhenTradeCountExceededAcrossSeparateTransactions() public {
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 2);

        _checkAsSafe(exchangeRouter, _singleIncreaseOrderMulticall(100 * USD_1X));
        _checkAsSafe(exchangeRouter, _singleIncreaseOrderMulticall(100 * USD_1X));

        vm.expectRevert(abi.encodeWithSelector(GmxPositionLimitGuard.TradeCountExceeded.selector, 3, 2));
        _checkAsSafe(exchangeRouter, _singleIncreaseOrderMulticall(100 * USD_1X));
    }

    function test_TradeCountResetsOnNewDay() public {
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 1);

        _checkAsSafe(exchangeRouter, _singleIncreaseOrderMulticall(100 * USD_1X));

        vm.warp(block.timestamp + 1 days);
        _checkAsSafe(exchangeRouter, _singleIncreaseOrderMulticall(100 * USD_1X)); // must not revert - new day, counter reset

        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_IgnoresCallsToOtherContracts() public {
        // No limits configured at all, and a call to some unrelated contract - must not revert,
        // since this Guard only gates GMX's ExchangeRouter, not general Safe activity.
        _checkAsSafe(otherTarget, hex"deadbeef");
    }

    function test_IgnoresDecreaseOrdersRegardlessOfSize() public {
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 5);

        bytes[] memory calls = new bytes[](1);
        // Huge size, but it's a MarketDecrease (closing/reducing exposure) - must not count
        // against the position-size or trade-count limits, which only gate opening exposure.
        calls[0] = _createOrderCalldata(GmxPositionLimitGuard.OrderType.MarketDecrease, 999_999 * USD_1X);
        _checkAsSafe(exchangeRouter, _multicall(calls));

        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 0);
    }

    function test_MultipleOrdersInOneMulticallAreSummedForTradeCount() public {
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 1);

        bytes[] memory calls = new bytes[](2);
        calls[0] = _createOrderCalldata(GmxPositionLimitGuard.OrderType.MarketIncrease, 100 * USD_1X);
        calls[1] = _createOrderCalldata(GmxPositionLimitGuard.OrderType.MarketIncrease, 100 * USD_1X);

        // Two orders in one batch against a limit of 1/day - must revert, not silently allow
        // a batch to slip two trades past a one-trade limit.
        vm.expectRevert(abi.encodeWithSelector(GmxPositionLimitGuard.TradeCountExceeded.selector, 2, 1));
        _checkAsSafe(exchangeRouter, _multicall(calls));
    }

    function test_RevertsOnDelegateCallToExchangeRouter() public {
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 5);

        bytes memory data = _singleIncreaseOrderMulticall(100 * USD_1X);
        vm.expectRevert(GmxPositionLimitGuard.DelegateCallNotAllowed.selector);
        vm.prank(safeAccount);
        guard.checkTransaction(
            exchangeRouter, 0, data, Enum.Operation.DelegateCall, 0, 0, 0, address(0), payable(address(0)), "", address(0)
        );
    }

    function test_OnlyAdminCanSetLimits() public {
        vm.expectRevert(GmxPositionLimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.setLimits(safeAccount, 1000 * USD_1X, 5);
    }

    function test_OnlyAdminCanUpdateExchangeRouter() public {
        vm.expectRevert(GmxPositionLimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.setExchangeRouter(address(0x999));
    }

    function test_ModuleInitiatedTradesAreEnforcedTheSameAsOwnerInitiated() public {
        // A trade routed through a Zodiac module (not a direct owner-signed transaction) must
        // not bypass the same limits - otherwise the module path would be a loophole.
        vm.prank(admin);
        guard.setLimits(safeAccount, 1000 * USD_1X, 1);

        bytes memory data = _singleIncreaseOrderMulticall(2000 * USD_1X);
        vm.expectRevert(
            abi.encodeWithSelector(GmxPositionLimitGuard.PositionSizeExceeded.selector, 2000 * USD_1X, 1000 * USD_1X)
        );
        vm.prank(safeAccount);
        guard.checkModuleTransaction(exchangeRouter, 0, data, Enum.Operation.Call, address(0xD00D));
    }
}
