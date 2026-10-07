// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {SpotRiskGuard} from "../src/SpotRiskGuard.sol";

/// @notice Deploys the outcome-based SpotRiskGuard to BNB Chain mainnet. Run by the person holding
/// the deployer key - never by MyPropGuard's code or CI.
///
/// The existing SafeGuardSetup helper is generic (it just calls setGuard on whichever Safe
/// delegatecalls it), so it is reused as is - only the Guard is new. After deploying, set
/// EVM_BSC_PANCAKESWAP_GUARD_ADDRESS to the printed address and create new accounts (a Safe is
/// attached to one Guard; existing Safes keep their old one).
///
/// Usage (run this yourself - MyPropGuard never sees your private key):
///   export ADMIN_ADDRESS=0x...   # the backend admin wallet (never an owner of any Safe)
///   forge script script/DeployBscSpotGuard.s.sol:DeployBscSpotGuard \
///     --rpc-url https://bsc-rpc.publicnode.com --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract DeployBscSpotGuard is Script {
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    // Safe's official MultiSendCallOnly v1.4.1 - the only contract a Safe may delegatecall.
    address constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
    address constant PERMIT2 = 0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768;

    // PancakeSwap routers a trader may approve tokens to.
    address constant V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant V3_SWAP_ROUTER = 0x1b81D678ffb9C0263b24A97847620C99d213eB14;
    address constant SMART_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address constant UNIVERSAL_ROUTER = 0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB;
    // PancakeSwap's Aggregator router (an upgradeable proxy owned by the same account as the Smart Router). The site
    // routes some swaps through it and asks for a token approval to it first.
    address constant AGGREGATOR_ROUTER = 0x2f68417A18dA681589F4eA64B9Cc9839209acfF7;

    function run() external {
        address adminAddress = vm.envAddress("ADMIN_ADDRESS");

        // Every token that counts as money. A token not listed here is treated like any other
        // token the trader holds, so list every stablecoin people really use on the chain.
        address[] memory base = new address[](8);
        base[0] = WBNB;
        base[1] = 0x55d398326f99059fF775485246999027B3197955; // USDT
        base[2] = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d; // USDC
        base[3] = 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56; // BUSD
        base[4] = 0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409; // FDUSD
        base[5] = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3; // DAI
        base[6] = 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d; // USD1
        base[7] = 0x40af3827F39D0EAcBF4A168f8D4ee67c121D11c9; // TUSD

        address[] memory spenders = new address[](6);
        spenders[0] = V2_ROUTER;
        spenders[1] = V3_SWAP_ROUTER;
        spenders[2] = SMART_ROUTER;
        spenders[3] = UNIVERSAL_ROUTER;
        spenders[4] = PERMIT2;
        spenders[5] = AGGREGATOR_ROUTER;

        vm.startBroadcast();
        SpotRiskGuard guard = new SpotRiskGuard(adminAddress, WBNB, MULTISEND_CALL_ONLY, PERMIT2, base, spenders);
        vm.stopBroadcast();

        console.log("SpotRiskGuard deployed at:", address(guard));
        console.log("Guard admin set to:", adminAddress);
        console.log("");
        console.log("Set this in production env (never commit real values):");
        console.log("  EVM_BSC_PANCAKESWAP_GUARD_ADDRESS=", address(guard));
        console.log("EVM_BSC_SAFE_GUARD_SETUP stays unchanged.");
    }
}
