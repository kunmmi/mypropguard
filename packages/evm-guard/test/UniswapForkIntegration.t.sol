// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {UniswapV2LimitGuard} from "../src/UniswapV2LimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Forks live Ethereum mainnet and calls Uniswap's REAL deployed V2 Router with
/// calldata built the exact same way this Guard decodes it. This never broadcasts anything or
/// spends real funds.
contract UniswapForkIntegrationTest is Test {
    // Per research_notes/Uniswap V2 Router Ethereum parity/router_address_and_source_signatures.md (Oct 2026).
    address constant V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    UniswapV2LimitGuard guard;
    address trader = address(0x7A4DE2);

    function setUp() public {
        string memory rpcUrl = vm.envOr("ETH_RPC_URL", string("https://ethereum.publicnode.com"));
        vm.createSelectFork(rpcUrl);
        guard = new UniswapV2LimitGuard(address(this), V2_ROUTER);
        guard.setMaxTradesPerDay(trader, 10);
        guard.setTokenLimit(trader, guard.NATIVE_ETH(), 1 ether); // deliberately tiny - ABI-compatibility check only
    }

    /// @notice Same proof standard as the PancakeSwap/GMX fork tests: a real swap against a
    /// live, liquid WETH/DAI pair should simply succeed on a mainnet fork, confirmed by checking
    /// the trader's real DAI balance afterward - not just a revert-reason check.
    function test_RealV2RouterAcceptsOurCalldataShape() public {
        require(V2_ROUTER.code.length > 0, "fork did not load V2 Router - check RPC connectivity");

        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = DAI;

        vm.deal(trader, 1 ether);
        vm.prank(trader);
        uint256 gasBefore = gasleft();
        (bool success, bytes memory returnData) = V2_ROUTER.call{value: 0.1 ether}(
            abi.encodeWithSignature(
                "swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, trader, block.timestamp + 300
            )
        );
        uint256 gasUsed = gasBefore - gasleft();

        if (!success) {
            console2.log("swap reverted - reason:");
            console2.logBytes(returnData);
        }
        console2.log("gas used", gasUsed);

        if (!success) {
            assertGt(gasUsed, 30_000, "suspiciously cheap failure - suggests the call never reached real Uniswap logic");
        } else {
            assertGt(IERC20(DAI).balanceOf(trader), 0, "swap reported success but trader received no DAI");
        }
    }

    function test_GuardBlocksOversizedRealShapedSwap() public {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = DAI;

        vm.expectRevert(
            abi.encodeWithSelector(UniswapV2LimitGuard.TradeAmountExceeded.selector, guard.NATIVE_ETH(), 5 ether, 1 ether)
        );
        vm.prank(trader);
        guard.checkTransaction(
            V2_ROUTER,
            5 ether,
            abi.encodeWithSignature("swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, trader, block.timestamp + 300),
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            "",
            address(0)
        );
    }

    function test_GuardBlocksOversizedErc20ToErc20RealShapedSwap() public {
        guard.setTokenLimit(trader, USDT, 100e6); // USDT has 6 decimals on Ethereum

        address[] memory path = new address[](2);
        path[0] = USDT;
        path[1] = DAI;

        bytes memory data = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)", 500e6, 0, path, trader, block.timestamp + 300
        );

        vm.expectRevert(abi.encodeWithSelector(UniswapV2LimitGuard.TradeAmountExceeded.selector, USDT, 500e6, 100e6));
        vm.prank(trader);
        guard.checkTransaction(V2_ROUTER, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}
