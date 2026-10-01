import { encodeFunctionData, type Address, type Hash, type PublicClient, type WalletClient, type Account, type Chain } from "viem";
import { safeGuardSetupAbi, safeProxyFactoryAbi, safeSetupAbi } from "./abis.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface SafeDeployerConfig {
  /** Safe's own canonical SafeProxyFactory address on this chain. NOT something MyPropGuard
   * deploys itself - re-verify against Safe's own deployments repo (github.com/safe-global/safe-deployments)
   * before using on a new chain, the same caution as every other "don't trust a hardcoded address
   * forever" note in packages/evm-guard. */
  safeProxyFactory: Address;
  /** Safe's own canonical Safe singleton address on this chain (the L2 variant, if deploying on
   * an L2 like Arbitrum - see Safe's deployments repo for which variant each chain expects). */
  safeSingleton: Address;
  /** MyPropGuard's own deployed SafeGuardSetup helper address on this chain (packages/evm-guard/src/SafeGuardSetup.sol) - this one IS something MyPropGuard deploys and controls the address of. */
  safeGuardSetup: Address;
}

export interface DeploySafeWithGuardParams {
  /** The trader's own wallet address - becomes the Safe's sole owner. MyPropGuard never holds a
   * key for this address and never signs anything on its behalf. */
  owner: Address;
  /** The already-deployed Guard contract (GmxPositionLimitGuard/PancakeSwapLimitGuard/
   * UniswapLimitGuard) to attach - shared across every MyPropGuard account on this chain. */
  guard: Address;
  /** Lets the same owner+guard pair produce a different Safe address if ever needed (e.g. a
   * second account for the same trader on the same chain). Defaults to 0n. */
  saltNonce?: bigint;
}

export interface DeploySafeWithGuardResult {
  safeAddress: Address;
  txHash: Hash;
}

/**
 * Deploys a Safe for a trader with MyPropGuard's risk Guard already attached, in one
 * transaction, with zero signature required from the trader - see
 * packages/evm-guard/README.md's "Deploying for a trader without their signature" section for
 * why this is safe and how SafeGuardSetup.sol makes it possible. The caller (MyPropGuard's own
 * backend wallet) pays gas and becomes the Safe's deployer, never an owner or controller of it.
 */
export class SafeDeployer {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly deployerAccount: Account,
    private readonly chain: Chain,
    private readonly config: SafeDeployerConfig,
  ) {}

  async deploySafeWithGuard(params: DeploySafeWithGuardParams): Promise<DeploySafeWithGuardResult> {
    const setupGuardCalldata = encodeFunctionData({
      abi: safeGuardSetupAbi,
      functionName: "setupGuard",
      args: [params.guard],
    });

    const initializer = encodeFunctionData({
      abi: safeSetupAbi,
      functionName: "setup",
      args: [
        [params.owner],
        1n,
        this.config.safeGuardSetup,
        setupGuardCalldata,
        ZERO_ADDRESS,
        ZERO_ADDRESS,
        0n,
        ZERO_ADDRESS,
      ],
    });

    const saltNonce = params.saltNonce ?? 0n;

    const safeAddress = await this.publicClient.simulateContract({
      address: this.config.safeProxyFactory,
      abi: safeProxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [this.config.safeSingleton, initializer, saltNonce],
      account: this.deployerAccount,
    }).then((simulation) => simulation.result);

    const txHash = await this.walletClient.writeContract({
      address: this.config.safeProxyFactory,
      abi: safeProxyFactoryAbi,
      functionName: "createProxyWithNonce",
      args: [this.config.safeSingleton, initializer, saltNonce],
      account: this.deployerAccount,
      chain: this.chain,
    });

    await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    return { safeAddress, txHash };
  }
}
