// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {UniswapLimitGuard} from "../src/UniswapLimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Forks live Ethereum mainnet and calls Uniswap's REAL deployed V2 Router and V3
/// SwapRouter02 with calldata built the exact same way this Guard decodes it. Never broadcasts
/// anything or spends real funds.
contract UniswapForkIntegrationTest is Test {
    // Per research_notes/Uniswap V2 Router Ethereum parity/ and
    // research_notes/EVM on-chain trading risk enforcement/v3_and_universal_router_abi.md (Oct 2026).
    address constant V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant SWAP_ROUTER_02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45; // no-deadline struct
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    UniswapLimitGuard guard;
    address trader = address(0x7A4DE2);

    function setUp() public {
        string memory rpcUrl = vm.envOr("ETH_RPC_URL", string("https://ethereum.publicnode.com"));
        vm.createSelectFork(rpcUrl);
        guard = new UniswapLimitGuard(address(this), V2_ROUTER);
        guard.setRouterKind(SWAP_ROUTER_02, UniswapLimitGuard.RouterKind.V3NoDeadline);
        guard.setMaxTradesPerDay(trader, 10);
        guard.setTokenLimit(trader, guard.NATIVE_ETH(), 1 ether);
        guard.setTokenLimit(trader, WETH, 1 ether);
    }

    /// @notice Same proof standard as every other exchange: a real V2 swap against a live,
    /// liquid pair should simply succeed, confirmed via the trader's real DAI balance.
    function test_RealV2RouterAcceptsOurCalldataShape() public {
        require(V2_ROUTER.code.length > 0, "fork did not load V2 Router - check RPC connectivity");

        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = DAI;

        vm.deal(trader, 1 ether);
        vm.prank(trader);
        (bool success,) = V2_ROUTER.call{value: 0.1 ether}(
            abi.encodeWithSignature(
                "swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, trader, block.timestamp + 300
            )
        );
        assertTrue(success, "real V2 swap failed");
        assertGt(IERC20(DAI).balanceOf(trader), 0, "swap reported success but trader received no DAI");
    }

    /// @notice The real test for V3: does SwapRouter02's live deployed bytecode accept our
    /// exact exactInputSingle calldata shape (7-field struct, no deadline) and complete a real
    /// swap? WETH must be acquired first (via the WETH9 contract's own deposit()) and approved
    /// to the router, mirroring what a real trader's wallet would do before calling exactInputSingle.
    function test_RealSwapRouter02AcceptsOurCalldataShape() public {
        require(SWAP_ROUTER_02.code.length > 0, "fork did not load SwapRouter02 - check RPC connectivity");

        vm.deal(trader, 1 ether);
        vm.startPrank(trader);
        IWETH(WETH).deposit{value: 0.1 ether}();
        IERC20(WETH).approve(SWAP_ROUTER_02, 0.1 ether);

        bytes memory data = abi.encodeWithSignature(
            "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
            WETH, DAI, uint24(3000), trader, 0.1 ether, uint256(0), uint160(0)
        );
        (bool success, bytes memory returnData) = SWAP_ROUTER_02.call(data);
        vm.stopPrank();

        if (!success) {
            console2.log("exactInputSingle reverted - reason:");
            console2.logBytes(returnData);
        }
        assertTrue(success, "real SwapRouter02 exactInputSingle failed - struct shape may be wrong");
        assertGt(IERC20(DAI).balanceOf(trader), 0, "swap reported success but trader received no DAI");
    }

    function test_GuardBlocksOversizedRealShapedV2Swap() public {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = DAI;

        vm.expectRevert(
            abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, guard.NATIVE_ETH(), 5 ether, 1 ether)
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
            WETH, DAI, uint24(3000), trader, 5 ether, uint256(0), uint160(0)
        );

        vm.expectRevert(abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, WETH, 5 ether, 1 ether));
        vm.prank(trader);
        guard.checkTransaction(SWAP_ROUTER_02, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IWETH {
    function deposit() external payable;
}
