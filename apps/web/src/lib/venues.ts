/**
 * Single source of truth for every venue/chain MyPropGuard can protect. The dashboard renders
 * account creation, setup instructions, available rules and panels from this list, so adding a
 * chain or a newly supported route means editing one entry here, not the page.
 *
 * `kind` decides how rules are enforced:
 * - "safe-guard": a Safe smart wallet on the chain with a Guard contract that reverts rule-breaking
 *   transactions on-chain. The trader connects the Safe to any supported exchange front-end.
 * - "agent-wallet": a signing wallet approved on the venue (Hyperliquid), checked before signing.
 */
export type VenueKind = "safe-guard" | "agent-wallet";

export interface VenueToken {
  symbol: string;
  address: string;
  /** Short hint shown next to the symbol, e.g. "native coin" or "stablecoin". */
  note?: string;
}

const NATIVE = "0x0000000000000000000000000000000000000000";

export interface VenueConfig {
  id: string;
  name: string;
  chainName: string;
  chainId?: number;
  kind: VenueKind;
  exchangeName: string;
  summary: string;
  /** Rule types this venue enforces. Undefined means every rule type is offered. */
  supportedRules?: string[];
  ruleLabels?: Record<string, string>;
  /** Routes/contracts the Guard recognizes today. Anything else is rejected on-chain. */
  supportedRoutes?: string[];
  unsupportedNote?: string;
  explorerUrl?: string;
  nativeSymbol?: string;
  /** Common tokens offered in the rule form so traders never paste a contract address by hand. */
  tokens?: VenueToken[];
}

export const VENUES: VenueConfig[] = [
  {
    id: "bsc-pancakeswap",
    name: "PancakeSwap",
    chainName: "BNB Chain",
    chainId: 56,
    kind: "safe-guard",
    exchangeName: "PancakeSwap",
    summary: "Spot trading in a Safe wallet on BNB Chain. Rules are enforced on-chain.",
    supportedRules: ["MAX_POSITION_SIZE", "MAX_TRADE_FREQUENCY", "MAX_DAILY_LOSS"],
    ruleLabels: {
      MAX_POSITION_SIZE: "Max amount per trade (per token)",
      MAX_TRADE_FREQUENCY: "Max buys per day",
      MAX_DAILY_LOSS: "Max daily loss ($)",
    },
    supportedRoutes: ["PancakeSwap V2 Router"],
    unsupportedNote:
      "Other routers (PancakeSwap Smart Router and Universal Router, other exchanges and aggregators) are rejected until support for them is added.",
    explorerUrl: "https://bscscan.com/address/",
    nativeSymbol: "BNB",
    tokens: [
      { symbol: "BNB", address: NATIVE, note: "native coin" },
      { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", note: "stablecoin" },
      { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", note: "stablecoin" },
      { symbol: "BUSD", address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", note: "stablecoin" },
      { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", note: "wrapped BNB" },
    ],
  },
  {
    id: "ethereum-uniswap",
    name: "Uniswap",
    chainName: "Ethereum",
    chainId: 1,
    kind: "safe-guard",
    exchangeName: "Uniswap",
    summary: "Spot trading in a Safe wallet on Ethereum. Rules are enforced on-chain.",
    supportedRules: ["MAX_POSITION_SIZE", "MAX_TRADE_FREQUENCY", "MAX_DAILY_LOSS"],
    ruleLabels: {
      MAX_POSITION_SIZE: "Max amount per trade (per token)",
      MAX_TRADE_FREQUENCY: "Max buys per day",
      MAX_DAILY_LOSS: "Max daily loss ($)",
    },
    supportedRoutes: ["Uniswap V2 Router", "Uniswap V3 routers"],
    unsupportedNote: "Other routers, including the Universal Router, are rejected until support for them is added.",
    explorerUrl: "https://etherscan.io/address/",
    nativeSymbol: "ETH",
    tokens: [
      { symbol: "ETH", address: NATIVE, note: "native coin" },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", note: "stablecoin" },
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", note: "stablecoin" },
      { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", note: "stablecoin" },
      { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", note: "wrapped ETH" },
    ],
  },
  {
    id: "arbitrum-gmx",
    name: "GMX",
    chainName: "Arbitrum",
    chainId: 42161,
    kind: "safe-guard",
    exchangeName: "GMX",
    summary: "Perpetuals in a Safe wallet on Arbitrum. Rules are enforced on-chain.",
    supportedRoutes: ["GMX Exchange Router"],
    unsupportedNote: "Other contracts are rejected until support for them is added.",
    explorerUrl: "https://arbiscan.io/address/",
    nativeSymbol: "ETH",
    tokens: [
      { symbol: "ETH", address: NATIVE, note: "native coin" },
      { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", note: "stablecoin" },
      { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", note: "stablecoin" },
      { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", note: "wrapped ETH" },
    ],
  },
  {
    id: "hyperliquid",
    name: "Hyperliquid",
    chainName: "Hyperliquid",
    kind: "agent-wallet",
    exchangeName: "Hyperliquid",
    summary: "Perpetuals through an approved agent wallet. Orders are risk-checked before they are signed.",
  },
];

const UNKNOWN_VENUE: VenueConfig = {
  id: "unknown",
  name: "Unknown venue",
  chainName: "",
  kind: "agent-wallet",
  exchangeName: "the exchange",
  summary: "",
};

export function getVenue(id: string | undefined | null): VenueConfig {
  return VENUES.find((v) => v.id === id) ?? { ...UNKNOWN_VENUE, id: id ?? "unknown", name: id ?? UNKNOWN_VENUE.name };
}

export function isSafeVenue(venue: VenueConfig): boolean {
  return venue.kind === "safe-guard";
}
