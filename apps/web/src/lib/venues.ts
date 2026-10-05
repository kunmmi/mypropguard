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
      MAX_TRADE_FREQUENCY: "Max trades per day",
      MAX_DAILY_LOSS: "Max daily loss ($)",
    },
    supportedRoutes: ["PancakeSwap V2 Router"],
    unsupportedNote:
      "Other routers (PancakeSwap Smart Router and Universal Router, other exchanges and aggregators) are rejected until support for them is added.",
    explorerUrl: "https://bscscan.com/address/",
    nativeSymbol: "BNB",
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
      MAX_TRADE_FREQUENCY: "Max trades per day",
      MAX_DAILY_LOSS: "Max daily loss ($)",
    },
    supportedRoutes: ["Uniswap V2 Router", "Uniswap V3 routers"],
    unsupportedNote: "Other routers, including the Universal Router, are rejected until support for them is added.",
    explorerUrl: "https://etherscan.io/address/",
    nativeSymbol: "ETH",
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
