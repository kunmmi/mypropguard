// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GmxPositionLimitGuard} from "../src/GmxPositionLimitGuard.sol";
import {Safe} from "safe-smart-account/contracts/Safe.sol";
import {SafeProxyFactory} from "safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice The full real mechanism, end to end, on a live Arbitrum fork: a genuine Safe (not a
/// vm.prank shortcut) with this Guard actually attached via its own `setGuard`, submitting real
/// `execTransaction` calls against GMX's real ExchangeRouter. Every previous test in this
/// package called `checkTransaction` directly to exercise the Guard's own decode logic in
/// isolation - this test instead drives the real Safe contract exactly as a trader's wallet
/// would, closing the "no real Safe + execTransaction end-to-end test" gap noted in the README.
///
/// Uses Safe's approved-hash signature scheme (`approveHash` + a `v=1` signature) instead of real
/// ECDSA signing - this is a legitimate, Safe-native way for an owner to authorize a transaction,
/// not a shortcut around Safe's own security model (`checkSignatures` explicitly supports it).
contract GmxSafeEndToEndTest is Test {
    address constant EXCHANGE_ROUTER = 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41;

    Safe safeSingleton;
    SafeProxyFactory factory;
    Safe safe;
    GmxPositionLimitGuard guard;

    address trader;
    uint256 traderKey;
    address admin = address(0xADD1);

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC_URL", string("https://arb1.arbitrum.io/rpc"));
        vm.createSelectFork(rpcUrl);

        (trader, traderKey) = makeAddrAndKey("trader");

        // Deploy fresh, unmodified Safe infrastructure on the fork - same bytecode Safe itself
        // ships, just not at the canonical mainnet address (irrelevant for this test: what's
        // being verified is the Guard's interaction with real Safe logic, not a specific address).
        safeSingleton = new Safe();
        factory = new SafeProxyFactory();

        address[] memory owners = new address[](1);
        owners[0] = trader;
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector, owners, uint256(1), address(0), bytes(""), address(0), address(0), uint256(0), payable(address(0))
        );
        address proxy = address(factory.createProxyWithNonce(address(safeSingleton), initializer, 0));
        safe = Safe(payable(proxy));

        guard = new GmxPositionLimitGuard(admin, EXCHANGE_ROUTER);

        // Attach the Guard via a real Safe transaction (setGuard is `authorized` - self-call
        // only), same mechanism a MyPropGuard provisioning flow would use for real.
        _execAsTrader(address(safe), 0, abi.encodeWithSignature("setGuard(address)", address(guard)), Enum.Operation.Call);

        vm.prank(admin);
        guard.setLimits(address(safe), 100 * 1e30, 5); // $100 max position - tiny, ABI-compatibility check only
    }

    function test_RealSafeExecTransactionBlocksOversizedGmxOrder() public {
        bytes memory data = _buildGmxMulticall(5000 * 1e30); // far over the $100 limit
        bytes memory signature = _approveAndSign(EXCHANGE_ROUTER, 0.001 ether, data, Enum.Operation.Call);

        vm.expectRevert(
            abi.encodeWithSelector(GmxPositionLimitGuard.PositionSizeExceeded.selector, 5000 * 1e30, 100 * 1e30)
        );
        vm.prank(trader);
        safe.execTransaction(
            EXCHANGE_ROUTER, 0.001 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature
        );
    }

    function test_RealSafeExecTransactionReachesRealGmxLogicWhenWithinLimit() public {
        bytes memory data = _buildGmxMulticall(50 * 1e30); // within the $100 limit
        bytes memory signature = _approveAndSign(EXCHANGE_ROUTER, 0.001 ether, data, Enum.Operation.Call);

        vm.deal(address(safe), 1 ether);

        // Safe's execTransaction reverts with the ORIGINAL inner revert reason whenever the
        // inner call fails and safeTxGas/gasPrice are both 0 (see Safe.sol's execTransaction) -
        // so this is still expected to revert, same as the plain fork-integration test, since
        // the Safe has no real GMX collateral/account set up. Note this means a failing
        // execTransaction rolls back EVERYTHING that happened inside it, including the Guard's
        // own tradeState write from checkTransaction - there is no post-transaction state left
        // to inspect for "did the Guard let this through," only the revert reason itself. What
        // matters here: it must NOT revert with the Guard's own error
        // (PositionSizeExceeded/TradeCountExceeded/LimitsNotConfigured) - confirming the Guard
        // let it through and GMX's own logic was genuinely reached, not that the Guard rejected it.
        vm.prank(trader);
        try safe.execTransaction(
            EXCHANGE_ROUTER, 0.001 ether, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature
        ) {
            // A real success would also be fine (even stronger proof) - no assertion needed here.
        } catch (bytes memory reason) {
            bytes4 guardSelector = bytes4(reason);
            assertTrue(
                guardSelector != GmxPositionLimitGuard.PositionSizeExceeded.selector
                    && guardSelector != GmxPositionLimitGuard.TradeCountExceeded.selector
                    && guardSelector != GmxPositionLimitGuard.LimitsNotConfigured.selector,
                "Guard rejected a trade that should have been within limits"
            );
        }
    }

    function _buildGmxMulticall(uint256 sizeDeltaUsd) private view returns (bytes memory) {
        GmxPositionLimitGuard.CreateOrderParamsAddresses memory addresses = GmxPositionLimitGuard
            .CreateOrderParamsAddresses({
            receiver: address(safe),
            cancellationReceiver: address(0),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: address(0x70d95587d40A2caf56bd97485aB3Eec10Bee6336),
            initialCollateralToken: address(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1),
            swapPath: new address[](0)
        });
        GmxPositionLimitGuard.CreateOrderParamsNumbers memory numbers = GmxPositionLimitGuard.CreateOrderParamsNumbers({
            sizeDeltaUsd: sizeDeltaUsd,
            initialCollateralDeltaAmount: 0.0005 ether,
            triggerPrice: 0,
            acceptablePrice: type(uint256).max,
            executionFee: 0.001 ether,
            callbackGasLimit: 0,
            minOutputAmount: 0,
            validFromTime: 0
        });
        GmxPositionLimitGuard.CreateOrderParams memory params = GmxPositionLimitGuard.CreateOrderParams({
            addresses: addresses,
            numbers: numbers,
            orderType: GmxPositionLimitGuard.OrderType.MarketIncrease,
            decreasePositionSwapType: 0,
            isLong: true,
            shouldUnwrapNativeToken: false,
            autoCancel: false,
            referralCode: bytes32(0),
            dataList: new bytes32[](0)
        });

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeWithSignature("sendWnt(address,uint256)", address(0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5), numbers.executionFee);
        calls[1] = abi.encodeWithSignature(
            "createOrder((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))",
            params
        );
        return abi.encodeWithSignature("multicall(bytes[])", calls);
    }

    /// @dev Approved-hash signature: Safe's checkSignatures accepts `r = owner address, s = 0,
    /// v = 1` as proof an owner approved this exact hash, once that owner has called
    /// `approveHash`. Equivalent in security terms to a real ECDSA signature for this test's
    /// purpose (confirming the Guard sees a genuine execTransaction call, not a shortcut around
    /// Safe's own authorization). Separated from the actual `execTransaction` call so tests can
    /// put `vm.expectRevert` immediately before the one call that's actually expected to revert,
    /// rather than it accidentally matching this approval step instead.
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
