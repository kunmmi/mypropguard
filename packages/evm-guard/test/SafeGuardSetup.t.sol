// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SafeGuardSetup} from "../src/SafeGuardSetup.sol";
import {GmxPositionLimitGuard} from "../src/GmxPositionLimitGuard.sol";
import {Safe} from "safe-smart-account/contracts/Safe.sol";
import {SafeProxyFactory} from "safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import {Enum} from "safe-smart-account/contracts/interfaces/Enum.sol";
import {GUARD_STORAGE_SLOT} from "safe-smart-account/contracts/libraries/SafeStorage.sol";

/// @notice Proves the real deployment flow MyPropGuard's backend will use: a deployer that is
/// NOT the trader creates the Safe AND attaches the Guard in one transaction, with the trader
/// never signing anything - then confirms the trader (and only the trader) can use the Safe
/// afterward, and that the Guard is genuinely active from the very first transaction.
contract SafeGuardSetupTest is Test {
    address constant EXCHANGE_ROUTER = 0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41;

    Safe safeSingleton;
    SafeProxyFactory factory;
    SafeGuardSetup setupHelper;
    GmxPositionLimitGuard guard;

    address trader;
    address deployer = address(0xDEADBEEF); // MyPropGuard's backend - NOT the trader
    address admin = address(0xADD1);

    function setUp() public {
        string memory rpcUrl = vm.envOr("ARBITRUM_RPC_URL", string("https://arb1.arbitrum.io/rpc"));
        vm.createSelectFork(rpcUrl);

        (trader,) = makeAddrAndKey("trader");

        safeSingleton = new Safe();
        factory = new SafeProxyFactory();
        setupHelper = new SafeGuardSetup();
        guard = new GmxPositionLimitGuard(admin, EXCHANGE_ROUTER);
    }

    function test_DeployerCanCreateSafeWithGuardAlreadyAttached_NoTraderSignatureNeeded() public {
        address[] memory owners = new address[](1);
        owners[0] = trader;

        bytes memory setupGuardCall = abi.encodeWithSelector(SafeGuardSetup.setupGuard.selector, address(guard));

        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector,
            owners,
            uint256(1),
            address(setupHelper), // `to` - delegatecalled during setup
            setupGuardCall, // `data` - the setGuard call, run in the Safe's own context
            address(0),
            address(0),
            uint256(0),
            payable(address(0))
        );

        // The deployer - not the trader - calls this. No trader signature anywhere in this call.
        vm.prank(deployer);
        address safeAddress = address(factory.createProxyWithNonce(address(safeSingleton), initializer, 0));
        Safe safe = Safe(payable(safeAddress));

        // Confirm the Guard is really attached, by reading the Safe's own storage the same way
        // GuardManager's internal getGuard() does (there's no public getter, only getStorageAt).
        bytes32 storedGuard = vm.load(safeAddress, GUARD_STORAGE_SLOT);
        assertEq(address(uint160(uint256(storedGuard))), address(guard), "Guard was not attached during setup");

        // Confirm the trader really is the Safe's sole owner.
        address[] memory actualOwners = safe.getOwners();
        assertEq(actualOwners.length, 1);
        assertEq(actualOwners[0], trader);
        assertEq(safe.getThreshold(), 1);
    }

    function test_GuardIsActiveFromTheVeryFirstTransaction() public {
        address[] memory owners = new address[](1);
        owners[0] = trader;
        bytes memory setupGuardCall = abi.encodeWithSelector(SafeGuardSetup.setupGuard.selector, address(guard));
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector, owners, uint256(1), address(setupHelper), setupGuardCall, address(0), address(0), uint256(0), payable(address(0))
        );

        vm.prank(deployer);
        address safeAddress = address(factory.createProxyWithNonce(address(safeSingleton), initializer, 0));
        Safe safe = Safe(payable(safeAddress));

        // No limits configured yet for this brand-new Safe - the very first trade attempt must
        // already be blocked (fail-closed), proving the Guard was live from block zero, not
        // attached "a moment too late" after some unguarded window.
        bytes memory swapData = abi.encodeWithSignature("createOrder()"); // shape doesn't matter - LimitsNotConfigured fires before any decoding

        uint256 txNonce = safe.nonce();
        bytes32 txHash =
            safe.getTransactionHash(EXCHANGE_ROUTER, 0, swapData, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), txNonce);
        vm.prank(trader);
        safe.approveHash(txHash);
        bytes memory signature = abi.encodePacked(uint256(uint160(trader)), uint256(0), uint8(1));

        vm.expectRevert(abi.encodeWithSelector(GmxPositionLimitGuard.LimitsNotConfigured.selector, safeAddress));
        vm.prank(trader);
        safe.execTransaction(EXCHANGE_ROUTER, 0, swapData, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature);
    }

    function test_DeployerCannotActAsTheSafeAfterwards() public {
        address[] memory owners = new address[](1);
        owners[0] = trader;
        bytes memory setupGuardCall = abi.encodeWithSelector(SafeGuardSetup.setupGuard.selector, address(guard));
        bytes memory initializer = abi.encodeWithSelector(
            Safe.setup.selector, owners, uint256(1), address(setupHelper), setupGuardCall, address(0), address(0), uint256(0), payable(address(0))
        );

        vm.prank(deployer);
        address safeAddress = address(factory.createProxyWithNonce(address(safeSingleton), initializer, 0));
        Safe safe = Safe(payable(safeAddress));

        // The deployer paid for creation but is NOT an owner - it must not be able to approve or
        // execute transactions on the trader's behalf. This is the whole point: MyPropGuard can
        // set the Safe up, but cannot control it afterward.
        bytes memory signature = abi.encodePacked(uint256(uint160(deployer)), uint256(0), uint8(1));
        vm.prank(deployer);
        vm.expectRevert(); // Safe's own "GS025: hash not approved" / owner-check error
        safe.execTransaction(
            EXCHANGE_ROUTER, 0, hex"", Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signature
        );
    }
}
