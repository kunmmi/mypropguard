// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SpotRiskGuard} from "../src/SpotRiskGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        balanceOf[from] -= amount;
    }
}

/// @notice Unit tests for the outcome-based Guard. The Safe's execution is simulated by calling the
/// pre hook, changing balances the way a real transaction would, then calling the post hook, all as
/// the Safe. Real-Safe end-to-end coverage is in SpotRiskGuardSafeEndToEnd.t.sol.
contract SpotRiskGuardTest is Test {
    SpotRiskGuard guard;
    MockToken usdt;
    MockToken usdc;
    MockToken wbnb;
    MockToken meme;

    address admin = address(0xA11CE);
    address account = address(0x5AFE);
    address anyRouter = address(0xBEEF); // never registered anywhere
    address allowedRouter = address(0xCAFE);
    address badSpender = address(0xBAD);
    address multiSendCallOnly = address(0x9641);
    address permit2 = address(0x9999);
    address wallet = address(0xA11);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdt = new MockToken();
        usdc = new MockToken();
        wbnb = new MockToken();
        meme = new MockToken();

        address[] memory base = new address[](3);
        base[0] = address(usdt);
        base[1] = address(usdc);
        base[2] = address(wbnb);
        address[] memory spenders = new address[](2);
        spenders[0] = allowedRouter;
        spenders[1] = permit2;
        guard = new SpotRiskGuard(admin, address(wbnb), multiSendCallOnly, permit2, base, spenders);

        vm.deal(account, 10 ether);
        usdt.mint(account, 1000e18);
        usdc.mint(account, 1000e18);
        wbnb.mint(account, 5e18);
        meme.mint(account, 1000e18);
    }

    // ---- helpers -----------------------------------------------------------------------

    function _pre(address to, uint256 value, bytes memory data) private {
        _preOp(to, value, data, Enum.Operation.Call);
    }

    function _preOp(address to, uint256 value, bytes memory data, Enum.Operation op) private {
        vm.prank(account);
        guard.checkTransaction(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }

    function _post() private {
        vm.prank(account);
        guard.checkAfterExecution(bytes32(0), true);
    }

    function _limits(uint256 buysPerDay, address token, uint256 cap) private {
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(account, buysPerDay);
        if (cap != 0) guard.setTokenLimit(account, token, cap);
        vm.stopPrank();
    }

    /// Simulates a buy that spends `amount` BNB through some unregistered contract.
    function _buyWithBnb(uint256 amount) private {
        _pre(anyRouter, amount, hex"deadbeef");
        vm.deal(account, account.balance - amount);
        meme.mint(account, 1e18);
        _post();
    }

    function _buyWithUsdt(uint256 amount) private {
        _pre(anyRouter, 0, hex"deadbeef");
        usdt.burn(account, amount);
        meme.mint(account, 1e18);
        _post();
    }

    /// Simulates selling meme tokens into BNB through an unregistered contract.
    function _sellForBnb(uint256 bnbReceived) private {
        _pre(anyRouter, 0, hex"deadbeef");
        meme.burn(account, 10e18);
        vm.deal(account, account.balance + bnbReceived);
        _post();
    }

    function _pack(uint8 op, address to, uint256 value, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(op, to, value, data.length, data);
    }

    function _multiSend(bytes memory packed) private pure returns (bytes memory) {
        return abi.encodeWithSignature("multiSend(bytes)", packed);
    }

    // ---- buys: amount, count, freeze ---------------------------------------------------

    function test_BuyWithinLimitsPassesAndIsCounted() public {
        _limits(2, address(0), 1 ether);
        _buyWithBnb(0.5 ether);
        (, uint256 buys) = guard.tradeState(account);
        assertEq(buys, 1);
    }

    function test_BuyOverTheAmountLimitReverts() public {
        _limits(2, address(0), 1 ether);
        _pre(anyRouter, 2 ether, hex"deadbeef");
        vm.deal(account, account.balance - 2 ether);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.TradeAmountExceeded.selector, address(0), 2 ether, 1 ether));
        _post();
    }

    function test_StablecoinSpendIsMeasuredAgainstItsOwnLimit() public {
        _limits(2, address(usdt), 10e18);
        _pre(anyRouter, 0, hex"deadbeef");
        usdt.burn(account, 50e18);
        vm.expectRevert(
            abi.encodeWithSelector(SpotRiskGuard.TradeAmountExceeded.selector, address(usdt), 50e18, 10e18)
        );
        _post();
    }

    function test_SecondBuyInOneDayRevertsWhenLimitIsOne() public {
        _limits(1, address(0), 1 ether);
        _buyWithBnb(0.1 ether);
        _pre(anyRouter, 0.1 ether, hex"deadbeef");
        vm.deal(account, account.balance - 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.TradeCountExceeded.selector, 2, 1));
        _post();
    }

    function test_BuyAllowanceResetsNextDay() public {
        _limits(1, address(0), 1 ether);
        _buyWithBnb(0.1 ether);
        vm.warp(block.timestamp + 1 days);
        _buyWithBnb(0.1 ether);
        (, uint256 buys) = guard.tradeState(account);
        assertEq(buys, 1);
    }

    function test_BuyWithoutConfiguredLimitsReverts() public {
        _pre(anyRouter, 0.1 ether, hex"deadbeef");
        vm.deal(account, account.balance - 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.LimitsNotConfigured.selector, account));
        _post();
    }

    function test_FrozenAccountCannotBuy() public {
        _limits(5, address(0), 1 ether);
        vm.prank(admin);
        guard.recordDailyLossBreach(account);
        _pre(anyRouter, 0.1 ether, hex"deadbeef");
        vm.deal(account, account.balance - 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.AccountIsFrozen.selector, account));
        _post();
    }

    function test_FreezeLiftsAutomaticallyNextUtcDay() public {
        _limits(5, address(0), 1 ether);
        vm.prank(admin);
        guard.recordDailyLossBreach(account);
        vm.warp(block.timestamp + 1 days);
        _buyWithBnb(0.1 ether);
    }

    function test_NeverFrozenAccountIsNotFrozenEvenNearTheEpoch() public {
        vm.warp(100); // block.timestamp / 1 days == 0, the same as the default frozenThroughDay
        assertFalse(guard.isFrozen(account));
    }

    function test_OnlyAdminCanRecordABreachAndNoFunctionLiftsIt() public {
        vm.expectRevert(SpotRiskGuard.NotAdmin.selector);
        guard.recordDailyLossBreach(account);

        vm.startPrank(admin);
        guard.recordDailyLossBreach(account);
        guard.recordDailyLossBreach(account); // idempotent, still frozen
        vm.stopPrank();
        assertTrue(guard.isFrozen(account));
    }

    // ---- sells and other non-spending actions are never limited ------------------------

    function test_SellIsNeverCountedOrLimitedEvenWithNoLimitsConfigured() public {
        _sellForBnb(0.3 ether); // no limits configured at all
        (, uint256 buys) = guard.tradeState(account);
        assertEq(buys, 0);
    }

    function test_SellWorksWhileFrozenAndAfterBuysAreUsedUp() public {
        _limits(1, address(0), 1 ether);
        _buyWithBnb(0.1 ether);
        vm.prank(admin);
        guard.recordDailyLossBreach(account);
        _sellForBnb(0.2 ether);
        _sellForBnb(0.2 ether);
        (, uint256 buys) = guard.tradeState(account);
        assertEq(buys, 1);
    }

    function test_SellIntoStablecoinIsAlsoNotABuy() public {
        _limits(1, address(0), 1 ether);
        vm.prank(admin);
        guard.recordDailyLossBreach(account);
        _pre(anyRouter, 0, hex"deadbeef");
        meme.burn(account, 10e18);
        usdt.mint(account, 5e18);
        _post();
    }

    function test_RotatingATokenIntoAnotherWithNoBaseSpentIsNotABuy() public {
        // Documented limit: no base asset spent, so not detected as a buy.
        vm.prank(admin);
        guard.recordDailyLossBreach(account);
        _pre(anyRouter, 0, hex"deadbeef");
        meme.burn(account, 10e18);
        _post();
    }

    function test_FailedTransactionIsIgnoredByThePostHook() public {
        _limits(1, address(0), 1 ether);
        _pre(anyRouter, 5 ether, hex"deadbeef");
        vm.deal(account, account.balance - 5 ether); // would violate, but the Safe tx failed
        vm.prank(account);
        guard.checkAfterExecution(bytes32(0), false);
        // and the snapshot is cleared, so the next transaction is not "nested"
        _buyWithBnb(0.1 ether);
    }

    // ---- withdrawals and exempt calls ---------------------------------------------------

    function test_WithdrawalsAreExemptEvenWhenFrozen() public {
        vm.prank(admin);
        guard.recordDailyLossBreach(account);

        _pre(wallet, 1 ether, "");
        vm.deal(account, account.balance - 1 ether);
        _post();

        _pre(address(usdt), 0, abi.encodeWithSignature("transfer(address,uint256)", wallet, 5e18));
        usdt.burn(account, 5e18);
        _post();
        (, uint256 buys) = guard.tradeState(account);
        assertEq(buys, 0);
    }

    // ---- withdrawal bookkeeping (read by the backend to separate withdrawals from losses) --------

    function test_WithdrawalsAreRecordedInTheRunningTotals() public {
        _pre(wallet, 1 ether, "");
        vm.deal(account, account.balance - 1 ether);
        _post();
        _pre(wallet, 0.5 ether, "");
        vm.deal(account, account.balance - 0.5 ether);
        _post();
        assertEq(guard.withdrawnTotal(account, address(0)), 1.5 ether);

        _pre(address(usdt), 0, abi.encodeWithSignature("transfer(address,uint256)", wallet, 7e18));
        usdt.burn(account, 7e18);
        _post();
        assertEq(guard.withdrawnTotal(account, address(usdt)), 7e18);
    }

    function test_TransferOfANonBaseTokenIsRecordedToo() public {
        _pre(address(meme), 0, abi.encodeWithSignature("transfer(address,uint256)", wallet, 40e18));
        meme.burn(account, 40e18);
        _post(); // spent no base asset, so it passes the outcome check
        assertEq(guard.withdrawnTotal(account, address(meme)), 40e18);
        (, uint256 buys) = guard.tradeState(account);
        assertEq(buys, 0);
    }

    function test_BatchedWithdrawalsAreRecorded() public {
        bytes memory packed = bytes.concat(
            _pack(0, wallet, 2 ether, ""),
            _pack(0, address(usdt), 0, abi.encodeWithSignature("transfer(address,uint256)", wallet, 3e18))
        );
        _preOp(multiSendCallOnly, 0, _multiSend(packed), Enum.Operation.DelegateCall);
        assertEq(guard.withdrawnTotal(account, address(0)), 2 ether);
        assertEq(guard.withdrawnTotal(account, address(usdt)), 3e18);
    }

    function test_TradesApprovalsAndWrapsAreNotCountedAsWithdrawals() public {
        _limits(5, address(0), 1 ether);
        _buyWithBnb(0.1 ether);
        _pre(address(usdt), 0, abi.encodeWithSignature("approve(address,uint256)", allowedRouter, 1e18));
        _pre(address(wbnb), 1 ether, abi.encodeWithSignature("deposit()"));
        assertEq(guard.withdrawnTotal(account, address(0)), 0);
        assertEq(guard.withdrawnTotal(account, address(usdt)), 0);
    }

    function test_WrapAndUnwrapAreAllowed() public {
        _pre(address(wbnb), 1 ether, abi.encodeWithSignature("deposit()"));
        _pre(address(wbnb), 0, abi.encodeWithSignature("withdraw(uint256)", 1 ether));
    }

    function test_BlockedCallToABaseTokenWithAnUnlistedFunction() public {
        bytes memory data = abi.encodeWithSignature("increaseAllowance(address,uint256)", badSpender, 1e18);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.BlockedCall.selector, address(usdt), bytes4(data)));
        _pre(address(usdt), 0, data);
    }

    // ---- approvals ---------------------------------------------------------------------

    function test_ApproveBaseTokenToAllowlistedSpenderIsAllowed() public {
        _pre(address(usdt), 0, abi.encodeWithSignature("approve(address,uint256)", allowedRouter, 1e30));
    }

    function test_ApproveBaseTokenToUnknownSpenderReverts() public {
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.SpenderNotAllowed.selector, address(usdt), badSpender));
        _pre(address(usdt), 0, abi.encodeWithSignature("approve(address,uint256)", badSpender, 1e30));
    }

    function test_RevokingAnApprovalIsAlwaysAllowed() public {
        _pre(address(usdt), 0, abi.encodeWithSignature("approve(address,uint256)", badSpender, 0));
    }

    function test_ApprovingANonBaseTokenToAnySpenderIsAllowed() public {
        // Selling a meme coin needs approving it to whichever router; that token is not "money".
        _pre(address(meme), 0, abi.encodeWithSignature("approve(address,uint256)", badSpender, 1e30));
        _post();
    }

    function test_Permit2ApproveFollowsTheSameSpenderRule() public {
        _pre(
            permit2,
            0,
            abi.encodeWithSignature("approve(address,address,uint160,uint48)", address(usdt), allowedRouter, uint160(1e18), uint48(block.timestamp + 1 hours))
        );
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.SpenderNotAllowed.selector, permit2, badSpender));
        _pre(
            permit2,
            0,
            abi.encodeWithSignature("approve(address,address,uint160,uint48)", address(usdt), badSpender, uint160(1e18), uint48(block.timestamp + 1 hours))
        );
    }

    function test_OtherPermit2CallsAreBlocked() public {
        bytes memory data = abi.encodeWithSignature("transferFrom(address,address,uint160,address)", account, wallet, uint160(1), address(usdt));
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.BlockedCall.selector, permit2, bytes4(data)));
        _pre(permit2, 0, data);
    }

    // ---- Safe management calls ----------------------------------------------------------

    function test_EnableModuleAndSetFallbackHandlerAreBlocked() public {
        bytes memory enable = abi.encodeWithSignature("enableModule(address)", badSpender);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.BlockedCall.selector, account, bytes4(enable)));
        _pre(account, 0, enable);

        bytes memory handler = abi.encodeWithSignature("setFallbackHandler(address)", badSpender);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.BlockedCall.selector, account, bytes4(handler)));
        _pre(account, 0, handler);
    }

    function test_OwnerManagementIsAllowed() public {
        _pre(account, 0, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", wallet, 1));
        _pre(account, 0, abi.encodeWithSignature("changeThreshold(uint256)", 1));
    }

    function test_SetGuardNeedsARequestAndTheCooldown() public {
        bytes memory data = abi.encodeWithSignature("setGuard(address)", address(0));
        vm.expectRevert();
        _pre(account, 0, data);

        vm.prank(account);
        guard.requestRemoval();
        vm.warp(block.timestamp + 23 hours);
        vm.expectRevert();
        _pre(account, 0, data);

        vm.warp(block.timestamp + 2 hours);
        _pre(account, 0, data);
        assertEq(guard.removalRequestedAt(account), 0);
    }

    function test_SetGuardBlockedWhileFrozenEvenAfterTheCooldown() public {
        vm.prank(account);
        guard.requestRemoval();
        vm.warp(block.timestamp + 25 hours);
        vm.prank(admin);
        guard.recordDailyLossBreach(account);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.GuardRemovalBlockedWhileFrozen.selector, account));
        _pre(account, 0, abi.encodeWithSignature("setGuard(address)", address(0)));
    }

    function test_CancelRemovalResetsTheCooldown() public {
        vm.startPrank(account);
        guard.requestRemoval();
        guard.cancelRemoval();
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _pre(account, 0, abi.encodeWithSignature("setGuard(address)", address(0)));
    }

    function test_AccountCanCallRequestRemovalButNotAdminFunctions() public {
        _pre(address(guard), 0, abi.encodeWithSignature("requestRemoval()"));
        bytes memory data = abi.encodeWithSignature("setMaxTradesPerDay(address,uint256)", account, 1000);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.BlockedCall.selector, address(guard), bytes4(data)));
        _pre(address(guard), 0, data);
    }

    // ---- delegatecall and MultiSend -----------------------------------------------------

    function test_DelegateCallToAnythingElseReverts() public {
        vm.expectRevert(SpotRiskGuard.DelegateCallNotAllowed.selector);
        _preOp(anyRouter, 0, "", Enum.Operation.DelegateCall);
    }

    function test_MultiSendBatchOfApproveAndSwapIsAllowed() public {
        _limits(2, address(0), 1 ether);
        bytes memory packed = bytes.concat(
            _pack(0, address(usdt), 0, abi.encodeWithSignature("approve(address,uint256)", allowedRouter, 1e30)),
            _pack(0, anyRouter, 0.1 ether, hex"deadbeef")
        );
        _preOp(multiSendCallOnly, 0, _multiSend(packed), Enum.Operation.DelegateCall);
        vm.deal(account, account.balance - 0.1 ether);
        meme.mint(account, 1e18);
        _post();
        (, uint256 buys) = guard.tradeState(account);
        assertEq(buys, 1);
    }

    function test_MultiSendOfOnlyExemptCallsNeedsNoOutcomeCheck() public {
        vm.prank(admin);
        guard.recordDailyLossBreach(account);
        bytes memory packed = bytes.concat(
            _pack(0, address(usdt), 0, abi.encodeWithSignature("approve(address,uint256)", allowedRouter, 1e30)),
            _pack(0, wallet, 1 ether, "")
        );
        _preOp(multiSendCallOnly, 0, _multiSend(packed), Enum.Operation.DelegateCall);
        vm.deal(account, account.balance - 1 ether); // a withdrawal: not a buy, even while frozen
        _post();
    }

    function test_MultiSendInnerBadApprovalReverts() public {
        bytes memory packed = bytes.concat(
            _pack(0, anyRouter, 0.1 ether, hex"deadbeef"),
            _pack(0, address(usdt), 0, abi.encodeWithSignature("approve(address,uint256)", badSpender, 1e30))
        );
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.SpenderNotAllowed.selector, address(usdt), badSpender));
        _preOp(multiSendCallOnly, 0, _multiSend(packed), Enum.Operation.DelegateCall);
    }

    function test_MultiSendCannotSmuggleEnableModuleOrSetGuard() public {
        bytes memory enable = _pack(0, account, 0, abi.encodeWithSignature("enableModule(address)", badSpender));
        vm.expectRevert();
        _preOp(multiSendCallOnly, 0, _multiSend(enable), Enum.Operation.DelegateCall);

        vm.prank(account);
        guard.requestRemoval();
        vm.warp(block.timestamp + 25 hours);
        bytes memory setGuard = _pack(0, account, 0, abi.encodeWithSignature("setGuard(address)", address(0)));
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.BlockedCall.selector, account, bytes4(keccak256("setGuard(address)"))));
        _preOp(multiSendCallOnly, 0, _multiSend(setGuard), Enum.Operation.DelegateCall);
    }

    function test_MultiSendInnerDelegateCallOrMalformedPayloadReverts() public {
        bytes memory inner = _pack(1, anyRouter, 0, hex"deadbeef");
        vm.expectRevert(SpotRiskGuard.DelegateCallNotAllowed.selector);
        _preOp(multiSendCallOnly, 0, _multiSend(inner), Enum.Operation.DelegateCall);

        bytes memory truncated = abi.encodePacked(uint8(0), anyRouter, uint256(0), uint256(100), hex"aabb");
        vm.expectRevert(SpotRiskGuard.MalformedMultiSend.selector);
        _preOp(multiSendCallOnly, 0, _multiSend(truncated), Enum.Operation.DelegateCall);
    }

    function test_DelegateCallToMultiSendWithAnotherFunctionReverts() public {
        vm.expectRevert(SpotRiskGuard.DelegateCallNotAllowed.selector);
        _preOp(multiSendCallOnly, 0, abi.encodeWithSignature("somethingElse()"), Enum.Operation.DelegateCall);
    }

    // ---- nesting, modules, admin ---------------------------------------------------------

    function test_NestedExecutionForTheSameSafeReverts() public {
        _limits(5, address(0), 1 ether);
        _pre(anyRouter, 0.1 ether, hex"deadbeef");
        vm.expectRevert(SpotRiskGuard.NestedExecution.selector);
        _pre(anyRouter, 0.1 ether, hex"deadbeef");
    }

    function test_ModuleTransactionsAreRejected() public {
        vm.prank(account);
        vm.expectRevert(SpotRiskGuard.ModulesNotAllowed.selector);
        guard.checkModuleTransaction(anyRouter, 0, hex"deadbeef", Enum.Operation.Call, address(0xD00D));
    }

    function test_OnlyAdminCanConfigure() public {
        vm.expectRevert(SpotRiskGuard.NotAdmin.selector);
        guard.setTokenLimit(account, address(0), 1);
        vm.expectRevert(SpotRiskGuard.NotAdmin.selector);
        guard.setMaxTradesPerDay(account, 1);
        vm.expectRevert(SpotRiskGuard.NotAdmin.selector);
        guard.setAllowedSpender(badSpender, true);
        vm.expectRevert(SpotRiskGuard.NotAdmin.selector);
        guard.addTrackedAsset(address(meme));
    }

    function test_AllowlistAndTrackedAssetsCanGrowButNeverShrink() public {
        vm.startPrank(admin);
        guard.setAllowedSpender(badSpender, true);
        guard.addTrackedAsset(address(meme));
        vm.stopPrank();
        assertTrue(guard.allowedSpender(badSpender));
        assertTrue(guard.isTrackedToken(address(meme)));
        assertEq(guard.trackedAssets().length, 5); // native + usdt + usdc + wbnb + meme

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.AlreadyTracked.selector, address(meme)));
        guard.addTrackedAsset(address(meme));
    }

    function test_TrackedAssetsAreCapped() public {
        vm.startPrank(admin);
        for (uint256 i = guard.trackedAssets().length; i < guard.MAX_TRACKED_ASSETS(); i++) {
            guard.addTrackedAsset(address(uint160(0x1000 + i)));
        }
        vm.expectRevert(SpotRiskGuard.TooManyTrackedAssets.selector);
        guard.addTrackedAsset(address(0xFFFF));
        vm.stopPrank();
    }

    function test_SupportsTheSafeGuardInterfaces() public view {
        assertTrue(guard.supportsInterface(0xe6d7a83a));
        assertTrue(guard.supportsInterface(0x01ffc9a7));
    }
}
