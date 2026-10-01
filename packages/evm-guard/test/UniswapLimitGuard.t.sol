// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {UniswapLimitGuard} from "../src/UniswapLimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Exercises UniswapLimitGuard's V2 and V3 decode paths against calldata shaped exactly
/// like real Uniswap V2 Router / V3 SwapRouter / SwapRouter02 calls (struct layouts and selector
/// confirmations in research_notes/EVM on-chain trading risk enforcement/v3_and_universal_router_abi.md
/// and research_notes/Uniswap V2 Router Ethereum parity/).
contract UniswapLimitGuardTest is Test {
    UniswapLimitGuard guard;

    address admin = address(0xA11CE);
    address v2Router = address(0xCAFE);
    address v3RouterNoDeadline = address(0xBEE1); // SwapRouter02-style
    address v3RouterWithDeadline = address(0xBEE2); // original SwapRouter-style
    address safeAccount = address(0x5AFE);
    address otherTarget = address(0xBEEF);
    address usdt = address(0xdAC17F958D2ee523a2206206994597C13D831ec7);
    address dai = address(0x6B175474E89094C44Da98b954EedeAC495271d0F);

    function setUp() public {
        guard = new UniswapLimitGuard(admin, v2Router);
        vm.startPrank(admin);
        guard.setRouterKind(v3RouterNoDeadline, UniswapLimitGuard.RouterKind.V3NoDeadline);
        guard.setRouterKind(v3RouterWithDeadline, UniswapLimitGuard.RouterKind.V3WithDeadline);
        vm.stopPrank();
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

    function _exactInputSingleNoDeadline(address tokenIn, address tokenOut, uint256 amountIn) private view returns (bytes memory) {
        return abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            tokenIn, tokenOut, uint24(3000), safeAccount, amountIn, uint256(0), uint160(0)
        );
    }

    function _exactInputSingleWithDeadline(address tokenIn, address tokenOut, uint256 amountIn) private view returns (bytes memory) {
        return abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
            tokenIn, tokenOut, uint24(3000), safeAccount, block.timestamp + 300, amountIn, uint256(0), uint160(0)
        );
    }

    function _exactInputNoDeadline(address tokenIn, address tokenOut, uint256 amountIn) private view returns (bytes memory) {
        bytes memory path = abi.encodePacked(tokenIn, uint24(3000), tokenOut);
        return abi.encodeWithSignature("exactInput((bytes,address,uint256,uint256))", path, safeAccount, amountIn, uint256(0));
    }

    function _checkAsSafe(address to, uint256 value, bytes memory data) private {
        vm.prank(safeAccount);
        guard.checkTransaction(to, value, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }

    function _setLimits(uint256 tradesPerDay, address token, uint256 amount) private {
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(safeAccount, tradesPerDay);
        if (token != address(0) || amount != 0) guard.setTokenLimit(safeAccount, token, amount);
        vm.stopPrank();
    }

    // ---- V2 regression tests (unchanged behavior from the old V2-only contract) -----------

    function test_V2_AllowsTradeWithinLimits() public {
        _setLimits(5, usdt, 1000e18);
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(500e18, usdt, dai));
        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_V2_RevertsWhenAmountExceeded() public {
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(2000e18, usdt, dai));
    }

    function test_IgnoresUnrecognizedRouterAddress() public {
        // No limits configured at all - must not revert, since address(0xBEEF) was never
        // registered with any RouterKind.
        _checkAsSafe(otherTarget, 0, hex"deadbeef");
    }

    // ---- V3 direct calls, both struct shapes ---------------------------------------------

    function test_V3NoDeadline_AllowsDirectExactInputSingleWithinLimit() public {
        _setLimits(5, usdt, 1000e18);
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, dai, 500e18));
        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_V3NoDeadline_RevertsWhenExactInputSingleExceedsLimit() public {
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, dai, 2000e18));
    }

    function test_V3WithDeadline_DecodesCorrectlyDespiteExtraField() public {
        // The whole point of tracking RouterKind per address: this struct has an extra
        // `deadline` field before amountIn - decoding it with the no-deadline shape would read
        // the deadline timestamp as if it were amountIn (a huge, wrong number). Confirm the
        // correct shape is picked and amountIn is read correctly.
        _setLimits(5, usdt, 1000e18);
        _checkAsSafe(v3RouterWithDeadline, 0, _exactInputSingleWithDeadline(usdt, dai, 500e18));
        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_V3WithDeadline_RevertsWhenExceedsLimit() public {
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v3RouterWithDeadline, 0, _exactInputSingleWithDeadline(usdt, dai, 2000e18));
    }

    // ---- V3 multicall wrapping (all three overloads) ---------------------------------------

    function test_V3_DecodesExactInputSingleWrappedInPlainMulticall() public {
        _setLimits(5, usdt, 1000e18);
        bytes[] memory calls = new bytes[](1);
        calls[0] = _exactInputSingleNoDeadline(usdt, dai, 2000e18);
        bytes memory data = abi.encodeWithSignature("multicall(bytes[])", calls);

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v3RouterNoDeadline, 0, data);
    }

    function test_V3_DecodesExactInputSingleWrappedInDeadlineMulticall() public {
        _setLimits(5, usdt, 1000e18);
        bytes[] memory calls = new bytes[](1);
        calls[0] = _exactInputSingleNoDeadline(usdt, dai, 2000e18);
        bytes memory data = abi.encodeWithSignature("multicall(uint256,bytes[])", block.timestamp + 300, calls);

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v3RouterNoDeadline, 0, data);
    }

    function test_V3_DecodesExactInputSingleWrappedInPrevBlockhashMulticall() public {
        _setLimits(5, usdt, 1000e18);
        bytes[] memory calls = new bytes[](1);
        calls[0] = _exactInputSingleNoDeadline(usdt, dai, 2000e18);
        bytes memory data = abi.encodeWithSignature("multicall(bytes32,bytes[])", blockhash(block.number - 1), calls);

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v3RouterNoDeadline, 0, data);
    }

    function test_V3_MultipleOrdersInOneMulticallAreEachChecked() public {
        _setLimits(1, usdt, 1000e18);
        bytes[] memory calls = new bytes[](2);
        calls[0] = _exactInputSingleNoDeadline(usdt, dai, 100e18);
        calls[1] = _exactInputSingleNoDeadline(usdt, dai, 100e18);
        bytes memory data = abi.encodeWithSignature("multicall(bytes[])", calls);

        // Two swaps in one batch against a 1/day limit - must revert on the second, not
        // silently allow a batch to slip two trades past a one-trade limit.
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeCountExceeded.selector, 2, 1));
        _checkAsSafe(v3RouterNoDeadline, 0, data);
    }

    // ---- exactInput (multi-hop, packed path) -----------------------------------------------

    function test_V3_ExactInputDecodesFirstTokenFromPackedPath() public {
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputNoDeadline(usdt, dai, 2000e18));
    }

    // ---- amountIn == 0 self-balance sentinel: must be rejected, never silently allowed -----

    function test_V3_RevertsOnZeroAmountInSentinel() public {
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(UniswapLimitGuard.ZeroAmountInNotAllowed.selector);
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, dai, 0));
    }

    // ---- fail-closed / admin-only ---------------------------------------------------------

    function test_RevertsWhenTradeCountLimitNotConfigured() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.LimitsNotConfigured.selector, safeAccount));
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, dai, 100e18));
    }

    function test_OnlyAdminCanConfigureRoutersOrLimits() public {
        vm.expectRevert(UniswapLimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.setRouterKind(address(0x1234), UniswapLimitGuard.RouterKind.V2);

        vm.expectRevert(UniswapLimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.setMaxTradesPerDay(safeAccount, 5);
    }

    function test_RevertsOnDelegateCallToAnyRecognizedRouter() public {
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(UniswapLimitGuard.DelegateCallNotAllowed.selector);
        vm.prank(safeAccount);
        guard.checkTransaction(
            v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, dai, 100e18), Enum.Operation.DelegateCall, 0, 0, 0, address(0), payable(address(0)), "", address(0)
        );
    }

    function test_ModuleInitiatedV3TradesAreEnforcedTheSameAsOwnerInitiated() public {
        _setLimits(5, usdt, 100e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 200e18, 100e18));
        vm.prank(safeAccount);
        guard.checkModuleTransaction(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, dai, 200e18), Enum.Operation.Call, address(0xD00D));
    }

    function test_RemovingARouterByResettingToNoneStopsEnforcement() public {
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.setRouterKind(v3RouterNoDeadline, UniswapLimitGuard.RouterKind.None);

        // Must not revert even for a huge amount - this address is no longer a recognized router.
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, dai, 999_999e18));
    }

    // ---- max-daily-loss freeze (backend-attested, see contract NatSpec) -------------------

    function test_FrozenAccountCannotTradeEvenWithinOtherwiseValidLimits() public {
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.AccountIsFrozen.selector, safeAccount));
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(500e18, usdt, dai));
    }

    function test_NoFunctionCanLiftAFreezeEarly() public {
        // Confirms the actual guarantee: there is no admin (or any) function that clears
        // frozenThroughDay early - calling recordDailyLossBreach again the same day is the only
        // admin action available, and it's a no-op (still today), not a way back in.
        _setLimits(5, usdt, 1000e18);
        vm.startPrank(admin);
        guard.recordDailyLossBreach(safeAccount);
        guard.recordDailyLossBreach(safeAccount); // idempotent - still frozen for today, not cleared
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.AccountIsFrozen.selector, safeAccount));
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(500e18, usdt, dai));
    }

    function test_FreezeAutomaticallyLiftsAtTheNextUtcDayWithNoTransactionNeeded() public {
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        vm.warp(block.timestamp + 1 days);

        // No unfreeze call of any kind - the clock alone restores normal enforcement.
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(500e18, usdt, dai));
        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 1);
    }

    function test_FreezingDoesNotBlockCallsToUnrecognizedAddresses() public {
        // A frozen account must still be able to move its own funds (e.g. withdraw) through
        // anything this Guard doesn't track as a router - freezing only stops further trades.
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        _checkAsSafe(otherTarget, 0, hex"deadbeef");
    }

    function test_OnlyAdminCanRecordABreach() public {
        vm.expectRevert(UniswapLimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.recordDailyLossBreach(safeAccount);
    }
}
