// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {SafeGuardSetup} from "../src/SafeGuardSetup.sol";
import {PancakeSwapLimitGuard} from "../src/PancakeSwapLimitGuard.sol";

/// @notice Deploys SafeGuardSetup and PancakeSwapLimitGuard to real BSC mainnet. Run by the person
/// holding the deployer key - never by MyPropGuard's own code or CI, since that key is never
/// something this project holds. Both contracts are deployed once and then shared across every
/// trader's Safe going forward (see the contracts' own NatSpec for why).
///
/// Usage (run this yourself - MyPropGuard never sees your private key):
///   forge script script/DeployBscGuard.s.sol:DeployBscGuard \
///     --rpc-url https://bsc-dataseed.binance.org \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --broadcast --verify --etherscan-api-key $BSCSCAN_API_KEY
///
/// ADMIN_ADDRESS must be the wallet whose private key apps/api will later use as
/// EVM_BSC_ADMIN_PRIVATE_KEY (it's the only address allowed to call setTokenLimit/
/// setMaxTradesPerDay/setRouterKind on the deployed Guard) - it does NOT need to be the same key
/// as the deployer running this script.
contract DeployBscGuard is Script {
    // PancakeSwap's own canonical V2 Router on BSC mainnet - never MyPropGuard's own contract.
    address constant PANCAKESWAP_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;

    function run() external {
        address adminAddress = vm.envAddress("ADMIN_ADDRESS");

        vm.startBroadcast();

        SafeGuardSetup safeGuardSetup = new SafeGuardSetup();
        console.log("SafeGuardSetup deployed at:", address(safeGuardSetup));

        PancakeSwapLimitGuard guard = new PancakeSwapLimitGuard(adminAddress, PANCAKESWAP_V2_ROUTER);
        console.log("PancakeSwapLimitGuard deployed at:", address(guard));
        console.log("Guard admin set to:", adminAddress);
        console.log("PancakeSwap V2 Router registered:", PANCAKESWAP_V2_ROUTER);

        vm.stopBroadcast();

        console.log("");
        console.log("Set these in production env (never commit real values):");
        console.log("  EVM_BSC_SAFE_GUARD_SETUP=", address(safeGuardSetup));
        console.log("  EVM_BSC_PANCAKESWAP_GUARD_ADDRESS=", address(guard));
    }
}
