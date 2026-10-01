/**
 * Minimal ABI fragments for the contracts in packages/evm-guard - just the functions/events
 * this package's clients actually call, not full ABIs. Keeping these hand-written (rather than
 * importing Foundry's generated JSON artifacts) avoids a build-order dependency between this TS
 * package and the Solidity one; the function signatures here must stay in sync with
 * packages/evm-guard/src/*.sol by hand.
 */

export const safeProxyFactoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_singleton", type: "address" },
      { name: "initializer", type: "bytes" },
      { name: "saltNonce", type: "uint256" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    type: "event",
    name: "ProxyCreation",
    inputs: [
      { name: "proxy", type: "address", indexed: false },
      { name: "singleton", type: "address", indexed: false },
    ],
  },
] as const;

export const safeSetupAbi = [
  {
    type: "function",
    name: "setup",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owners", type: "address[]" },
      { name: "_threshold", type: "uint256" },
      { name: "to", type: "address" },
      { name: "data", type: "bytes" },
      { name: "fallbackHandler", type: "address" },
      { name: "paymentToken", type: "address" },
      { name: "payment", type: "uint256" },
      { name: "paymentReceiver", type: "address" },
    ],
    outputs: [],
  },
] as const;

export const safeGuardSetupAbi = [
  {
    type: "function",
    name: "setupGuard",
    stateMutability: "nonpayable",
    inputs: [{ name: "guard", type: "address" }],
    outputs: [],
  },
] as const;

export const safeReadAbi = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** GmxPositionLimitGuard's admin-only rule-configuration functions. */
export const gmxGuardAdminAbi = [
  {
    type: "function",
    name: "setLimits",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "maxPositionSizeUsd", type: "uint256" },
      { name: "maxTradesPerDay", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setExchangeRouter",
    stateMutability: "nonpayable",
    inputs: [{ name: "newExchangeRouter", type: "address" }],
    outputs: [],
  },
] as const;

/**
 * PancakeSwapLimitGuard's and UniswapLimitGuard's admin-only rule/router-configuration
 * functions - identical ABI on both contracts (see packages/evm-guard's README on why they're
 * separate contracts with the same shape), so one client type serves both.
 */
export const spotGuardAdminAbi = [
  {
    type: "function",
    name: "setTokenLimit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setMaxTradesPerDay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "limit", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setRouterKind",
    stateMutability: "nonpayable",
    inputs: [
      { name: "routerAddress", type: "address" },
      { name: "kind", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "recordDailyLossBreach",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [],
  },
] as const;

/** The handful of ERC-20 view functions needed to price and value a Safe's token holdings. */
export const erc20ReadAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** PancakeSwap V2 Factory - just enough to find a token's pair against a known base token. */
export const pancakeFactoryAbi = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    outputs: [{ name: "pair", type: "address" }],
  },
] as const;

/** PancakeSwap V2 pair - enough to read a spot price from reserves (see PancakeSwapEquityReader's NatSpec for the manipulation caveat this implies). */
export const pancakePairAbi = [
  {
    type: "function",
    name: "getReserves",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
  {
    type: "function",
    name: "token0",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * Safe's own GUARD_STORAGE_SLOT constant (safe-smart-account/contracts/libraries/SafeStorage.sol) -
 * exported here as the single source of truth so nothing has to hand-transcribe this 32-byte
 * value a second time (a one-character transcription error here silently reads the wrong storage
 * slot and would look like "no guard attached" even when one really is).
 */
export const SAFE_GUARD_STORAGE_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as const;
