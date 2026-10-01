# Smart-Contract-Wallet (Safe / ERC-4337) Compatibility of EVM Perps Protocols

## GMX (v1 and v2) — Arbitrum/Avalanche

### Takeaway
GMX's core on-chain position logic (open/modify/close) does not require `msg.sender` to be an EOA — "Classic Trading" works fine from a Safe or other smart-contract wallet. The incompatibility is confined to GMX's newer convenience layers: "Express Trading" / "One-Click Trading" and the "GMX Account" abstraction feature, which rely on off-chain signatures relayed via Gelato and are explicitly documented as not yet working with smart wallets. No evidence was found of a public risk-limiting Guard/module built specifically for GMX.

### Cited Findings
- "Smart wallets like Safe can't use the GMX Account because it requires Express Trading, which isn't compatible with smart wallets yet." — [GMX Trading overview docs](https://docs.gmx.io/docs/trading/overview/)
- "Smart wallets don't support Express Trading or One-Click Trading, but Classic Trading is available if you're using a smart wallet." — [GMX Trading overview docs](https://docs.gmx.io/docs/trading/overview/)
- "When you open or increase a position, positions belong to the connected wallet and are shown together, whether they were opened with wallet funds or GMX Account funds." — [GMX Trading overview docs](https://docs.gmx.io/docs/trading/overview/)
- Express Trading uses off-chain signature methods and Gelato Relay for transaction processing — [GMX Express announcement](https://gmxio.substack.com/p/introducing-gmx-express-a-fast-frictionless)
- GMX v2's core contracts repo (gmx-synthetics) is the canonical place to check entry-point function signatures (OrderHandler/ExchangeRouter), but no explicit `tx.origin`/EOA-only gate was identified in search results for the core order-creation path — [gmx-io/gmx-synthetics GitHub](https://github.com/gmx-io/gmx-synthetics)

### Inferences
- Because "Classic Trading" (plain on-chain tx calling GMX router/exchange contracts) is explicitly confirmed usable by smart wallets, GMX's base position-management functions do not gate on EOA-ness — the restriction is a front-end/UX feature (Express/One-Click) layered on top via relayers, not a contract-level `msg.sender == tx.origin` check on the position functions themselves.
- This makes GMX (Classic Trading path) a plausible target for a third-party Safe Guard or ERC-4337 module that wraps the ExchangeRouter/OrderHandler calls with position-size/leverage/loss checks, since calls can originate from a smart account unmodified.

### Gaps
- Did not get direct confirmation from the gmx-synthetics source code (OrderHandler.sol / ExchangeRouter.sol) of the absence of any `tx.origin` check; this is an inference from the docs statement about Classic Trading working with smart wallets, not a line-by-line code audit.
- No evidence found (via GitHub/ETHGlobal search) of any existing public Guard, module, or wrapper contract specifically targeting GMX for risk limits (position size/leverage/loss caps). This appears to be an open gap — either it doesn't exist publicly, or it is not indexed under discoverable terms.
- No specific documented account of a trader or fund using a Safe multisig for active GMX trading (e.g., a public post-mortem, Dune dashboard, or forum thread) was found; only indirect doc evidence that it's supported.

---

## Synthetix Perps v3 — Optimism/Base

### Takeaway
Synthetix Perps V3 uses an NFT-based ("account NFT") permission system where an account's owner — any address, EOA or contract — holds an ERC-721 token representing trading rights and can delegate granular permissions to other addresses. This architecture is inherently account-abstraction-friendly in design intent, but no source was found explicitly confirming absence of EOA-only checks in the position-modifying functions, nor confirming real-world Safe/ERC-4337 usage, nor any third-party risk-limiting wrapper built for it.

### Cited Findings
- "New features in Perps V3 include delegation of account permissions, and NFT-controlled accounts enable transfer and permission access." — [Synthetix Perps V3 Features & Release Explainer](https://blog.synthetix.io/perps-v3-features-release-explainer/)
- Synthetix V3 Core (which Perps V3 is built on) deployed on Base mainnet in January 2024, completing the V3 upgrade — [The Block: Synthetix deploys first perpetuals protocol on Base](https://www.theblock.co/post/274350/synthetix-deploys-first-perpetuals-protocol-on-base-blockchain)
- Contract ABIs/addresses are published at the Synthetixio v3-contracts GitHub repo for direct code review — [Synthetixio/v3-contracts](https://github.com/Synthetixio/v3-contracts)

### Inferences
- The NFT-account + delegated-permissions model suggests Synthetix Perps V3 was designed with multi-party/contract-owned accounts in mind (an NFT can be held by a Safe just like any other ERC-721), making an EOA-only restriction on the core account functions unlikely by design intent — but this is an inference from the feature description, not a confirmed absence of a `tx.origin`/EOA check in the code.

### Gaps
- Could not confirm from available search results whether any specific Perps V3 function (e.g., position modification, margin management) contains an EOA-only (`msg.sender == tx.origin`) gate — would require direct source review of the PerpsMarket/Account modules in the Synthetixio contracts repo, which was not fetched in this pass.
- No evidence (positive or negative) found regarding real-world use of Safe multisigs or ERC-4337 smart accounts to trade Synthetix Perps V3 today.
- No evidence found of a third-party Guard/module/wrapper built specifically for Synthetix Perps V3 risk limiting.

---

## Gains Network (gTrade) — Polygon/Arbitrum/Base

### Takeaway
No direct evidence was found regarding gTrade's contract-level EOA dependency, real-world smart-account usage, or any third-party risk-limiting wrapper. Available sources only cover gTrade's governance/treasury multisig structure, not end-user trading account mechanics.

### Cited Findings
- gTrade is Gains Network's decentralized perpetuals exchange offering up to 500x leverage across 290+ pairs (crypto, forex, stocks, indices, commodities) — [Gains Network overview, Alchemy](https://www.alchemy.com/dapps/gains-network)
- Gains Network's treasury multisig (0xc07EEd...) is a 4-of-7 Gnosis Safe used for governance/treasury funds, not for end-user trading positions — [DefiSafety report on Gains Network](https://defisafety.com/app/pqrs/518)
- Contracts have been audited by Halborn (current) and previously Certik (8+ audits) — [DefiSafety report on Gains Network](https://defisafety.com/app/pqrs/518)
- Full contract addresses are published at the official docs — [Gains Network Contract Addresses](https://docs.gains.trade/what-is-gains-network/contract-addresses)

### Gaps
- No evidence found (positive or negative) on whether gTrade's position-opening/closing functions impose an EOA-only check on the trader's address — this would require direct review of the gTrade core trading contract (e.g., GNSTradingV6.4.1 or newer modular Diamond-pattern contracts) which was not performed in this pass.
- No evidence found of documented Safe/ERC-4337 smart-account usage by gTrade traders specifically (only the protocol's own governance multisig was found, which is a different thing).
- No evidence found of a third-party risk-limiting Guard/module/wrapper built specifically for gTrade.

---

## dYdX v4 — Cosmos app-chain (non-EVM)

### Takeaway
dYdX v4 is confirmed to be a fully sovereign Cosmos SDK / CometBFT application-specific blockchain, not an EVM chain or a set of smart contracts on any EVM chain — it is therefore out of scope for this research's core question (Safe/ERC-4337 compatibility is an EVM/Ethereum-account-abstraction-specific concept that does not apply to a Cosmos app-chain's native module-based accounts).

### Cited Findings
- "The dYdX v4 software (the 'dYdX Chain') is a sovereign blockchain software built using Cosmos SDK and CometBFT." — [dydxprotocol/v4-chain GitHub](https://github.com/dydxprotocol/v4-chain)
- dYdX v4 migrated from the Ethereum ecosystem (v3, which ran as a StarkEx-based L2) to a standalone Cosmos app-chain, moving the order book and matching engine into a distributed validator network rather than smart contracts — [dYdX v4: Architectural and Protocol Evolution from v3](https://medium.com/@gwrx2005/dydx-v4-architectural-and-protocol-evolution-from-v3-6c312f51f7b7)
- "The dYdX Chain is a sovereign app-chain that does not rely on Ethereum or any external L1 for execution or security." — [v4 Technical Architecture Overview, dYdX blog](https://www.dydx.xyz/blog/v4-technical-architecture-overview)

### Inferences
- Since dYdX v4 trading is executed via Cosmos SDK transactions/modules signed against Cosmos-native account types (not Solidity smart contracts callable by `msg.sender`), the Safe (Gnosis Safe, an Ethereum smart contract) and ERC-4337 (an Ethereum account-abstraction standard) concepts do not directly apply. Cosmos has its own distinct account-abstraction/multisig primitives (e.g., Cosmos SDK multisig accounts, IBC), which are a different research question entirely and were not investigated here as out of scope.

### Gaps
- Not investigated: whether Cosmos-native multisig or smart-contract-account equivalents exist for dYdX v4 specifically — out of scope per the research assignment, which asked only to confirm and flag the non-EVM status.

---

## Hyperliquid HyperEVM — builder-deployed perps distinct from native HyperCore

### Takeaway
As of early-to-mid 2026, "builder-deployed perpetuals" on Hyperliquid (HIP-3, live on mainnet since October 13, 2025) are deployed and operate on **HyperCore** (the native, non-EVM, precompiled perp-DEX state machine), not as independent Solidity smart contracts on HyperEVM. HyperEVM itself is a separate general-purpose EVM execution layer that can read HyperCore state via precompiles and host its own dApps (e.g., HyperSwap, an AMM/DEX), but no evidence was found of a perpetuals exchange built as a standalone HyperEVM smart-contract orderbook independent of HyperCore. This matters because HIP-3 builder-deployed perps inherit HyperCore's non-programmable, precompile-based architecture (which this research already treats as not smart-contract-wallet-programmable in the same sense as a Solidity perps protocol), while genuinely EVM-native perp contracts on HyperEVM were not found to exist yet.

### Cited Findings
- "HyperEVM is the Ethereum-compatible execution layer that runs inside the Hyperliquid chain... went live on mainnet in February 2025, and by early 2026 it hosts lending markets, liquid-staking tokens, money markets, and the canonical USDT0 deployment." — [eco.com: What Is HyperEVM?](https://eco.com/support/en/articles/15192000-what-is-hyperevm-hyperliquid-s-evm-layer-for-defi-in-2026)
- "HIP-3 (Hyperliquid Improvement Proposal 3)... launched on Hyperliquid's mainnet on October 13, 2025" and "lets qualified builders launch independent perpetual futures DEXs on Hyperliquid's HyperCore infrastructure" by staking 500,000 HYPE — [CCN: How Hyperliquid's HIP-3 Lets Builders Define Perp Markets](https://www.ccn.com/education/crypto/hyperliquid-hip3-builders-launch-perp-markets/); [Finance Yahoo: Hyperliquid Goes Permissionless with HIP-3](https://finance.yahoo.com/news/hyperliquid-goes-permissionless-hip-3-143449177.html)
- HIP-3 lets builders "deploy perpetual markets, define oracles and contract specifications, operate markets, set leverage limits, and settle markets" — [CCN: HIP-3 explainer](https://www.ccn.com/education/crypto/hyperliquid-hip3-builders-launch-perp-markets/)
- Hyperliquid is extending HIP-3 with an opt-in "HIP-3*" add-on featuring an on-chain allowlist where a deployer/sub-deployer can add or remove wallet addresses permitted to trade on that venue — [Crowdfund Insider: Hyperliquid Extends HIP-3 With Opt-In Permissioned Markets](https://www.crowdfundinsider.com/2026/09/306361-hyperliquid-extends-hip-3-with-opt-in-permissioned-perpetual-markets/)
- "HyperCore handles the on-chain Central Limit Order Book... HyperEVM adds a general-purpose, Ethereum-compatible smart contract layer that lets DeFi protocols integrate directly with the order book" — [thirdweb blog: Perp DEX Infrastructure](https://blog.thirdweb.com/perp-dex-infrastructure-how-order-books-are-winning-onchain/)
- HyperSwap is described as "the first native DEX for HyperEVM" (an AMM, not a perps orderbook) — search result summary citing [Four Pillars research](https://x.com/FourPillarsFP/status/1924751319983915246)

### Inferences
- Builder-deployed perps under HIP-3 run on HyperCore's own account/order model (addresses, not necessarily EVM `msg.sender` semantics in the Solidity sense), so the Safe/ERC-4337 compatibility question as posed for Solidity-based protocols does not map cleanly onto HIP-3 markets — they are a distinct, non-EVM-contract execution environment even though HyperEVM contracts can read HyperCore state via precompiles.
- Because no standalone EVM-native perps smart contract protocol was found running purely on HyperEVM (independent of HyperCore), there is currently no clear target on HyperEVM for a conventional Safe Guard/ERC-4337 module of the kind this research is scoping — this may change as HyperEVM's DeFi ecosystem matures.

### Gaps
- Could not confirm with certainty whether HyperCore position-opening calls (whether for native markets or HIP-3 builder markets) can be initiated by a Safe or ERC-4337 smart account address, since HyperCore is not a standard EVM smart-contract environment — this would require checking Hyperliquid's own API/SDK documentation on address/account types, which was not fetched in this pass.
- No evidence found of any third-party Guard/module/wrapper built for HIP-3 builder-deployed perps or for any HyperEVM-native perps protocol (none were confirmed to exist as of this research).
- Did not find confirmation of any purely-HyperEVM-smart-contract perpetuals DEX (as opposed to HIP-3/HyperCore-based ones) existing as of October 2026 — flagged as an open question for future research passes.

---

## BSC-native perps (ApolloX)

### Takeaway
No evidence was found either confirming or denying an EOA-only restriction in ApolloX's trading contracts, nor of real-world Safe/ERC-4337 usage by ApolloX traders, nor of a third-party risk-limiting wrapper. ApolloX's own documented multisig usage is limited to a treasury/circuit-breaker security control, not user trading accounts.

### Cited Findings
- ApolloX is "a futures DEX platform that started from BSC Chain and now also supports Ethereum and Arbitrum," and is described as the largest futures DEX on BSC by volume and active addresses — [search-aggregated source on ApolloX overview]
- ApolloX supports wallet connections including Binance Wallet, MetaMask, and Coinbase Wallet (standard EOA-oriented wallet connect flow; no explicit mention of Safe/smart-account support) — [ApolloX Finance Wallet Connection docs](https://apollox-finance.gitbook.io/apollox-finance/welcome/trading-on-v1/wallet-connection)
- ApolloX Perpetuals contracts use the Diamond proxy pattern (EIP-2535) for modular, upgradeable architecture — [DeepWiki: apollox-finance/apollox-perp-contracts](https://deepwiki.com/apollox-finance/apollox-perp-contracts)
- ApolloX has a security control where transfers exceeding $1 million within one hour trigger a suspension that requires a multisig to lift — this is a treasury/safety-module multisig, not a user-trading smart-account feature — [search-aggregated source]

### Inferences
- None drawn with confidence; the Diamond-proxy architecture and standard WalletConnect-style wallet integration give no direct signal either way on EOA-only gating of position functions, since EIP-2535 is an upgradeability pattern unrelated to caller-type restrictions.

### Gaps
- No direct review of ApolloX's core trading facet contracts (e.g., the Diamond facets handling open/close position) was performed to check for `tx.origin`/EOA checks — the apollox-finance/apollox-perp-contracts GitHub repo (via DeepWiki) would be the next step.
- No evidence found of documented Safe or ERC-4337 smart-account use by ApolloX traders.
- No evidence found of a third-party Guard/module/wrapper built specifically for ApolloX or other BSC-native perps DEXs. Other BSC perps protocols (e.g., ones built via GMX forks on BSC) were not individually investigated beyond ApolloX given the time budget; this is a gap if the user wants broader BSC coverage.

---

## Cross-cutting: General Safe/ERC-4337 Guard and Module Infrastructure

### Takeaway
Safe's own modular architecture (Safe Modules / Safe4337Module / ERC-7579) provides the generic plumbing that any third-party risk-limiting wrapper for a perps protocol would be built on, but no evidence was found of any existing public Guard, module, or wrapper contract that applies position-size, leverage, or loss limits specifically to any of the six protocols researched (GMX, Synthetix Perps, gTrade, dYdX v4, Hyperliquid/HyperEVM, or ApolloX/BSC perps). ETHGlobal showcase search surfaced risk-management-themed hackathon projects (e.g., "LendGuard," "D-Risk," "Perpetua") but these target lending protocols or build generic/own perps infrastructure rather than wrapping an existing named protocol like GMX or gTrade with a Safe Guard.

### Cited Findings
- "The Safe4337Module is an extension to the Safe Smart Account that acts both as a Fallback Handler and a Safe Module... it implements the ERC-4337 interface... and it's limited to the EntryPoint address." — [Safe docs: Safe and ERC-4337](https://docs.safe.global/advanced/erc-4337/4337-safe)
- Safe Modules are maintained at the `safe-global/safe-modules` GitHub org, and core Safe contracts at `safe-global/safe-smart-account` — [Safe docs](https://docs.safe.global/advanced/erc-4337/4337-safe)
- Safe also supports ERC-7579 modular account standard — [Safe docs: Safe and ERC-7579](https://docs.safe.global/advanced/erc-7579/7579-safe)
- ETHGlobal showcase project "LendGuard" lets users "configure and deploy custom Guards" as extensions of lending pools with a Keeper module monitoring thresholds and alerting via Push Protocol — this is for lending, not perps — [ETHGlobal showcase: LendGuard](https://ethglobal.com/showcase/lendguard-ufrz9)
- ETHGlobal showcase project "Perpetua" features automated liquidation/margin monitoring but appears to be a standalone perps platform prototype, not a wrapper around an existing named protocol — [ETHGlobal showcase: Perpetua](https://ethglobal.com/showcase/perpetua-8jbqc)
- ETHGlobal showcase project "Perpetuals Platform Pro" is an on-chain AMM-based futures platform (own infrastructure, Chainlink oracles, IPFS), not a wrapper on GMX/Synthetix/etc. — [ETHGlobal showcase: Perpetuals Platform Pro](https://ethglobal.com/showcase/perpetuals-platform-pro-9idy8)

### Inferences
- The absence of findable public Guard/module/wrapper projects targeting these specific named perps protocols suggests this is a relatively unaddressed niche — consistent with an opportunity gap rather than a saturated space — but this is an inference from absence of search results, not a confirmed negative (a targeted GitHub code-search across each protocol's contract addresses, or a search of ETHGlobal with more specific protocol names like "GMX hackathon risk," was not exhaustively performed given the tool-call budget).

### Gaps
- Did not perform a GitHub code-search (e.g., `github.com/search?q=GMX+Guard+Safe`) directly against GitHub's search index — relied on general web search, which may under-index GitHub repo contents. A follow-up pass using GitHub's own code search API/UI would strengthen confidence in the "no existing wrapper found" conclusion.
- Did not search ETHGlobal showcase using each protocol's name individually (e.g., "ETHGlobal gTrade," "ETHGlobal Synthetix Perps guard") due to tool-call budget constraints — flagged as a gap for a deeper follow-up pass.
