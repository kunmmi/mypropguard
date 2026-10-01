// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {PancakeSwapLimitGuard} from "../src/PancakeSwapLimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Forks live BSC mainnet and calls PancakeSwap's REAL deployed V2 Router and V3
/// SmartRouter with calldata built the exact same way this Guard decodes it. Never broadcasts
/// anything or spends real funds.
contract PancakeSwapForkIntegrationTest is Test {
    // Per research_notes/EVM on-chain trading risk enforcement/
    // pancakeswap_router_and_frontend_routing.md (Oct 2026).
    address constant V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant V3_SMART_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4; // no-deadline struct
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    PancakeSwapLimitGuard guard;
    address trader = address(0x7A4DE2);

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.binance.org"));
        vm.createSelectFork(rpcUrl);
        guard = new PancakeSwapLimitGuard(address(this), V2_ROUTER, WBNB);
        guard.setRouterKind(V3_SMART_ROUTER, PancakeSwapLimitGuard.RouterKind.V3NoDeadline);
        guard.setMaxTradesPerDay(trader, 10);
        guard.setTokenLimit(trader, guard.NATIVE_BNB(), 1 ether);
        guard.setTokenLimit(trader, WBNB, 1 ether);
    }

    function test_RealV2RouterAcceptsOurCalldataShape() public {
        require(V2_ROUTER.code.length > 0, "fork did not load V2 Router - check RPC connectivity");

        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = BUSD;

        vm.deal(trader, 1 ether);
        vm.prank(trader);
        (bool success,) = V2_ROUTER.call{value: 0.1 ether}(
            abi.encodeWithSignature(
                "swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, trader, block.timestamp + 300
            )
        );
        assertTrue(success, "real V2 swap failed");
        assertGt(IERC20(BUSD).balanceOf(trader), 0, "swap reported success but trader received no BUSD");
    }

    /// @notice The real test for V3: does the SmartRouter's live deployed bytecode accept our
    /// exact exactInputSingle calldata shape (7-field struct, no deadline) and complete a real
    /// swap? WBNB must be acquired first (via WBNB's own deposit()) and approved to the router.
    function test_RealSmartRouterAcceptsOurCalldataShape() public {
        require(V3_SMART_ROUTER.code.length > 0, "fork did not load V3 SmartRouter - check RPC connectivity");

        vm.deal(trader, 1 ether);
        vm.startPrank(trader);
        IWETH(WBNB).deposit{value: 0.1 ether}();
        IERC20(WBNB).approve(V3_SMART_ROUTER, 0.1 ether);

        bytes memory data = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WBNB, BUSD, uint24(2500), trader, 0.1 ether, uint256(0), uint160(0)
        );
        (bool success, bytes memory returnData) = V3_SMART_ROUTER.call(data);
        vm.stopPrank();

        if (!success) {
            console2.log("exactInputSingle reverted - reason:");
            console2.logBytes(returnData);
        }
        assertTrue(success, "real PancakeSwap V3 SmartRouter exactInputSingle failed - struct shape may be wrong");
        assertGt(IERC20(BUSD).balanceOf(trader), 0, "swap reported success but trader received no BUSD");
    }

    function test_GuardBlocksOversizedRealShapedV2Swap() public {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = BUSD;

        vm.expectRevert(
            abi.encodeWithSelector(PancakeSwapLimitGuard.TradeAmountExceeded.selector, guard.NATIVE_BNB(), 5 ether, 1 ether)
        );
        vm.prank(trader);
        guard.checkTransaction(
            V2_ROUTER,
            5 ether,
            abi.encodeWithSignature("swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, trader, block.timestamp + 300),
            Enum.Operation.Call,
            0, 0, 0, address(0), payable(address(0)), "", address(0)
        );
    }

    function test_GuardBlocksOversizedRealShapedV3Swap() public {
        bytes memory data = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WBNB, BUSD, uint24(2500), trader, 5 ether, uint256(0), uint160(0)
        );

        vm.expectRevert(abi.encodeWithSelector(PancakeSwapLimitGuard.TradeAmountExceeded.selector, WBNB, 5 ether, 1 ether));
        vm.prank(trader);
        guard.checkTransaction(V3_SMART_ROUTER, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
}
