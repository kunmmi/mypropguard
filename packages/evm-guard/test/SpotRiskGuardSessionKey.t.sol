// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SpotRiskGuard} from "../src/SpotRiskGuard.sol";
import {Safe} from "safe-smart-account/contracts/Safe.sol";
import {SafeProxyFactory} from "safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import {MultiSendCallOnly} from "safe-smart-account/contracts/libraries/MultiSendCallOnly.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Session keys on a real Safe v1.4.1 (the production version) with real ECDSA signatures.
/// A session key is a Safe owner that signs trades without a prompt. These tests prove it can TRADE
/// (inside every limit) and can do NOTHING else: no withdrawals, no owner changes, no Guard changes,
/// no moving non-base tokens - while the trader's own key keeps its full, normal powers.
contract SpotRiskGuardSessionKeyTest is Test {
    address constant V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant SMART_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address constant PERMIT2 = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address constant CAKE = 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82;
    address constant SAFE_SINGLETON_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_PROXY_FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant MULTISEND_CALL_ONLY_141 = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;

    Safe safe;
    SpotRiskGuard guard;
    MultiSendCallOnly multiSend;

    address trader;
    address sessionKey;
    uint256 sessionPk;
    address admin = address(0xADD1);
    address thief = address(0xBAD);

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.binance.org"));
        vm.createSelectFork(rpcUrl);
        (trader,) = makeAddrAndKey("trader");
        (sessionKey, sessionPk) = makeAddrAndKey("session");

        multiSend = MultiSendCallOnly(MULTISEND_CALL_ONLY_141);
        address[] memory owners = new address[](1);
        owners[0] = trader;
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector, owners, uint256(1), address(0), bytes(""), address(0), address(0), uint256(0), payable(address(0))
        );
        safe = Safe(payable(address(SafeProxyFactory(SAFE_PROXY_FACTORY_141).createProxyWithNonce(SAFE_SINGLETON_141, initializer, 0))));

        address[] memory base = new address[](4);
        base[0] = USDT;
        base[1] = USDC;
        base[2] = BUSD;
        base[3] = WBNB;
        address[] memory spenders = new address[](3);
        spenders[0] = V2_ROUTER;
        spenders[1] = SMART_ROUTER;
        spenders[2] = PERMIT2;
        guard = new SpotRiskGuard(admin, WBNB, address(multiSend), PERMIT2, base, spenders);

        ownerExec(address(safe), 0, abi.encodeWithSignature("setGuard(address)", address(guard)), Enum.Operation.Call);

        vm.startPrank(admin);
        guard.setMaxTradesPerDay(address(safe), 3);
        guard.setTokenLimit(address(safe), address(0), 1 ether);
        guard.setTokenLimit(address(safe), USDT, 100e18);
        vm.stopPrank();

        // The one-time setup the trader approves: mark the key, then make it an owner (threshold stays 1).
        ownerExec(address(guard), 0, abi.encodeWithSignature("addSessionKey(address)", sessionKey), Enum.Operation.Call);
        ownerExec(address(safe), 0, abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", sessionKey, 1), Enum.Operation.Call);

        vm.deal(address(safe), 3 ether);
        deal(USDT, address(safe), 500e18);
    }

    // ---- what a session key CAN do ---------------------------------------------------------

    function test_SessionKeyCanBuyWithinTheLimitsWithoutTheTraderSigning() public {
        sessionExec(V2_ROUTER, 0.5 ether, _swapBnbForCake(), Enum.Operation.Call);
        assertGt(IERC20(CAKE).balanceOf(address(safe)), 0, "no CAKE received");
        (, uint256 buys) = guard.tradeState(address(safe));
        assertEq(buys, 1);
    }

    function test_SessionKeyIsStillHeldToTheBuyCap() public {
        bytes memory data = _swapBnbForCake();
        bytes memory sig = _sessionSignature(V2_ROUTER, 2 ether, data, Enum.Operation.Call);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.TradeAmountExceeded.selector, address(0), 2 ether, 1 ether));
        safe.execTransaction(V2_ROUTER, 2 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function test_SessionKeyIsStillHeldToTheDailyBuyCount() public {
        sessionExec(V2_ROUTER, 0.1 ether, _swapBnbForCake(), Enum.Operation.Call);
        sessionExec(V2_ROUTER, 0.1 ether, _swapBnbForCake(), Enum.Operation.Call);
        sessionExec(V2_ROUTER, 0.1 ether, _swapBnbForCake(), Enum.Operation.Call);
        bytes memory data = _swapBnbForCake();
        bytes memory sig = _sessionSignature(V2_ROUTER, 0.1 ether, data, Enum.Operation.Call);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.TradeCountExceeded.selector, 4, 3));
        safe.execTransaction(V2_ROUTER, 0.1 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function test_SessionKeyCanApproveAnAllowlistedRouterAndSellWhileFrozen() public {
        sessionExec(V2_ROUTER, 0.5 ether, _swapBnbForCake(), Enum.Operation.Call);
        uint256 cake = IERC20(CAKE).balanceOf(address(safe));
        vm.prank(admin);
        guard.recordDailyLossBreach(address(safe));

        sessionExec(CAKE, 0, abi.encodeWithSignature("approve(address,uint256)", V2_ROUTER, cake), Enum.Operation.Call);
        address[] memory path = new address[](2);
        path[0] = CAKE;
        path[1] = WBNB;
        uint256 before = address(safe).balance;
        sessionExec(
            V2_ROUTER,
            0,
            abi.encodeWithSignature("swapExactTokensForETH(uint256,uint256,address[],address,uint256)", cake, 0, path, address(safe), block.timestamp + 300),
            Enum.Operation.Call
        );
        assertGt(address(safe).balance, before, "the sell paid nothing");

        // ...but a new buy stays blocked while frozen.
        bytes memory data = _swapBnbForCake();
        bytes memory sig = _sessionSignature(V2_ROUTER, 0.1 ether, data, Enum.Operation.Call);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.AccountIsFrozen.selector, address(safe)));
        safe.execTransaction(V2_ROUTER, 0.1 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function test_SessionKeyCanTradeInOneBatchedApproveAndSwap() public {
        bytes memory approve = abi.encodeWithSignature("approve(address,uint256)", SMART_ROUTER, 50e18);
        bytes memory swap = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            USDT, WBNB, uint24(500), address(safe), 50e18, uint256(0), uint160(0)
        );
        bytes memory batch = abi.encodeWithSignature("multiSend(bytes)", bytes.concat(_pack(USDT, 0, approve), _pack(SMART_ROUTER, 0, swap)));
        sessionExec(address(multiSend), 0, batch, Enum.Operation.DelegateCall);
        (, uint256 buys) = guard.tradeState(address(safe));
        assertEq(buys, 1);
    }

    // ---- what a session key can NOT do ------------------------------------------------------

    function test_SessionKeyCannotWithdrawBnb() public {
        sessionBlocked(thief, bytes4(0), thief, 1 ether, "", Enum.Operation.Call);
    }

    function test_SessionKeyCannotTransferABaseToken() public {
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", thief, 100e18);
        sessionBlocked(USDT, bytes4(keccak256("transfer(address,uint256)")), USDT, 0, data, Enum.Operation.Call);
    }

    function test_SessionKeyCannotTransferANonBaseToken() public {
        sessionExec(V2_ROUTER, 0.5 ether, _swapBnbForCake(), Enum.Operation.Call);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", thief, 1e18);
        sessionBlocked(CAKE, bytes4(keccak256("transfer(address,uint256)")), CAKE, 0, data, Enum.Operation.Call);
    }

    function test_SessionKeyCannotApproveANonBaseTokenToAStranger() public {
        sessionExec(V2_ROUTER, 0.5 ether, _swapBnbForCake(), Enum.Operation.Call);
        bytes memory data = abi.encodeWithSignature("approve(address,uint256)", thief, 1e18);
        sessionBlocked(CAKE, bytes4(keccak256("approve(address,uint256)")), CAKE, 0, data, Enum.Operation.Call);
    }

    function test_SessionKeyCannotGiveBlanketNftAccess() public {
        bytes memory data = abi.encodeWithSignature("setApprovalForAll(address,bool)", thief, true);
        sessionBlocked(CAKE, bytes4(keccak256("setApprovalForAll(address,bool)")), CAKE, 0, data, Enum.Operation.Call);
    }

    function test_SessionKeyCannotChangeOwnersOrThreshold() public {
        bytes memory data = abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", thief, 1);
        sessionBlocked(address(safe), bytes4(keccak256("addOwnerWithThreshold(address,uint256)")), address(safe), 0, data, Enum.Operation.Call);

        data = abi.encodeWithSignature("removeOwner(address,address,uint256)", address(1), sessionKey, 1);
        sessionBlocked(address(safe), bytes4(keccak256("removeOwner(address,address,uint256)")), address(safe), 0, data, Enum.Operation.Call);
    }

    function test_SessionKeyCannotDetachOrConfigureTheGuard() public {
        bytes memory data = abi.encodeWithSignature("setGuard(address)", address(0));
        sessionBlocked(address(safe), bytes4(keccak256("setGuard(address)")), address(safe), 0, data, Enum.Operation.Call);

        data = abi.encodeWithSignature("addSessionKey(address)", thief);
        sessionBlocked(address(guard), bytes4(keccak256("addSessionKey(address)")), address(guard), 0, data, Enum.Operation.Call);

        data = abi.encodeWithSignature("removeSessionKey(address)", sessionKey);
        sessionBlocked(address(guard), bytes4(keccak256("removeSessionKey(address)")), address(guard), 0, data, Enum.Operation.Call);
    }

    function test_SessionKeyCannotSmuggleAWithdrawalInsideABatch() public {
        bytes memory approve = abi.encodeWithSignature("approve(address,uint256)", SMART_ROUTER, 50e18);
        bytes memory steal = abi.encodeWithSignature("transfer(address,uint256)", thief, 100e18);
        bytes memory batch = abi.encodeWithSignature("multiSend(bytes)", bytes.concat(_pack(USDT, 0, approve), _pack(USDT, 0, steal)));
        sessionBlocked(USDT, bytes4(keccak256("transfer(address,uint256)")), address(multiSend), 0, batch, Enum.Operation.DelegateCall);
    }

    function test_SessionKeyCannotSmuggleANativeSendInsideABatch() public {
        bytes memory batch = abi.encodeWithSignature("multiSend(bytes)", _pack(thief, 1 ether, ""));
        sessionBlocked(thief, bytes4(0), address(multiSend), 0, batch, Enum.Operation.DelegateCall);
    }

    // ---- the signature formats a session key might use all get recognised ---------------------

    function test_AnEthSignStyleSignatureFromTheSessionKeyIsStillRecognised() public {
        bytes32 txHash = _hash(thief, 1 ether, "", Enum.Operation.Call);
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", txHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, prefixed);
        bytes memory sig = abi.encodePacked(r, s, uint8(v + 4));
        _expectBlocked(thief, bytes4(0));
        safe.execTransaction(thief, 1 ether, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function test_APreApprovedHashFromTheSessionKeyIsStillRecognised() public {
        bytes32 txHash = _hash(thief, 1 ether, "", Enum.Operation.Call);
        vm.prank(sessionKey);
        safe.approveHash(txHash);
        bytes memory sig = abi.encodePacked(uint256(uint160(sessionKey)), uint256(0), uint8(1));
        _expectBlocked(thief, bytes4(0));
        safe.execTransaction(thief, 1 ether, "", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    // ---- the trader's own key is untouched ----------------------------------------------------

    function test_TraderKeyCanStillWithdrawAndManageTheSafe() public {
        uint256 before = thief.balance;
        ownerExec(thief, 1 ether, "", Enum.Operation.Call);
        assertEq(thief.balance - before, 1 ether);

        ownerExec(USDT, 0, abi.encodeWithSignature("transfer(address,uint256)", thief, 100e18), Enum.Operation.Call);
        assertEq(IERC20(USDT).balanceOf(thief), 100e18);

        // Removing the session key as an owner and un-marking it, both on the trader's say-so.
        ownerExec(address(guard), 0, abi.encodeWithSignature("removeSessionKey(address)", sessionKey), Enum.Operation.Call);
        ownerExec(address(safe), 0, abi.encodeWithSignature("removeOwner(address,address,uint256)", address(1), sessionKey, 1), Enum.Operation.Call);
        assertFalse(safe.isOwner(sessionKey));
        assertEq(guard.sessionKeyCount(address(safe)), 0);
    }

    function test_AnAccountWithNoSessionKeysIsJudgedExactlyAsBefore() public {
        address[] memory owners = new address[](1);
        owners[0] = trader;
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector, owners, uint256(1), address(0), bytes(""), address(0), address(0), uint256(0), payable(address(0))
        );
        Safe plain = Safe(payable(address(SafeProxyFactory(SAFE_PROXY_FACTORY_141).createProxyWithNonce(SAFE_SINGLETON_141, initializer, 77))));
        bytes memory setGuardData = abi.encodeWithSignature("setGuard(address)", address(guard));
        _ownerExecOn(plain, address(plain), 0, setGuardData, Enum.Operation.Call);
        vm.deal(address(plain), 1 ether);
        uint256 before = thief.balance;
        _ownerExecOn(plain, thief, 0.5 ether, "", Enum.Operation.Call);
        assertEq(thief.balance - before, 0.5 ether);
    }

    // ---- helpers --------------------------------------------------------------------------

    function _expectBlocked(address to, bytes4 selector) private {
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.SessionKeyBlocked.selector, to, selector));
    }

    function _hash(address to, uint256 value, bytes memory data, Enum.Operation op) private view returns (bytes32) {
        return _hashOn(safe, to, value, data, op);
    }

    function _hashOn(Safe target, address to, uint256 value, bytes memory data, Enum.Operation op)
        private
        view
        returns (bytes32)
    {
        uint256 n = target.nonce();
        return target.getTransactionHash(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), n);
    }

    function _sessionSignature(address to, uint256 value, bytes memory data, Enum.Operation op)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, _hash(to, value, data, op));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Signed by the session key and sent by an unrelated address, the way a relayer would.
    function sessionExec(address to, uint256 value, bytes memory data, Enum.Operation op) internal {
        bytes memory sig = _sessionSignature(to, value, data, op);
        bool ok = safe.execTransaction(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), sig);
        require(ok, "Safe execTransaction failed unexpectedly");
    }

    /// @dev A session-signed transaction that the Guard must reject as SessionKeyBlocked(blockedTo, blockedSelector).
    /// The signature is built first so the revert expectation lands on the execTransaction call itself.
    function sessionBlocked(address blockedTo, bytes4 blockedSelector, address to, uint256 value, bytes memory data, Enum.Operation op)
        internal
    {
        bytes memory sig = _sessionSignature(to, value, data, op);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.SessionKeyBlocked.selector, blockedTo, blockedSelector));
        safe.execTransaction(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function ownerExec(address to, uint256 value, bytes memory data, Enum.Operation op) internal {
        _ownerExecOn(safe, to, value, data, op);
    }

    function _ownerExecOn(Safe target, address to, uint256 value, bytes memory data, Enum.Operation op) private {
        bytes32 txHash = _hashOn(target, to, value, data, op);
        vm.prank(trader);
        target.approveHash(txHash);
        bytes memory sig = abi.encodePacked(uint256(uint160(trader)), uint256(0), uint8(1));
        vm.prank(trader);
        bool ok = target.execTransaction(to, value, data, op, 0, 0, 0, address(0), payable(address(0)), sig);
        require(ok, "Safe execTransaction failed unexpectedly");
    }

    function _swapBnbForCake() private view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = CAKE;
        return abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, address(safe), block.timestamp + 300
        );
    }

    function _pack(address to, uint256 value, bytes memory data) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(0), to, value, data.length, data);
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}
