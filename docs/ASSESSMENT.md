> Historical assessment of earlier local builds. The current open-source project and setup are in [README](../README.md); current verification is in [QA](QA.md). References below to an unpublished repository describe the assessment date.

# Nought assessment — 4 October 2026

## 0.3 image and interface work

The prior image path rewrote IPFS sources to two gateways, removed failed images permanently, and considered failed metadata fetches already complete. In addition, discovery responses sometimes contain no icon or an image host that refuses external use. The new shared image loader preserves original URLs, tries alternate provider artwork, caps visible image downloads at six, times out stalled sources, retains loaded images during live updates, and permits bounded retries. Missing metadata can now recover. No image can be fabricated for a token whose providers publish no artwork.

Pulse now separates token identity, execution controls, activity, and holder distribution. Risk badges wrap instead of disappearing outside a one-line crop. It adds five-minute volume/change and liquidity, visible board search, in-row watchlist stars, a saved-only filter, per-column sorting, and manual pause/resume. Three columns remain available in a 900px split window, while phone users switch columns with tabs. Unknown five-minute data is displayed as unknown.

The three-stage board and fast access to filtering/quick-buy use the product pattern described in [Axiom's official Pulse documentation](https://docs.axiom.trade/axiom/finding-tokens/pulse) as a reference. Nought retains its own styling and fee policy. No claim of overall superiority or measured speed against Axiom is made; the comparisons here are against Nought's earlier implementation.

See the current browser and automated evidence in [QA](QA.md).

## Earlier assessment

The existing project was already a substantial terminal, rather than a landing-page mockup. The useful next step was to finish its recorded performance/reliability work and make the local build reproducible. This working copy preserves the original Downloads project and is saved in this chat's `outputs/nought/` folder.

## Findings and implemented changes

| Finding | Change | Practical effect |
|---|---|---|
| Board startup waited for SOL pricing | Start pricing and seeding independently | A stalled price endpoint no longer holds back coin discovery |
| Pulse continued its full polling rate on unrelated screens | 4/10-second gems/recent cadence on Pulse; 30/60 seconds elsewhere; hidden-page pause | Fewer background requests competing with quotes and balances |
| A busy coin could have more than 30 trades between polls | Page until overlap, with resumable bounded catch-up and one in-flight poll per mint | Trades within the supported catch-up window are not silently skipped |
| Failed hosts retried at a fixed cadence | Exponential backoff, jitter, both Retry-After formats, 3.5-second first-host GET timeout | Less rate-limit pressure and earlier read failover |
| Metadata could tie up all request slots | 2 requests per host, 4 globally, 2.5-second per-request timeout, bounded queues, hidden-page pause | Unavailable metadata has a smaller effect on discovery |
| Every store event rebuilt all card HTML | Stable card keys and retained DOM nodes | Less repeated HTML work and fewer image/layout interruptions |
| Trade updates replaced the entire table | Reuse unchanged keyed rows and preserve scroll | Less disruption while reading live trades |
| Trade history and trader sets could grow through long sessions | Bound per-history/pending/seen trades and per-token trader samples | Limits memory growth; capped history remains labelled partial |
| Unchanged board snapshots and age labels rewrote storage/DOM | Write only dirty snapshots and changed labels | Less idle main-thread work |
| Quote polling emitted structural alert changes | Separate quote and list events | Unrelated watch/token screens avoid unnecessary redraws |
| Withdrawal fallback bypassed Jupiter's queue | Use the shared holdings adapter with validated account records | Balance requests respect shared priority and failover |
| Portfolio bypassed the Hyperliquid request budget | Use the shared adapter | One budget across all views |
| Storage writes could silently fail | Evict only the disposable board first, report failures, require armed-order claim persistence and Web Locks | An unsaved claim cannot proceed to a trade |
| Zero fees depended only on call-site convention | Reject fee/referral/builder request parameters and nonzero standard-quote platform fees | The zero-house-fee requirement has an executable check |
| Inline startup script prevented a strict script policy | External theme initialization and CSP | Inline scripts and event handlers are blocked |
| No repeatable build or regression suite | Dependency-free build, compression, manifest, syntax check and tests | Reviewable, reproducible local delivery |

## Measured evidence

Controlled browser checks used the same 90-coin fixtures for the original and changed source, a deliberately delayed SOL-price response of 2.2 seconds, fresh profiles, and three runs per version. These are local measurements, not a production speed guarantee.

| Check | Original | Improved |
|---|---:|---:|
| First comparison: median time to first Pulse rows | 3.082 s | 0.978 s |
| Final comparison after feed-event improvement: median | 3.145 s | 0.575 s |
| Idle DOM mutations over 2.1 seconds, final comparison | 182 | 47 |
| Scheduled gems/recent requests per minute away from Pulse | 27 | 3 |
| House/integrator fee | 0% by convention | 0%, with request/quote checks |

The first live cold-browser pass showed rows after 3.669 seconds, with 89 live cards across all three columns. It is not directly comparable to controlled fixture results: external libraries, live network latency, and provider availability vary. The token page loaded chart canvases, real trade rows and a quote. A separate 0.01 SOL to USDC quote returned `platformFee: null`. No swap was submitted.

## Scope and remaining work

This is a stronger local prototype, not a claim of Axiom feature parity or production trading readiness. Perps remain read-only; browser-triggered orders need an open tab. No real signed swap, withdrawal, limit order or copy trade was tested in this session. Provider-side transaction formats and simulation capabilities still need funded-wallet end-to-end acceptance tests before a trading launch.

Public endpoints currently serve discovery, charts and quotes. The original handoff notes mention offered premium API access; no service key was needed for this work and no credentials were embedded or extracted into deliverables. A premium shared-key adapter would need a private server, operational budget, and its own integration checks. Token/account trade subscriptions through PumpPortal are metered, while creation/migration subscriptions are free according to its [data API documentation](https://pumpportal.fun/data-api/bonk-fun-data-api/).

Nought fees are zero. Third-party costs still apply: the existing quote panel separates pool/launchpad, network, priority and optional provider-execution costs. Jupiter's standard swap contract documents its optional platform-fee parameter in the [swap reference](https://developers.jup.ag/docs/api-reference/swap/v1/swap). The product does not send that parameter. Protected execution can charge a provider fee and displays it separately.

The upkeep coin has not been launched or configured. No accounts, public repository, hosting deployment or on-chain action were created. Some image gateways returned 403 during live verification; image fallback/initials remain necessary. Catch-up has a 6,000-trade safety window and surfaces overflow or provider errors instead of claiming an unlimited history.
