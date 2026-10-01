# GMGN BSC Trade Routing — Does It Call PancakeSwap's Router Directly, or Its Own Contract?

## Does GMGN call PancakeSwap's router address directly from the user's wallet on BSC, or does it route through its own intermediary contract?

### Takeaway
No real GMGN BSC transaction hash was located, so the top-level `to` address of an actual GMGN-originated BSC trade was **not directly confirmed on BscScan**. However, GMGN's own public API documentation describes a backend-driven routing/quoting flow (the GMGN backend computes `inputdata`, `value`, and `gas_limit` for the user's wallet to sign), and GMGN charges its own trading fee on top of the underlying DEX trade — both are consistent with, but do not prove, a GMGN-controlled intermediary contract. This is the single most important open question and it remains **unresolved with direct on-chain evidence**.

### Cited Findings
- GMGN provides a `/defi/router/v1/tx/available_routes_exact_in` endpoint for ETH/Base/BSC that returns available routing, letting the caller choose a `route` source of `gmgn` (default) or `swapx` — [GMGN BSC Trading Bot Review (bsctradingbot.com)](https://bsctradingbot.com/bot/gmgn-ai); [GMGN routing docs](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-eth-base-bsc-trading-api/get-the-available-routing-for-eth-base-bsc-transactions)
- GMGN charges a 0.5% fee per trade on BSC, which is described as higher than PancakeSwap's own 0.25% fee — [GMGN AI – BSC Trading Bot Review](https://bsctradingbot.com/bot/gmgn-ai)
- GMGN's documented BSC trading flow is: (1) query the router to get the route, recommended slippage, and gas price; (2) simulate the transaction and get back a `data` field; (3) use "normal rpc or anti-pinch [anti-sandwich] rpc" to submit the formal transaction; the route/simulate response supplies parameters including `inputdata`, `value`, and `gas_limit` needed to submit on-chain — [GMGN Cooperation-API docs search summary, from docs.gmgn.ai index](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-eth-base-bsc-trading-api) (indexed via search; the specific routing and swap-simulation sub-pages returned 404 when fetched directly — see Gaps)
- A separate transaction-submission endpoint, `https://gmgn.ai/txproxy/v1/send_transaction`, exists on GMGN's domain for submitting signed/prepared transactions — [search summary citing docs.gmgn.ai Cooperation-API](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-solana-trading-api) (Note: this endpoint was described in a search-engine summary of GMGN's Solana cooperation-API docs; it was not independently verified by fetching the live page, and it is unclear whether it applies to BSC/EVM trades or only Solana — see Gaps)
- A third-party "GMGN CLI/agent skill" project (not GMGN's core consumer web/app product, but built against GMGN's agent API) states the skill "holds the private key locally and signs transactions on-machine; only the signature is transmitted over HTTPS," and that `--anti-mev` is on by default for SOL/BSC/ETH — [GMGNAI/gmgn-skills SKILL.md on GitHub](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-swap/SKILL.md)
- No verified BscScan contract was found carrying a "GMGN" name tag or label that is clearly GMGN's own BSC swap/router contract. Generic searches surfaced only unrelated "GMGN" BEP-20 token contracts (a memecoin ticker collision, not GMGN-the-platform) and PancakeSwap's own documented router/factory addresses — [BscScan search results, various unrelated GMGN-ticker token pages](https://bscscan.com/token/0x1470f04758ce66b351a4181e42b3b0e360716350); [PancakeSwap official testnet router/factory addresses posted on X](https://x.com/pancakeswap/status/1369547285160370182)
- GMGN's own BNB-chain promotional post advertises "Auto Approval" as a BSC bot feature but does not name or display the address that receives the approval — [GMGN.Ai announcement on X](https://x.com/gmgnai/status/1869368035737563545)

### Inferences
- The fact that GMGN's backend computes and returns `inputdata` / `value` / `gas_limit` for the client to submit (rather than the client independently calling PancakeSwap's router ABI with parameters it computed itself) is architecturally consistent with GMGN routing through its own contract or aggregator layer — but it is equally consistent with GMGN simply pre-encoding a direct call to PancakeSwap's (or another DEX's) router and handing back that calldata un-modified. The existence of a backend quoting/building API does **not**, by itself, prove an intermediary contract exists; it only proves GMGN controls transaction construction, not necessarily the destination address.
- GMGN levying its own 0.5% platform fee on a BSC trade (on top of PancakeSwap's fee) means fee extraction happens somewhere in the pipeline. The cleanest way to guarantee fee capture on every trade is to route through a GMGN-owned contract that skims a fee before/after forwarding to the DEX pool — this is a common aggregator pattern (similar to how 1inch, 0x, Jupiter, etc. take fees via their own contracts rather than trusting the destination router to pay them). This is suggestive but still an inference, not a confirmed fact.
- The "route source" choice between `gmgn` and `swapx` in the available-routing API implies GMGN's quoting engine can select between multiple underlying liquidity sources/routers for BSC — another sign that a single fixed call to PancakeSwap's router alone is unlikely to be the whole picture, since an aggregator-style router selection generally requires its own settlement/router contract to normalize calldata across sources.

### Gaps
- **No real GMGN BSC transaction hash was found.** This was the single most important piece of evidence requested and it was not obtained. Web search did not surface any Twitter/X post, Reddit thread, YouTube tutorial description, or forum post containing an actual GMGN-originated BSC tx hash or a BscScan link to one. Without this, the `to` address of a genuine GMGN BSC trade — and therefore whether it equals PancakeSwap's V2 router `0x10ED43C718714eb63d5aA57B78B54704E256024E`, the V3 SmartRouter, or a GMGN-specific contract — could not be directly verified.
- The two most relevant GMGN documentation sub-pages (`get-the-available-routing-for-eth-base-bsc-transactions` and `swap-transaction-simulation-eth-base-bsc`) returned HTTP 404 / "Page Not Found" when fetched directly (both as the normal URL and with a `.md` suffix), despite appearing in search engine indexes with seemingly live titles. It's possible GMGN restructured or gated these docs since the pages were indexed, or that the fetch tool used doesn't execute the client-side routing the docs site needs. This means the actual example JSON (with a concrete `to`/`router_address`/`contract_address` field) could not be read.
- An attempt to use GMGN's documentation site's own "ask the docs" query parameter (`...?ask=...`) to get a direct answer about the `to` address was blocked with an HTTP 403 Forbidden, likely because that interface requires a browser session or is rate-limited/blocked for non-browser fetches.
- Whether GMGN requires users to `approve` token spending to a GMGN-specific contract address (as opposed to approving PancakeSwap's router directly) was **not confirmed**. No tutorial, guide, or GMGN doc page was found that explicitly states or screenshots which address receives the ERC-20/BEP-20 `approve()` call during a BSC trade. GMGN's own marketing mentions an "Auto Approval" feature for its BSC bot but does not disclose the approved spender address.
- No verified BscScan contract explicitly labeled as "GMGN Router," "GMGN Aggregator," or similar was located. This could mean either (a) no such contract exists and GMGN truly forwards calls to PancakeSwap/other DEX routers directly, or (b) such a contract exists but isn't tagged with a recognizable public label on BscScan, or (c) search engines simply didn't surface it. This is inconclusive either way.
- GMGN's Telegram/Discord communities were not checked (no direct access/search capability for Telegram message history was available in this research pass); it's possible someone there has posted a transaction hash or asked this exact routing question before.

## Is GMGN's MEV protection implemented via a private relay/bundler, and does that imply trades can't be simple direct calls to a public router?

### Takeaway
Yes — GMGN's MEV protection is confirmed to work via private mempool / restricted-node transaction submission, not via smart-contract logic alone. GMGN offers a three-tier MEV protection setting, and its highest tier explicitly routes the transaction through a private mempool rather than the public one. This is a custom transaction *submission path* (an alternate RPC/relay), which is architecturally separate from, and does not by itself require, a custom destination *contract* — but it does confirm GMGN controls more of the pipeline than a simple "call the public router from the user's wallet via the public mempool" model.

### Cited Findings
- GMGN offers a three-mode MEV protection dial: "Off," "Reduced," and "Secure." In "Reduced" mode, transactions are sent to a limited set of nodes; in "Secure" mode, transactions are routed through private mempools for maximum protection — [search summary of GMGN MEV protection, sourced from Bitget/ChainCatcher/CoinCodeCap coverage](https://coincodecap.com/best-settings-for-gmgn-bot)
- GMGN has (or had) dedicated "BSC anti-sandwich nodes" intended to protect BSC trades from sandwich attacks — [GMGN.Ai's 13-Hour MEV Showdown (Bitget News)](https://www.bitget.com/news/detail/12560605034295)
- In October 2024, a 13-hour MEV sandwich attack bypassed GMGN's BSC anti-sandwich node protection, affecting 729 users; GMGN's co-founder subsequently promised compensation for victims and announced new security measures — [GMGN.Ai's 13-Hour MEV Showdown (Bitget)](https://www.bitget.com/news/detail/12560605034295); [GMGN.Ai reimburses users after MEV exploit hits 729 transactions (MEXC News)](https://www.mexc.com/en-NG/news/143969); [GMGN co-founder promises compensation (Bitget)](https://www.bitget.com/news/detail/12560604856490); [GMGN co-founder: users who enable MEV protection and still get clipped can apply for compensation (ChainCatcher)](https://www.chaincatcher.com/en/article/2190391)
- GMGN's documented BSC trade flow explicitly offers a choice between "normal rpc" and "anti-pinch [anti-sandwich] rpc" at the final submission step, confirming the anti-MEV behavior is implemented as an alternate RPC/relay path chosen at submission time, not purely a contract-level mechanism — [search summary of GMGN Cooperation-API docs](https://docs.gmgn.ai/index/cooperation-api-integrate-gmgn-eth-base-bsc-trading-api)
- A third-party GMGN CLI/agent-skill project confirms `--anti-mev` is on by default for SOL/BSC/ETH trades (but not Base) in that tool — [GMGNAI/gmgn-skills SKILL.md](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-swap/SKILL.md)

### Inferences
- Because "Secure" mode routes through a private mempool, a transaction submitted this way is not broadcast to the public BSC mempool in the normal way — it goes to a private relay/validator relationship instead. This means the *submission path* is custom, but the transaction's `to` address and calldata could still, in principle, target PancakeSwap's router directly; private-relay MEV protection and "does it call PancakeSwap's router" are two independent, separable facts. One should not assume a private-relay submission path implies a different destination contract — they are different layers of the stack.
- The fact that GMGN's "BSC anti-sandwich nodes" were bypassed and caused real financial loss confirms this isn't just marketing language — it is a real, operating infrastructure layer (private nodes/relay) distinct from ordinary BSC RPC submission, reinforcing that GMGN's BSC execution pipeline is more than a thin wrapper around a MetaMask-style direct router call for at least some of its users (those using anti-MEV modes).

### Gaps
- Whether "Secure" mode / anti-sandwich-node submission on BSC still ultimately results in a transaction whose `to` field is PancakeSwap's router (just submitted via a private channel) versus a GMGN contract was not determined. No technical deep-dive or post-mortem of the October 2024 MEV incident was found that discloses the exact transaction structure or destination address used.
- No information was found on whether anti-MEV "Reduced"/"Secure" modes are opt-in/off by default for ordinary GMGN BSC trades, or what fraction of GMGN BSC trading volume uses the private-relay path versus a standard public-mempool submission (which would be more likely to be a simple direct router call, if one exists at all).

## Overall assessment for the Guard-contract engineering decision

### Takeaway
**The research could not produce a confirmed on-chain transaction hash proving GMGN's BSC `to` address, so this question is not yet conclusively answered.** The circumstantial evidence (backend-computed calldata, a platform fee layered on top of the DEX fee, multi-source route selection, and a private-relay MEV path) leans toward GMGN controlling more of the transaction pipeline than a bare pass-through to PancakeSwap's public router — which would argue in favor of assuming a GMGN-specific contract may be involved, at least for some trade paths (e.g., anti-MEV-protected trades) — but this is an inference, not a verified fact.

### Cited Findings
(see above two sections for full citations)

### Inferences
- Given the lack of confirmed on-chain evidence, the engineering-safe assumption is to **not** assume GMGN trades are automatically covered by a Guard contract scoped only to PancakeSwap's V2 router address. If the Guard is meant to cover GMGN users specifically, further direct on-chain verification (per the Gaps below) should be treated as a blocking prerequisite, not a nice-to-have.

### Gaps
- The decisive next step — pulling one real GMGN BSC transaction hash and reading its `to` address on BscScan — was not accomplished in this research pass. Recommended concrete ways to get unblocked, none of which were accessible within this research session's tools: (1) have someone execute a small real GMGN BSC trade and share the resulting BscScan link; (2) search GMGN's Telegram/Discord community directly (not accessible here) where this exact question is plausible to have come up before; (3) use a browser automation tool to actually load gmgn.ai's BSC trading UI, open browser dev tools / network tab during a (test or real) trade, and capture the `to` field of the `eth_sendTransaction` request GMGN's frontend asks the wallet (e.g., MetaMask) to sign — this would give a definitive answer without needing a completed on-chain transaction at all, since the destination address is visible in the wallet confirmation prompt before signing.

## Follow-up browser check (same session, after the above subagent report)

Attempted option (3) above directly: navigated to gmgn.ai's BSC trending page and a real BSC
token's trade page (`gmgn.ai/bsc/token/0x4305...97777`). Result: GMGN blocks this entirely
behind a **site account login** - "Please log in before performing any operations" is shown in
place of any wallet-connect or trade UI, before a wallet is ever involved. No wallet-connect
prompt, no quote/route network call, nothing trade-related is reachable pre-login.

This is itself a meaningful data point, not a dead end: Uniswap's and PancakeSwap's own sites
never require a site account to trade - only a connected wallet. GMGN requiring a full account
login before even constructing or quoting a trade is consistent with (though does not 100%
prove) a backend-mediated execution flow, matching the earlier finding that GMGN's API computes
`inputdata`/`value`/`gas_limit` server-side per account. A purely client-side "connect wallet,
call PancakeSwap's router directly" dApp has no architectural reason to require a site login for
that.

Did not create a GMGN account to go further - confirming the exact `to` address this way would
require signing up and connecting a real wallet, which is a materially bigger step than
inspecting a public page and was not taken in this session.
