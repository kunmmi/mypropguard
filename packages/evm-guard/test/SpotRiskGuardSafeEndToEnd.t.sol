// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SpotRiskGuard} from "../src/SpotRiskGuard.sol";
import {Safe} from "safe-smart-account/contracts/Safe.sol";
import {SafeProxyFactory} from "safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import {MultiSendCallOnly} from "safe-smart-account/contracts/libraries/MultiSendCallOnly.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice The outcome-based Guard on a real Safe v1.4.1 (the production version), against real PancakeSwap contracts on a BSC
/// fork. The point of these tests is that NO router is registered with the Guard: the V2 router and
/// the Smart Router are both traded through, and the rules still bite, because they measure what
/// the Safe's balances do.
contract SpotRiskGuardSafeEndToEndTest is Test {
    address constant V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant SMART_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address constant UNIVERSAL_ROUTER = 0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB;
    address constant PERMIT2 = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address constant CAKE = 0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82;
    address constant SAFE_SINGLETON_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762; // SafeL2 v1.4.1: the variant Safe{Wallet} supports on BNB Chain
    address constant SAFE_PROXY_FACTORY_141 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address constant MULTISEND_CALL_ONLY_141 = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;

    Safe safe;
    SpotRiskGuard guard;
    MultiSendCallOnly multiSend;

    address trader;
    address admin = address(0xADD1);

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.binance.org"));
        vm.createSelectFork(rpcUrl);
        (trader,) = makeAddrAndKey("trader");

        // The REAL Safe v1.4.1 contracts deployed on BSC - the same code production Safes run - rather
        // than the vendored v1.5.0 source, so this proves the Guard against the production version.
        address singleton = SAFE_SINGLETON_141;
        SafeProxyFactory factory = SafeProxyFactory(SAFE_PROXY_FACTORY_141);
        multiSend = MultiSendCallOnly(MULTISEND_CALL_ONLY_141);

        address[] memory owners = new address[](1);
        owners[0] = trader;
        // No fallback handler, exactly like MyPropGuard's provisioning: the Safe cannot validate
        // off-chain signatures (EIP-1271), so Permit2 permits cannot grant allowances.
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector, owners, uint256(1), address(0), bytes(""), address(0), address(0), uint256(0), payable(address(0))
        );
        safe = Safe(payable(address(factory.createProxyWithNonce(singleton, initializer, 0))));

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

        _exec(address(safe), 0, abi.encodeWithSignature("setGuard(address)", address(guard)), Enum.Operation.Call);

        vm.startPrank(admin);
        guard.setMaxTradesPerDay(address(safe), 3);
        guard.setTokenLimit(address(safe), address(0), 1 ether);
        guard.setTokenLimit(address(safe), USDT, 100e18);
        vm.stopPrank();

        vm.deal(address(safe), 3 ether);
        deal(USDT, address(safe), 500e18);
    }

    // ---- buying through two different routers, neither registered ------------------------

    function test_BuyOnTheV2RouterWithBnbWorks() public {
        _exec(V2_ROUTER, 0.5 ether, _swapBnbForCake(), Enum.Operation.Call);
        assertGt(IERC20(CAKE).balanceOf(address(safe)), 0, "no CAKE received");
        (, uint256 buys) = guard.tradeState(address(safe));
        assertEq(buys, 1);
    }

    function test_BuyOverTheBnbCapIsRevertedByTheGuard() public {
        bytes memory data = _swapBnbForCake();
        bytes memory signature = _approveAndSign(V2_ROUTER, 2 ether, data, Enum.Operation.Call);
        vm.expectRevert(
            abi.encodeWithSelector(SpotRiskGuard.TradeAmountExceeded.selector, address(0), 2 ether, 1 ether)
        );
        vm.prank(trader);
        safe.execTransaction(V2_ROUTER, 2 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
        assertEq(IERC20(CAKE).balanceOf(address(safe)), 0);
    }

    function test_SmartRouterTradeInOneBatchedApproveAndSwapWorks() public {
        // A different router than the V2 one, and approve+swap batched in a single Safe transaction
        // through the real MultiSendCallOnly - the shape most trading sites send.
        bytes memory approve = abi.encodeWithSignature("approve(address,uint256)", SMART_ROUTER, 50e18);
        bytes memory swap = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            USDT,
            WBNB,
            uint24(500),
            address(safe),
            50e18,
            uint256(0),
            uint160(0)
        );
        bytes memory packed = bytes.concat(_pack(USDT, 0, approve), _pack(SMART_ROUTER, 0, swap));
        uint256 usdtBefore = IERC20(USDT).balanceOf(address(safe));
        _exec(address(multiSend), 0, abi.encodeWithSignature("multiSend(bytes)", packed), Enum.Operation.DelegateCall);

        assertEq(usdtBefore - IERC20(USDT).balanceOf(address(safe)), 50e18, "USDT not spent");
        (, uint256 buys) = guard.tradeState(address(safe));
        assertEq(buys, 1);
    }

    function test_SmartRouterTradeOverTheUsdtCapIsReverted() public {
        bytes memory approve = abi.encodeWithSignature("approve(address,uint256)", SMART_ROUTER, 300e18);
        bytes memory swap = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            USDT, WBNB, uint24(500), address(safe), 300e18, uint256(0), uint160(0)
        );
        bytes memory data = abi.encodeWithSignature("multiSend(bytes)", bytes.concat(_pack(USDT, 0, approve), _pack(SMART_ROUTER, 0, swap)));
        bytes memory signature = _approveAndSign(address(multiSend), 0, data, Enum.Operation.DelegateCall);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.TradeAmountExceeded.selector, USDT, 300e18, 100e18));
        vm.prank(trader);
        safe.execTransaction(address(multiSend), 0, data, Enum.Operation.DelegateCall, 0, 0, 0, address(0), payable(address(0)), signature);
    }


    function test_PancakeSwapUniversalRouterBnbBuyWorksWithoutAnyRegistration() public {
        // What pancakeswap.finance sends: Universal Router execute(commands, inputs, deadline), here
        // WRAP_ETH then V3_SWAP_EXACT_IN (WBNB -> CAKE, 0.25% pool). The Guard never decodes it.
        bytes memory commands = hex"0b00";
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(address(2), uint256(0.3 ether)); // ADDRESS_THIS, amount to wrap
        inputs[1] = abi.encode(address(1), uint256(1 << 255), uint256(0), abi.encodePacked(WBNB, uint24(2500), CAKE), false);
        bytes memory data = abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 300);

        _exec(UNIVERSAL_ROUTER, 0.3 ether, data, Enum.Operation.Call);
        assertGt(IERC20(CAKE).balanceOf(address(safe)), 0, "no CAKE received");
        (, uint256 buys) = guard.tradeState(address(safe));
        assertEq(buys, 1);
    }

    function test_UniversalRouterBuyOverTheCapIsReverted() public {
        bytes memory commands = hex"0b00";
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = abi.encode(address(2), uint256(2 ether));
        inputs[1] = abi.encode(address(1), uint256(1 << 255), uint256(0), abi.encodePacked(WBNB, uint24(2500), CAKE), false);
        bytes memory data = abi.encodeWithSignature("execute(bytes,bytes[],uint256)", commands, inputs, block.timestamp + 300);
        bytes memory signature = _approveAndSign(UNIVERSAL_ROUTER, 2 ether, data, Enum.Operation.Call);
        vm.expectRevert(
            abi.encodeWithSelector(SpotRiskGuard.TradeAmountExceeded.selector, address(0), 2 ether, 1 ether)
        );
        vm.prank(trader);
        safe.execTransaction(UNIVERSAL_ROUTER, 2 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
    }

    // ---- freeze: sells and withdrawals work, buys do not -----------------------------------

    function test_WhileFrozenSellingBackToBnbWorksButBuyingDoesNot() public {
        _exec(V2_ROUTER, 0.5 ether, _swapBnbForCake(), Enum.Operation.Call); // acquire some CAKE first
        uint256 cake = IERC20(CAKE).balanceOf(address(safe));
        vm.prank(admin);
        guard.recordDailyLossBreach(address(safe));

        // Sell the CAKE back: approve, then swapExactTokensForETH - both allowed while frozen.
        _exec(CAKE, 0, abi.encodeWithSignature("approve(address,uint256)", V2_ROUTER, cake), Enum.Operation.Call);
        address[] memory path = new address[](2);
        path[0] = CAKE;
        path[1] = WBNB;
        uint256 bnbBefore = address(safe).balance;
        _exec(
            V2_ROUTER,
            0,
            abi.encodeWithSignature("swapExactTokensForETH(uint256,uint256,address[],address,uint256)", cake, 0, path, address(safe), block.timestamp + 300),
            Enum.Operation.Call
        );
        assertGt(address(safe).balance, bnbBefore, "sell paid no BNB");
        (, uint256 buys) = guard.tradeState(address(safe));
        assertEq(buys, 1, "the sell must not count as a buy");

        // A new buy is blocked.
        bytes memory data = _swapBnbForCake();
        bytes memory signature = _approveAndSign(V2_ROUTER, 0.1 ether, data, Enum.Operation.Call);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.AccountIsFrozen.selector, address(safe)));
        vm.prank(trader);
        safe.execTransaction(V2_ROUTER, 0.1 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
    }

    function test_WithdrawingWhileFrozenAlwaysWorks() public {
        vm.prank(admin);
        guard.recordDailyLossBreach(address(safe));
        uint256 before = trader.balance;
        _exec(trader, 1 ether, "", Enum.Operation.Call);
        assertEq(trader.balance - before, 1 ether);
        assertEq(guard.withdrawnTotal(address(safe), address(0)), 1 ether, "withdrawal not recorded");
    }


    function test_ProvisionedTheProductionWayTheGuardIsAttachedFromCreation() public {
        // Exactly how the backend creates accounts: Safe setup() delegatecalls the already-deployed
        // SafeGuardSetup, which calls setGuard, so the Safe is born with this Guard attached.
        address safeGuardSetup = 0xf29B5EBec90B34fdf3489a7C4A3D2acdAc957067;
        address[] memory owners = new address[](1);
        owners[0] = trader;
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector,
            owners,
            uint256(1),
            safeGuardSetup,
            abi.encodeWithSignature("setupGuard(address)", address(guard)),
            address(0),
            address(0),
            uint256(0),
            payable(address(0))
        );
        Safe provisioned = Safe(
            payable(address(SafeProxyFactory(SAFE_PROXY_FACTORY_141).createProxyWithNonce(SAFE_SINGLETON_141, initializer, 777)))
        );
        assertEq(_guardOf(address(provisioned)), address(guard), "guard not attached at creation");
        assertEq(provisioned.getOwners()[0], trader);
    }

    // ---- the bypasses are closed ---------------------------------------------------------

    function test_ApprovingUsdtToAnUnlistedSpenderIsBlocked() public {
        bytes memory data = abi.encodeWithSignature("approve(address,uint256)", address(0xBAD), 100e18);
        bytes memory signature = _approveAndSign(USDT, 0, data, Enum.Operation.Call);
        vm.expectRevert(abi.encodeWithSelector(SpotRiskGuard.SpenderNotAllowed.selector, USDT, address(0xBAD)));
        vm.prank(trader);
        safe.execTransaction(USDT, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
    }

    function test_EnablingAModuleIsBlocked() public {
        bytes memory data = abi.encodeWithSignature("enableModule(address)", address(0xBAD));
        bytes memory signature = _approveAndSign(address(safe), 0, data, Enum.Operation.Call);
        vm.expectRevert();
        vm.prank(trader);
        safe.execTransaction(address(safe), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
    }

    function test_DetachingTheGuardNeedsTheCooldown() public {
        bytes memory data = abi.encodeWithSignature("setGuard(address)", address(0));
        bytes memory signature = _approveAndSign(address(safe), 0, data, Enum.Operation.Call);
        vm.expectRevert();
        vm.prank(trader);
        safe.execTransaction(address(safe), 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);

        _exec(address(guard), 0, abi.encodeWithSignature("requestRemoval()"), Enum.Operation.Call);
        vm.warp(block.timestamp + 25 hours);
        _exec(address(safe), 0, data, Enum.Operation.Call);
        assertEq(_guardOf(address(safe)), address(0));
    }

    // ---- helpers -------------------------------------------------------------------------

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

    function _guardOf(address s) private view returns (address g) {
        bytes32 slot = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
        g = address(uint160(uint256(vm.load(s, slot))));
    }

    function _approveAndSign(address to, uint256 value, bytes memory data, Enum.Operation operation)
        private
        returns (bytes memory signature)
    {
        uint256 currentNonce = safe.nonce();
        bytes32 txHash =
            safe.getTransactionHash(to, value, data, operation, 0, 0, 0, address(0), payable(address(0)), currentNonce);
        vm.prank(trader);
        safe.approveHash(txHash);
        return abi.encodePacked(uint256(uint160(trader)), uint256(0), uint8(1));
    }

    function _exec(address to, uint256 value, bytes memory data, Enum.Operation operation) private {
        bytes memory signature = _approveAndSign(to, value, data, operation);
        vm.prank(trader);
        bool success =
            safe.execTransaction(to, value, data, operation, 0, 0, 0, address(0), payable(address(0)), signature);
        require(success, "Safe execTransaction failed unexpectedly");
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}
