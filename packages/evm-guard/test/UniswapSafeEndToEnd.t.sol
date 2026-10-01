// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {UniswapLimitGuard} from "../src/UniswapLimitGuard.sol";
import {Safe} from "safe-smart-account/contracts/Safe.sol";
import {SafeProxyFactory} from "safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice The full real mechanism, end to end, on a live Ethereum fork: a genuine Safe with this
/// Guard actually attached via its own `setGuard`, submitting real `execTransaction` calls
/// against Uniswap's real V2 Router. See GmxSafeEndToEnd.t.sol for the detailed rationale -
/// this is the same pattern, applied to Uniswap. Unlike GMX, a V2 swap needs no pre-existing
/// collateral/account state, so the within-limit case here proves a COMPLETE, SUCCESSFUL real
/// swap through a real Safe, not just "the Guard let it through before failing elsewhere."
contract UniswapSafeEndToEndTest is Test {
    address constant V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;

    Safe safeSingleton;
    SafeProxyFactory factory;
    Safe safe;
    UniswapLimitGuard guard;

    address trader;
    address admin = address(0xADD1);

    function setUp() public {
        string memory rpcUrl = vm.envOr("ETH_RPC_URL", string("https://ethereum.publicnode.com"));
        vm.createSelectFork(rpcUrl);

        (trader,) = makeAddrAndKey("trader");

        safeSingleton = new Safe();
        factory = new SafeProxyFactory();

        address[] memory owners = new address[](1);
        owners[0] = trader;
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector, owners, uint256(1), address(0), bytes(""), address(0), address(0), uint256(0), payable(address(0))
        );
        safe = Safe(payable(address(factory.createProxyWithNonce(address(safeSingleton), initializer, 0))));

        guard = new UniswapLimitGuard(admin, V2_ROUTER, WETH);
        _execAsTrader(address(safe), 0, abi.encodeWithSignature("setGuard(address)", address(guard)), Enum.Operation.Call);

        address nativeEth = guard.NATIVE_ETH();
        vm.startPrank(admin);
        guard.setMaxTradesPerDay(address(safe), 5);
        guard.setTokenLimit(address(safe), nativeEth, 1 ether);
        vm.stopPrank();

        vm.deal(address(safe), 2 ether);
    }

    function test_RealSafeExecTransactionBlocksOversizedSwap() public {
        bytes memory data = _buildSwapCalldata();
        bytes memory signature = _approveAndSign(V2_ROUTER, 5 ether, data, Enum.Operation.Call);

        vm.expectRevert(
            abi.encodeWithSelector(UniswapLimitGuard.TradeAmountExceeded.selector, guard.NATIVE_ETH(), 5 ether, 1 ether)
        );
        vm.prank(trader);
        safe.execTransaction(V2_ROUTER, 5 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
    }

    function test_RealSafeExecTransactionCompletesRealSwapWithinLimit() public {
        bytes memory data = _buildSwapCalldata();
        bytes memory signature = _approveAndSign(V2_ROUTER, 0.1 ether, data, Enum.Operation.Call);

        vm.prank(trader);
        bool success = safe.execTransaction(
            V2_ROUTER, 0.1 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature
        );

        assertTrue(success, "real Safe-executed Uniswap swap failed");
        assertGt(IERC20(DAI).balanceOf(trader), 0, "swap succeeded but trader received no DAI");

        (, uint256 tradesToday) = guard.tradeState(address(safe));
        assertEq(tradesToday, 1);
    }

    function _buildSwapCalldata() private view returns (bytes memory) {
        address[] memory path = new address[](2);
        path[0] = WETH;
        path[1] = DAI;
        return abi.encodeWithSignature(
            "swapExactETHForTokens(uint256,address[],address,uint256)", 0, path, trader, block.timestamp + 300
        );
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

    function _execAsTrader(address to, uint256 value, bytes memory data, Enum.Operation operation) private {
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
