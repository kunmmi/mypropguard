# WETH Canonical Address and UniswapV2Router02 Deployment Stability (Ethereum Mainnet)

## What is the canonical WETH9 contract address on Ethereum mainnet, and is it the same one Uniswap V2 uses?

### Takeaway
The canonical WETH9 contract on Ethereum mainnet is `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, verified on Etherscan as "Wrapped Ether," and this is the same address wired into UniswapV2Router02's constructor as the `_WETH` parameter.

### Cited Findings
- Etherscan's verified "Wrapped Ether" token/contract page is at address `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, contract name WETH9, compiled with Solidity v0.4.19, source verification status "Exact Match." — [Etherscan: Wrapped Ether](https://etherscan.io/token/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2)
- WETH9 decimals: 18; it implements standard ERC-20 functions plus `deposit()`/`withdraw()` to wrap/unwrap ETH 1:1. — [Etherscan: Wrapped Ether](https://etherscan.io/token/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2)
- UniswapV2Router02 (`0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D`) is verified on Etherscan with a constructor taking two addresses: `_factory` (UniswapV2Factory) and `_WETH` (Wrapped Ether token address), exposed via a public `WETH()` getter. — [Etherscan: UniswapV2Router02](https://etherscan.io/address/0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D)
- Note: I was not able to directly read the literal constructor-argument hex value for `_WETH` from the fetched Etherscan page content (the fetch summarized the ABI/constructor shape rather than quoting the raw encoded argument). The identity of Router02's `_WETH` with the canonical WETH9 address is corroborated by the official Uniswap deployments doc and by universal community/developer references to this router, but should be flagged as not independently re-derived byte-for-byte from the constructor-args hex in this research pass.
- Uniswap's official developer docs list `UniswapV2Router02` mainnet address as `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` and `UniswapV2Factory` mainnet address as `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`; this specific doc page did not separately enumerate a WETH mainnet address. — [Uniswap V2 Deployments](https://developers.uniswap.org/docs/protocols/v2/deployments.md)

### Inferences
- Because Router02's constructor hardcodes a single `_WETH` address at deployment and that value cannot be changed post-deployment (no setter was found/referenced), and because the Router02 address itself has never changed (see next section), the WETH address Uniswap V2 has used since its 2020 deployment is fixed and is the same `0xC02...6Cc2` address shown on Etherscan's canonical WETH9 page.

### Gaps
- Did not independently decode the raw constructor-argument bytes from Etherscan to triple-confirm the exact `_WETH` value byte-for-byte (the WebFetch summarization did not surface the raw hex). High confidence via docs + ecosystem convention, but this is the one fact in this note not verified at the lowest possible level of primary-source granularity.

## Is this WETH address used as "the" canonical WETH across other major DeFi protocols, not just Uniswap?

### Takeaway
Yes — `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` is treated as the one canonical WETH across Ethereum mainnet DeFi generally (Aave, Compound, MakerDAO, SushiSwap, etc.), not a Uniswap-specific token; it is simply the first/longest-standing WETH9 deployment that the ecosystem standardized on.

### Cited Findings
- General DeFi commentary states protocols such as Aave, Compound, and MakerDAO use WETH (this same contract) because they require ERC-20-compliant tokens for lending/borrowing/collateral, and that WETH is also the standard pairing asset on DEXs like Uniswap and SushiSwap. — [Hashport Explores: Know Your Tokens](https://medium.com/coinmonks/hashport-explores-know-your-tokens-85a17dc8af69); [search synthesis citing market data, metamask.io/price/weth]
- This sourcing is secondary/aggregator-level (search-engine synthesis, not each protocol's own verified contract page individually cross-checked in this pass). It should be flagged as **not independently confirmed from each protocol's own primary source** (e.g., I did not pull Aave's or Compound's own deployed contract registries to verify they reference this exact address).

### Inferences
- Given WETH9's precedent (oldest major wrapped-ETH deployment, billions in TVL, 3.3M+ holders per Etherscan), and that it is the address referenced in Uniswap's own official docs/contracts, it is reasonable to treat it as "the" canonical WETH that other protocols also integrate — but this note flags that claim as resting on secondary sources rather than a primary cross-check of each named protocol's deployment registry.

### Gaps
- Did not fetch Aave's, Compound's, or MakerDAO's own official contract-address documentation to primary-source-confirm each uses this exact WETH address (time-boxed out of scope per tool budget). Flagged as unconfirmed at the primary-source level, though broadly consistent with well-known ecosystem convention.

## When was UniswapV2Router02 originally deployed on Ethereum mainnet, and has its address ever changed?

### Takeaway
UniswapV2Router02 was deployed at `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` on June 5, 2020 (block 10,207,858) and has remained at that single address ever since — unlike GMX's router, Uniswap has never redeployed or migrated V2 router users to a new address.

### Cited Findings
- Contract creation transaction for UniswapV2Router02: hash `0x4fc1580e7f66c58b7c26881cce0aab9c3509afe6e507527f30566fbf8039bcd0`, dated June 5, 2020, 8:17:21 PM UTC, block 10,207,858, deployed by `0x9C33eaCc2F50E39940D3AfaF2c7B8246B681A374` ("Uniswap: Deployer 2"). — [Etherscan tx](https://etherscan.io/tx/0x4fc1580e7f66c58b7c26881cce0aab9c3509afe6e507527f30566fbf8039bcd0); [Etherscan: UniswapV2Router02](https://etherscan.io/address/0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D)
- Uniswap's own current developer docs still list `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` as the live UniswapV2Router02 mainnet address (as of this research, Oct 2026) — i.e., over six years after original deployment, it is still the documented, current address. — [Uniswap V2 Deployments](https://developers.uniswap.org/docs/protocols/v2/deployments.md)
- No announcement, GitHub release note, or community discussion was found describing a UniswapV2Router02 redeployment, migration, or deprecation of this specific address. Search results instead surfaced redeployments/versioning of a *different*, newer product — the "Universal Router" (Uniswap's unified swap router for V2/V3/V4, used e.g. on newer chains like "Robinhood Chain") — which does get versioned/redeployed (e.g., v2.1.1 → v2.1.2, and a "Sunset of Universal Router 2.0 and 2.1.1" notice). This is a distinct contract line from the original `UniswapV2Router02` periphery contract and should not be confused with it. — [Sunset of Universal Router 2.0 and 2.1.1](https://developers.uniswap.org/docs/changelog/active-notifications/sunset-of-universal-router-2-0-and-2-1-1); [Universal Router Deployments & Addresses](https://chainscorelabs.com/protocol/uniswap/operations-and-releases/universal-router-contract-deployments-and-addresses)
- Community/dev commentary explicitly frames Uniswap V2 periphery routers as safe to deprecate-in-place (old router left untouched, new one recommended) precisely *because* "the periphery contracts are stateless and don't hold any assets" — reinforcing that Router02 itself was never redeployed; rather, Router01 was superseded by Router02 once, back in 2020, and Router02 has been stable since. — [search synthesis of Uniswap V2 docs/dev commentary]

### Inferences
- UniswapV2Router02's stability (single unchanged address for 6+ years, still the documented current address) is structurally supported by it being a stateless periphery contract with no admin/upgrade mechanism — there is no owner-controlled proxy or migration path referenced anywhere in the sources found, consistent with "deploy once, never touch again."
- The only "router change" in Uniswap V2's history was the one-time Router01 → Router02 upgrade (both occurred close together in 2020), not a recurring redeployment pattern like GMX's router.

### Gaps
- Did not find an exact deployment date/block for Router01 (the predecessor) to establish how close in time the one-time Router01→Router02 switch happened relative to Router02's June 5, 2020 deployment; this is a minor gap and doesn't affect the core finding about Router02's own stability.
- Did not find an explicit Uniswap Labs blog post or GitHub release note stating "we will never redeploy Router02" — the stability finding rests on absence of any contrary evidence (no migration announcement found) plus the current docs still pointing at the original address, not on an explicit permanence statement from Uniswap.

## Is there an older UniswapV2Router01 at a different, deprecated address?

### Takeaway
Yes — UniswapV2Router01 is a distinct, older, now-deprecated contract at `0xf164fC0Ec4E93095b804a4795bBe1e041497b92a` on Ethereum mainnet, separate from and superseded by UniswapV2Router02.

### Cited Findings
- UniswapV2Router01 is deployed at `0xf164fC0Ec4E93095b804a4795bBe1e041497b92a` on Ethereum mainnet (also appeared historically on Ropsten, Rinkeby, Görli, and Kovan testnets, all now deprecated/sunset networks). — [search result synthesis citing Uniswap V2 docs: Router01](https://docs.uniswap.org/contracts/v2/reference/smart-contracts/router-01)
- Router01 is deprecated due to a low-severity bug and because some of its methods do not correctly support fee-on-transfer tokens; UniswapV2Router02 was built to fix this and is the recommended contract going forward. — [search synthesis of Uniswap V2 docs]

### Inferences
- Router01's address (`0xf164...97b92a`) and Router02's address (`0x7a25...2488D`) are both still live/unchanged on-chain (periphery contracts are never destroyed), but only Router02 is the actively documented/recommended one — Router01 should be treated purely as deprecated legacy, not as evidence of Router02 ever being redeployed.

### Gaps
- Did not independently pull Router01's own Etherscan contract-creation page to confirm its exact deployment date/block (to compare timing against Router02's June 5, 2020 deployment). Low priority since it doesn't affect the core Router02 stability finding.
