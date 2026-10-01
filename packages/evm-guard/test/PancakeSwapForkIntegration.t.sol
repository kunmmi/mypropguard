// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {PancakeSwapV2LimitGuard} from "../src/PancakeSwapV2LimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Forks live BSC mainnet and calls PancakeSwap's REAL deployed V2 Router with calldata
/// built the exact same way this Guard decodes it, to verify the struct/selector encoding
/// genuinely matches the live contract. This never broadcasts anything or spends real funds.
contract PancakeSwapForkIntegrationTest is Test {
    // Per research_notes/EVM on-chain trading risk enforcement/pancakeswap_router_and_frontend_routing.md (Oct 2026).
    address constant V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant BUSD = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    PancakeSwapV2LimitGuard guard;
    address trader = address(0x7A4DE2);

    function setUp() public {
        string memory rpcUrl = vm.envOr("BSC_RPC_URL", string("https://bsc-dataseed.binance.org"));
        vm.createSelectFork(rpcUrl);
        guard = new PancakeSwapV2LimitGuard(address(this), V2_ROUTER);
        guard.setMaxTradesPerDay(trader, 10);
        // Native-BNB-input swaps are tracked under NATIVE_BNB (address(0)), not WBNB's own
        // address - WBNB only appears in the swap `path`, the spend side is msg.value.
        guard.setTokenLimit(trader, guard.NATIVE_BNB(), 1 ether); // deliberately tiny - ABI-compatibility check only
    }

    /// @notice Confirms GMX-style trace-based proof, adapted for PancakeSwap: a real swap call
    /// against the live router either succeeds outright (no WETH/WBNB-style wrapping needed -
    /// PancakeSwap's swapExactETHForTokens takes native BNB directly via msg.value) or reverts
    /// for a genuine PancakeSwap-side reason (e.g. slippage/output-amount), not a generic
    /// ABI-decode failure. Funding `trader` with real BNB via vm.deal and swapping for BUSD on
    /// a live, liquid pair should realistically succeed on a mainnet fork.
    function test_RealV2RouterAcceptsOurCalldataShape() public {
        require(V2_ROUTER.code.length > 0, "fork did not load V2 Router - check RPC connectivity");

        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = BUSD;

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

        // A real V2 swap against a live, liquid WBNB/BUSD pair should simply succeed. If it
        // doesn't, at minimum it must have consumed real gas reaching PancakeSwap's own logic
        // (pair lookup, reserves math) rather than failing instantly on a selector/ABI mismatch.
        if (!success) {
            assertGt(gasUsed, 30_000, "suspiciously cheap failure - suggests the call never reached real PancakeSwap logic");
        } else {
            assertGt(IERC20(BUSD).balanceOf(trader), 0, "swap reported success but trader received no BUSD");
        }
    }

    /// @notice Confirms the Guard itself, wired to the REAL V2 Router address, correctly
    /// decodes this same real-shaped calldata and enforces the configured limit.
    function test_GuardBlocksOversizedRealShapedSwap() public {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = BUSD;

        vm.expectRevert(
            abi.encodeWithSelector(PancakeSwapV2LimitGuard.TradeAmountExceeded.selector, guard.NATIVE_BNB(), 5 ether, 1 ether)
        );
        vm.prank(trader);
        guard.checkTransaction(
            V2_ROUTER,
            5 ether, // over the 1 ether limit set in setUp()
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

    /// @notice Same real calldata shape, but for an ERC-20-to-ERC-20 swap (USDT -> BUSD) rather
    /// than the native-BNB path - confirms path[0]/amountIn decoding against the live router too.
    function test_GuardBlocksOversizedErc20ToErc20RealShapedSwap() public {
        vm.prank(address(this));
        guard.setTokenLimit(trader, USDT, 100e18);

        address[] memory path = new address[](2);
        path[0] = USDT;
        path[1] = BUSD;

        bytes memory data = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)", 500e18, 0, path, trader, block.timestamp + 300
        );

        vm.expectRevert(abi.encodeWithSelector(PancakeSwapV2LimitGuard.TradeAmountExceeded.selector, USDT, 500e18, 100e18));
        vm.prank(trader);
        guard.checkTransaction(V2_ROUTER, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), "", address(0));
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}
