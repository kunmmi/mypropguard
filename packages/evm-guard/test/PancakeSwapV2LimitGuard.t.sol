// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {PancakeSwapV2LimitGuard} from "../src/PancakeSwapV2LimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Exercises PancakeSwapV2LimitGuard against calldata shaped exactly like real
/// PancakeSwap V2 Router calls (standard Uniswap-V2-Router02-compatible ABI, confirmed in
/// research_notes/EVM on-chain trading risk enforcement/pancakeswap_router_and_frontend_routing.md).
contract PancakeSwapV2LimitGuardTest is Test {
    PancakeSwapV2LimitGuard guard;

    address admin = address(0xA11CE);
    address router = address(0xCAFE);
    address safeAccount = address(0x5AFE);
    address otherTarget = address(0xBEEF);
    address usdt = address(0x55d398326f99059fF775485246999027B3197955);
    address busd = address(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56);

    function setUp() public {
        guard = new PancakeSwapV2LimitGuard(admin, router);
    }

    // ---- helpers -----------------------------------------------------------------------

    function _swapExactTokensForTokens(uint256 amountIn, address tokenIn, address tokenOut) private view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        return abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)", amountIn, 0, path, safeAccount, block.timestamp + 300
        );
    }

    function _swapExactETHForTokens(address tokenOut) private view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = address(0x1); // WBNB placeholder - not read by the Guard for this function
        path[1] = tokenOut;
        return abi.encodeWithSignature("swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, safeAccount, block.timestamp + 300);
    }

    function _checkAsSafe(address to, uint256 value, bytes memory data) private {
        vm.prank(safeAccount);
        guard.checkTransaction(to, value, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }

    // ---- tests ---------------------------------------------------------------------------

    function test_RevertsWhenTradeCountLimitNotConfigured() public {
        bytes memory data = _swapExactTokensForTokens(100e18, usdt, busd);
        vm.expectRevert(abi.encodeWithSelector(PancakeSwapV2LimitGuard.LimitsNotConfigured.selector, safeAccount));
        _checkAsSafe(router, 0, data);
    }

    function test_AllowsTradeWithinLimits() public {
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);
        guard.setTokenLimit(safeAccount, usdt, 1000e18);
        vm.stopPrank();

        _checkAsSafe(router, 0, _swapExactTokensForTokens(500e18, usdt, busd));

        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_RevertsWhenTokenAmountExceeded() public {
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);
        guard.setTokenLimit(safeAccount, usdt, 1000e18);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(PancakeSwapV2LimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(router, 0, _swapExactTokensForTokens(2000e18, usdt, busd));
    }

    function test_AllowsUnlimitedAmountForTokenWithNoConfiguredLimit() public {
        // Trade count is configured, but no per-token limit was ever set for USDT specifically -
        // this must not block the trade (0 = "no amount cap for this token yet", not "cap of 0").
        vm.prank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);

        _checkAsSafe(router, 0, _swapExactTokensForTokens(1_000_000e18, usdt, busd));

        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_RevertsWhenTradeCountExceeded() public {
        vm.prank(admin);
        guard.setMaxTradesPerDay(safeAccount, 2);

        _checkAsSafe(router, 0, _swapExactTokensForTokens(10e18, usdt, busd));
        _checkAsSafe(router, 0, _swapExactTokensForTokens(10e18, usdt, busd));

        vm.expectRevert(abi.encodeWithSelector(PancakeSwapV2LimitGuard.TradeCountExceeded.selector, 3, 2));
        _checkAsSafe(router, 0, _swapExactTokensForTokens(10e18, usdt, busd));
    }

    function test_TradeCountResetsOnNewDay() public {
        vm.prank(admin);
        guard.setMaxTradesPerDay(safeAccount, 1);

        _checkAsSafe(router, 0, _swapExactTokensForTokens(10e18, usdt, busd));

        vm.warp(block.timestamp + 1 days);
        _checkAsSafe(router, 0, _swapExactTokensForTokens(10e18, usdt, busd)); // must not revert

        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_NativeBnbSwapUsesMsgValueNotCalldata() public {
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);
        guard.setTokenLimit(safeAccount, guard.NATIVE_BNB(), 1 ether);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(PancakeSwapV2LimitGuard.TradeAmountExceeded.selector, guard.NATIVE_BNB(), 2 ether, 1 ether)
        );
        _checkAsSafe(router, 2 ether, _swapExactETHForTokens(busd));
    }

    function test_AllowsNativeBnbSwapWithinLimit() public {
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);
        guard.setTokenLimit(safeAccount, guard.NATIVE_BNB(), 1 ether);
        vm.stopPrank();

        _checkAsSafe(router, 0.5 ether, _swapExactETHForTokens(busd));

        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_IgnoresCallsToOtherContracts() public {
        // No limits configured at all - must not revert, since this Guard only gates the
        // PancakeSwap router, not general Safe activity.
        _checkAsSafe(otherTarget, 0, hex"deadbeef");
    }

    function test_IgnoresUnrecognizedFunctionsOnTheRouter() public {
        vm.prank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);

        // e.g. addLiquidity - not a swap, out of v1 scope, must pass through without counting
        // as a trade.
        _checkAsSafe(router, 0, abi.encodeWithSignature("addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)"));

        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 0);
    }

    function test_RevertsOnDelegateCallToRouter() public {
        vm.prank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);

        vm.expectRevert(PancakeSwapV2LimitGuard.DelegateCallNotAllowed.selector);
        vm.prank(safeAccount);
        guard.checkTransaction(
            router, 0, _swapExactTokensForTokens(10e18, usdt, busd), Enum.Operation.DelegateCall, 0, 0, 0, address(0), payable(address(0)), "", address(0)
        );
    }

    function test_OnlyAdminCanSetLimits() public {
        vm.expectRevert(PancakeSwapV2LimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.setMaxTradesPerDay(safeAccount, 5);

        vm.expectRevert(PancakeSwapV2LimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.setTokenLimit(safeAccount, usdt, 1000e18);
    }

    function test_ModuleInitiatedTradesAreEnforcedTheSameAsOwnerInitiated() public {
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(safeAccount, 5);
        guard.setTokenLimit(safeAccount, usdt, 100e18);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(PancakeSwapV2LimitGuard.TradeAmountExceeded.selector, usdt, 200e18, 100e18));
        vm.prank(safeAccount);
        guard.checkModuleTransaction(router, 0, _swapExactTokensForTokens(200e18, usdt, busd), Enum.Operation.Call, address(0xD00D));
    }
}
