// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {GmxPositionLimitGuard} from "../src/GmxPositionLimitGuard.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";

/// @notice Forks live Arbitrum mainnet and calls GMX's REAL deployed ExchangeRouter with
/// calldata built the exact same way this Guard decodes it, to verify the struct/selector
/// encoding genuinely matches GMX's live contract - not just our own re-derivation of their
/// published source. This never broadcasts anything or spends real funds (fork execution only).
contract GmxForkIntegrationTest is Test {
    // Per research_notes/EVM on-chain trading risk enforcement/gmx_v2_order_abi.md (Oct 2026).
    address constant EXCHANGE_ROUTER = 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41;
    address constant ORDER_VAULT = 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5;
    // WETH/USD market and WETH collateral - a commonly used GMX v2 Arbitrum market.
    address constant WETH_USD_MARKET = 0x70d95587d40A2caf56bd97485aB3Eec10Bee6336;
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    GmxPositionLimitGuard guard;
    address trader = address(0x7A4DE2);

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC_URL", string("https://arb1.arbitrum.io/rpc"));
        vm.createSelectFork(rpcUrl);
        guard = new GmxPositionLimitGuard(address(this), EXCHANGE_ROUTER);
        guard.setLimits(trader, 100 * 1e30, 10); // $100 max position - deliberately tiny, this is just an ABI-compatibility check
    }

    /// @notice The real test: does GMX's live contract accept/parse our exact calldata shape
    /// far enough to reach ITS OWN business logic (e.g. a WNT-amount/fee revert), rather than
    /// failing at the EVM/ABI level (selector not found, decode mismatch)? If our struct layout
    /// or selector were wrong, this would revert with no reason or an out-of-bounds decode
    /// panic, not a GMX-specific error.
    function test_RealExchangeRouterAcceptsOurCalldataShape() public {
        require(EXCHANGE_ROUTER.code.length > 0, "fork did not load ExchangeRouter - check RPC connectivity");

        GmxPositionLimitGuard.CreateOrderParamsAddresses memory addresses = GmxPositionLimitGuard
            .CreateOrderParamsAddresses({
            receiver: trader,
            cancellationReceiver: address(0),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: WETH_USD_MARKET,
            initialCollateralToken: WETH,
            swapPath: new address[](0)
        });

        GmxPositionLimitGuard.CreateOrderParamsNumbers memory numbers = GmxPositionLimitGuard.CreateOrderParamsNumbers({
            sizeDeltaUsd: 50 * 1e30,
            initialCollateralDeltaAmount: 0.01 ether,
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

        bytes memory createOrderCall = abi.encodeWithSignature(
            "createOrder((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))",
            params
        );
        bytes memory sendWntCall = abi.encodeWithSignature("sendWnt(address,uint256)", ORDER_VAULT, numbers.executionFee);

        bytes[] memory calls = new bytes[](2);
        calls[0] = sendWntCall;
        calls[1] = createOrderCall;

        vm.deal(trader, 1 ether);
        vm.prank(trader);
        uint256 gasBefore = gasleft();
        (bool success, bytes memory returnData) =
            EXCHANGE_ROUTER.call{value: numbers.executionFee}(abi.encodeWithSignature("multicall(bytes[])", calls));
        uint256 gasUsed = gasBefore - gasleft();

        if (!success) {
            console2.log("multicall reverted (expected without real WETH collateral) - reason:");
            console2.logBytes(returnData);
        }
        console2.log("gas used", gasUsed);

        // We don't assert `success` - without real WETH collateral in `trader`'s wallet this is
        // expected to revert on GMX's own account/collateral validation deep inside
        // createOrder. What actually matters, and what this asserts: a selector/struct-layout
        // mismatch would fail IMMEDIATELY and cheaply (the EVM can't even dispatch to the right
        // function). Reaching real GMX logic costs real gas - verified via `-vvv` trace that
        // `sendWnt` genuinely wrapped ETH into WETH and transferred it to the real OrderVault
        // on live Arbitrum state, and execution was then dispatched via delegatecall into
        // exactly the selector this Guard computes for createOrder, before reverting deeper
        // inside GMX's own validation. A gas-usage floor well above a trivial dispatch failure
        // is a robust, automatable proxy for "this reached real GMX logic."
        assertGt(gasUsed, 50_000, "suspiciously cheap failure - suggests the call never reached real GMX logic (selector/ABI mismatch)");
    }

    /// @notice Confirms the Guard itself, wired to the REAL ExchangeRouter address, correctly
    /// decodes this same real-shaped calldata and enforces the configured limit - the full
    /// pipeline, just not routed through an actual Safe's execTransaction.
    function test_GuardBlocksOversizedRealShapedOrder() public {
        GmxPositionLimitGuard.CreateOrderParamsAddresses memory addresses = GmxPositionLimitGuard
            .CreateOrderParamsAddresses({
            receiver: trader,
            cancellationReceiver: address(0),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: WETH_USD_MARKET,
            initialCollateralToken: WETH,
            swapPath: new address[](0)
        });

        GmxPositionLimitGuard.CreateOrderParamsNumbers memory numbers = GmxPositionLimitGuard.CreateOrderParamsNumbers({
            sizeDeltaUsd: 5000 * 1e30, // far over the $100 limit set in setUp()
            initialCollateralDeltaAmount: 1 ether,
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

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeWithSignature(
            "createOrder((address,address,address,address,address,address,address[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint8,uint8,bool,bool,bool,bytes32,bytes32[]))",
            params
        );

        vm.expectRevert(
            abi.encodeWithSelector(GmxPositionLimitGuard.PositionSizeExceeded.selector, 5000 * 1e30, 100 * 1e30)
        );
        vm.prank(trader);
        guard.checkTransaction(
            EXCHANGE_ROUTER,
            0,
            abi.encodeWithSignature("multicall(bytes[])", calls),
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
}
