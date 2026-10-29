/** Solana mainnet-beta as WalletConnect names it (CAIP-2: the first 32 characters of the genesis hash). */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** The WalletConnect methods a Solana wallet answers (docs.walletconnect.network/wallet-sdk/chain-support/solana). */
export const SOLANA_WC_METHODS = [
  "solana_getAccounts",
  "solana_requestAccounts",
  "solana_signMessage",
  "solana_signTransaction",
  "solana_signAllTransactions",
  "solana_signAndSendTransaction",
] as const;

/** Sites this wallet will sign a login for and trade on. */
export const SOLANA_SITES = {
  pumpFun: { name: "pump.fun", hosts: ["pump.fun", "www.pump.fun"] },
  letsBonk: { name: "letsbonk.fun", hosts: ["letsbonk.fun", "www.letsbonk.fun"] },
  raydium: { name: "Raydium", hosts: ["raydium.io", "www.raydium.io"] },
} as const;

/** Programs a pump.fun transaction is expected to touch, by address. Anything else is shown by address only. */
export const KNOWN_PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  ComputeBudget111111111111111111111111111111: "Compute budget",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated token account",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium LaunchLab",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
};
