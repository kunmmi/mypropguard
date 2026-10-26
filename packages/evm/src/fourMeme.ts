import { parseAbi, type Address } from "viem";

/**
 * four.meme's contracts on BNB Chain and the functions a trader's wallet calls on them.
 * Source: four.meme's own integration docs (github.com/four-meme-community/fourmeme-docs, docs/trade-guide.md and
 * abi/TokenManager2.lite.json), checked 2026-10-26.
 *
 * Why this file exists: the trading wallet can only judge a call it understands. A buy is a call to one of these
 * managers that carries BNB; a sell is a call that carries none. Any call the wallet cannot decode against these
 * signatures is refused rather than guessed at.
 */

export const FOUR_MEME_BSC = {
  /** TokenManager (V1) — tokens created before 2024-09-05. */
  tokenManagerV1: "0xEC4549caDcE5DA21Df6E6422d448034B5233bFbC" as Address,
  /** TokenManager2 (V2) — every token created since. */
  tokenManagerV2: "0x5c952063c7fc8610FFDB798152D69F0B9550762b" as Address,
  /** TokenManagerHelper3 — router for ERC-20-quoted pairs. */
  helper3: "0xF251F83e40a78868FcfA3FA4599Dad6494E46034" as Address,
} as const;

/** What a TokenManager2 buy or sell looks like on the wire. Overloads are told apart by selector. */
export const TOKEN_MANAGER_V2_ABI = parseAbi([
  "function buyToken(uint256 origin, address token, uint256 amount, uint256 maxFunds) payable",
  "function buyToken(address token, address to, uint256 amount, uint256 maxFunds) payable",
  "function buyToken(uint256 origin, address token, address to, uint256 amount, uint256 maxFunds) payable",
  "function buyToken(address token, uint256 amount, uint256 maxFunds) payable",
  "function buyTokenAMAP(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable",
  "function buyTokenAMAP(address token, address to, uint256 funds, uint256 minAmount) payable",
  "function buyTokenAMAP(address token, uint256 funds, uint256 minAmount) payable",
  "function buyTokenAMAP(uint256 origin, address token, uint256 funds, uint256 minAmount) payable",
  "function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)",
  "function sellToken(uint256 origin, address token, uint256 amount, uint256 minFunds)",
  "function sellToken(uint256 origin, address token, uint256 amount)",
  "function sellToken(address token, uint256 amount, uint256 minFunds)",
  "function sellToken(uint256 origin, address token, address from, address to, uint256 amount, uint256 minFunds)",
  "function sellToken(uint256 origin, address token, address from, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)",
  "function sellToken(address token, uint256 amount)",
]);

/** TokenManager (V1) — older tokens. */
export const TOKEN_MANAGER_V1_ABI = parseAbi([
  "function purchaseTokenAMAP(address token, uint256 funds, uint256 minAmount) payable",
  "function purchaseToken(address token, uint256 amount, uint256 maxFunds) payable",
  "function purchaseTokenAMAP(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable",
  "function purchaseToken(uint256 origin, address token, address to, uint256 amount, uint256 maxFunds) payable",
  "function saleToken(address token, uint256 amount)",
]);

/** TokenManagerHelper3 — ERC-20/ERC-20 pairs (BNB in, or BNB out). */
export const HELPER3_ABI = parseAbi([
  "function buyWithEth(uint256 origin, address token, address to, uint256 funds, uint256 minAmount) payable",
  "function sellForEth(uint256 origin, address token, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)",
  "function sellForEth(uint256 origin, address token, address from, uint256 amount, uint256 minFunds, uint256 feeRate, address feeRecipient)",
  "function sellForEth(uint256 origin, address token, address from, address to, uint256 amount, uint256 minFunds)",
]);

/** Router fee on a sell is capped by four.meme at 5% (feeRate / 10000). Anything above is refused. */
export const MAX_ROUTER_FEE_RATE = 500;

/** Read-only quotes from TokenManagerHelper3 (source: four.meme's ITokenManagerHelper3.sol, checked 2026-10-26). */
export const HELPER3_VIEW_ABI = parseAbi([
  "function getTokenInfo(address token) view returns (uint256 version, address tokenManager, address quote, uint256 lastPrice, uint256 tradingFeeRate, uint256 minTradingFee, uint256 launchTime, uint256 offers, uint256 maxOffers, uint256 funds, uint256 maxFunds, bool liquidityAdded)",
  "function tryBuy(address token, uint256 amount, uint256 funds) view returns (address tokenManager, address quote, uint256 estimatedAmount, uint256 estimatedCost, uint256 estimatedFee, uint256 amountMsgValue, uint256 amountApproval, uint256 amountFunds)",
  "function trySell(address token, uint256 amount) view returns (address tokenManager, address quote, uint256 funds, uint256 fee)",
]);

/** Where a four.meme token trades once it has outgrown the bonding curve. */
export const PANCAKE_V2_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E" as Address;
export const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address;
export const PANCAKE_ROUTER_ABI = parseAbi(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
