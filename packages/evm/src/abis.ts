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
    name: "setAllowedSpender",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowed", type: "bool" },
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

/** What the session-key flow needs from a Safe: the nonce, ownership, and execTransaction itself. */
export const safeExecAbi = [
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address[]" }] },
  {
    type: "function",
    name: "isOwner",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "addOwnerWithThreshold",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "_threshold", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "removeOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "owner", type: "address" },
      { name: "_threshold", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export const multiSendAbi = [
  {
    type: "function",
    name: "multiSend",
    stateMutability: "payable",
    inputs: [{ name: "transactions", type: "bytes" }],
    outputs: [],
  },
] as const;

/** SpotRiskGuard's session-key functions and views (see packages/evm-guard/src/SpotRiskGuard.sol). */
export const spotGuardSessionAbi = [
  {
    type: "function",
    name: "addSessionKey",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "removeSessionKey",
    stateMutability: "nonpayable",
    inputs: [{ name: "key", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isSessionKey",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "key", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** The errors SpotRiskGuard can revert with, so a refused trade can be explained in words. */
export const spotGuardErrorsAbi = [
  { type: "error", name: "NotAdmin", inputs: [] },
  { type: "error", name: "LimitsNotConfigured", inputs: [{ name: "account", type: "address" }] },
  { type: "error", name: "AccountIsFrozen", inputs: [{ name: "account", type: "address" }] },
  {
    type: "error",
    name: "TradeAmountExceeded",
    inputs: [
      { name: "token", type: "address" },
      { name: "requested", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "TradeCountExceeded",
    inputs: [
      { name: "attempted", type: "uint256" },
      { name: "max", type: "uint256" },
    ],
  },
  { type: "error", name: "DelegateCallNotAllowed", inputs: [] },
  {
    type: "error",
    name: "BlockedCall",
    inputs: [
      { name: "to", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
  },
  {
    type: "error",
    name: "SessionKeyBlocked",
    inputs: [
      { name: "to", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
  },
  {
    type: "error",
    name: "SpenderNotAllowed",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
  },
  { type: "error", name: "ModulesNotAllowed", inputs: [] },
  { type: "error", name: "NestedExecution", inputs: [] },
  { type: "error", name: "MalformedMultiSend", inputs: [] },
] as const;
