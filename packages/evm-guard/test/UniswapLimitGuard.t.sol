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
    address weth = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);

    function setUp() public {
        // Real chains are never anywhere near the Unix epoch - run tests at a realistic
        // timestamp so "day 0" (the never-frozen sentinel) isn't reachable here either,
        // matching real conditions rather than Foundry's own near-zero default clock.
        vm.warp(1_700_000_000);
        guard = new UniswapLimitGuard(admin, v2Router, weth);
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

    function _swapExactTokensForEth(uint256 amountIn, address tokenIn) private view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = weth;
        return abi.encodeWithSignature(
            "swapExactTokensForETH(uint256,uint256,address[],address,uint256)", amountIn, 0, path, safeAccount, block.timestamp + 300
        );
    }

    function _swapExactEthForTokens(address tokenOut) private view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = tokenOut;
        return abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, safeAccount, block.timestamp + 300
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

    function test_UnrecognizedCallToUnknownContractReverts() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.UnrecognizedCall.selector, otherTarget, bytes4(0xdeadbeef)));
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

    function test_RemovingARouterMakesItsCallsUnrecognizedAndBlocked() public {
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.setRouterKind(v3RouterNoDeadline, UniswapLimitGuard.RouterKind.None);

        // No longer a recognized router, and swap calldata is not an allowed non-router call.
        bytes memory data = _exactInputSingleNoDeadline(usdt, dai, 999_999e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.UnrecognizedCall.selector, v3RouterNoDeadline, _sel(data)));
        _checkAsSafe(v3RouterNoDeadline, 0, data);
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

    function test_FreezingDoesNotBlockWithdrawals() public {
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        _checkAsSafe(otherTarget, 1 ether, ""); // plain native send
        _checkAsSafe(usdt, 0, abi.encodeWithSignature("transfer(address,uint256)", otherTarget, 5e18));
    }

    // ---- block-by-default hardening -----------------------------------------------------

    function _sel(bytes memory data) private pure returns (bytes4 s) {
        assembly { s := mload(add(data, 32)) }
    }

    function test_DelegateCallToAnyTargetReverts() public {
        vm.expectRevert(UniswapLimitGuard.DelegateCallNotAllowed.selector);
        vm.prank(safeAccount);
        guard.checkTransaction(
            otherTarget, 0, "", Enum.Operation.DelegateCall, 0, 0, 0, address(0), payable(address(0)), "", address(0)
        );
    }

    function test_ValueWithCalldataToUnknownContractReverts() public {
        vm.expectRevert();
        _checkAsSafe(otherTarget, 1 ether, abi.encodeWithSignature("transfer(address,uint256)", otherTarget, 1));
    }

    function test_ApproveOfRegisteredRouterAllowedOthersBlocked() public {
        _checkAsSafe(usdt, 0, abi.encodeWithSignature("approve(address,uint256)", v2Router, 1e30));
        _checkAsSafe(usdt, 0, abi.encodeWithSignature("approve(address,uint256)", otherTarget, 0)); // revoke ok
        bytes memory bad = abi.encodeWithSignature("approve(address,uint256)", otherTarget, 1e30);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.UnrecognizedCall.selector, usdt, _sel(bad)));
        _checkAsSafe(usdt, 0, bad);
    }

    function test_WrapUnwrapAllowed() public {
        _checkAsSafe(weth, 1 ether, abi.encodeWithSignature("deposit()"));
        _checkAsSafe(weth, 0, abi.encodeWithSignature("withdraw(uint256)", 1 ether));
    }

    function test_UnknownRouterFunctionReverts() public {
        bytes memory data = abi.encodeWithSignature("addLiquidity(address,address,uint256)", usdt, dai, 1);
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.UnrecognizedCall.selector, v2Router, _sel(data)));
        _checkAsSafe(v2Router, 0, data);
    }

    function test_UnknownCallInsideV3MulticallReverts() public {
        _setLimits(5, usdt, 1000e18);
        bytes[] memory calls = new bytes[](2);
        calls[0] = _exactInputSingleNoDeadline(usdt, dai, 100e18);
        calls[1] = abi.encodeWithSignature("selfdestruct()");
        bytes memory data = abi.encodeWithSignature("multicall(bytes[])", calls);
        vm.expectRevert();
        _checkAsSafe(v3RouterNoDeadline, 0, data);
    }

    function test_HarmlessV3SettlementCallsInsideMulticallAllowed() public {
        _setLimits(5, usdt, 1000e18);
        bytes[] memory calls = new bytes[](2);
        calls[0] = _exactInputSingleNoDeadline(usdt, weth, 100e18);
        calls[1] = abi.encodeWithSignature("unwrapWETH9(uint256,address)", 0, safeAccount);
        _checkAsSafe(v3RouterNoDeadline, 0, abi.encodeWithSignature("multicall(bytes[])", calls));
    }

    // ---- guard removal: 24h cooldown, never while frozen ---------------------------------

    function _setGuardData() private pure returns (bytes memory) {
        return abi.encodeWithSignature("setGuard(address)", address(0));
    }

    function test_SetGuardWithoutRequestReverts() public {
        vm.expectRevert();
        _checkAsSafe(safeAccount, 0, _setGuardData());
    }

    function test_SetGuardBeforeCooldownReverts() public {
        vm.prank(safeAccount);
        guard.requestRemoval();
        vm.warp(block.timestamp + 23 hours);
        vm.expectRevert();
        _checkAsSafe(safeAccount, 0, _setGuardData());
    }

    function test_SetGuardAfterCooldownAllowedAndClearsRequest() public {
        vm.prank(safeAccount);
        guard.requestRemoval();
        vm.warp(block.timestamp + 24 hours + 1);
        _checkAsSafe(safeAccount, 0, _setGuardData());
        assertEq(guard.removalRequestedAt(safeAccount), 0);
    }

    function test_SetGuardBlockedWhileFrozenEvenAfterCooldown() public {
        vm.prank(safeAccount);
        guard.requestRemoval();
        vm.warp(block.timestamp + 25 hours);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.GuardRemovalBlockedWhileFrozen.selector, safeAccount));
        _checkAsSafe(safeAccount, 0, _setGuardData());
    }

    function test_CancelRemovalResetsCooldown() public {
        vm.startPrank(safeAccount);
        guard.requestRemoval();
        guard.cancelRemoval();
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _checkAsSafe(safeAccount, 0, _setGuardData());
    }

    function test_OtherSafeSelfCallsStillAllowed() public {
        _checkAsSafe(safeAccount, 0, abi.encodeWithSignature("enableModule(address)", otherTarget));
    }

    function test_SafeCanCallRequestRemovalButNotAdminFunctions() public {
        _checkAsSafe(address(guard), 0, abi.encodeWithSignature("requestRemoval()"));
        bytes memory data = abi.encodeWithSignature("setMaxTradesPerDay(address,uint256)", safeAccount, 1000);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.UnrecognizedCall.selector, address(guard), _sel(data)));
        _checkAsSafe(address(guard), 0, data);
    }

    function test_OnlyAdminCanRecordABreach() public {
        vm.expectRevert(UniswapLimitGuard.NotAdmin.selector);
        vm.prank(safeAccount);
        guard.recordDailyLossBreach(safeAccount);
    }

    // ---- buy/sell asymmetry while frozen - selling into ETH is always allowed ---------------

    function test_V2_SellingForNativeEthIsAllowedEvenWhileFrozen() public {
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        // swapExactTokensForETH always outputs native ETH regardless of the path's last entry.
        _checkAsSafe(v2Router, 0, _swapExactTokensForEth(500e18, usdt));
        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 0); // an exit never consumes the daily buy allowance
    }

    function test_V2_BuyingWithNativeEthIsBlockedWhileFrozen() public {
        _setLimits(5, address(0), 0);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.AccountIsFrozen.selector, safeAccount));
        _checkAsSafe(v2Router, 1 ether, _swapExactEthForTokens(usdt));
    }

    function test_V3_SellingForWethIsAllowedEvenWhileFrozen() public {
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        // V3 routers always output the wrapped form, never the native sentinel directly.
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, weth, 500e18));
        (, uint256 tradesToday) = guard.tradeState(safeAccount);
        assertEq(tradesToday, 0); // an exit never consumes the daily buy allowance
    }

    function test_V3_BuyingFromWethIsBlockedWhileFrozen() public {
        _setLimits(5, weth, 1000e18);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.AccountIsFrozen.selector, safeAccount));
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(weth, usdt, 500e18));
    }

    function test_DirectTokenToTokenSwapNeitherSideEthIsConservativelyBlockedWhileFrozen() public {
        // usdt -> dai: neither side is ETH/WETH, so this still opens exposure to a different
        // token rather than returning to the base asset - must stay blocked while frozen.
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.AccountIsFrozen.selector, safeAccount));
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(500e18, usdt, dai));
    }

    function test_SellsAreNeverCappedByTheTokenAmountLimit() public {
        // Selling into the native asset is never limited, even far above a configured limit and
        // even while frozen - a cap on exits could trap a trader in a position.
        _setLimits(5, usdt, 1000e18);
        vm.prank(admin);
        guard.recordDailyLossBreach(safeAccount);

        _checkAsSafe(v2Router, 0, _swapExactTokensForEth(2000e18, usdt));
    }

    function test_BuysAreStillCappedByTheTokenAmountLimit() public {
        _setLimits(5, usdt, 1000e18);
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, usdt, 2000e18, 1000e18));
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(2000e18, usdt, dai));
    }

    // ---- the daily limit counts BUYS only ----------------------------------------------------

    function test_SellsDoNotConsumeOrGetBlockedByTheBuyCount() public {
        _setLimits(1, usdt, 1000e18);
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(500e18, usdt, dai)); // the one buy
        // Selling into the native asset any number of times after the buy allowance is used up.
        _checkAsSafe(v2Router, 0, _swapExactTokensForEth(100e18, usdt));
        _checkAsSafe(v2Router, 0, _swapExactTokensForEth(100e18, usdt));
        _checkAsSafe(v3RouterNoDeadline, 0, _exactInputSingleNoDeadline(usdt, weth, 100e18));
        (, uint256 counted) = guard.tradeState(safeAccount);
        assertEq(counted, 1);
    }

    function test_SecondBuyInTheSameDayRevertsWhenLimitIsOne() public {
        _setLimits(1, usdt, 1000e18);
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(100e18, usdt, dai));
        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeCountExceeded.selector, 2, 1));
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(100e18, usdt, dai));
    }

    function test_BuyAllowanceResetsNextDay() public {
        _setLimits(1, usdt, 1000e18);
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(100e18, usdt, dai));
        vm.warp(block.timestamp + 1 days);
        _checkAsSafe(v2Router, 0, _swapExactTokensForTokens(100e18, usdt, dai));
    }
}
