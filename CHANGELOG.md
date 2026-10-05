# Changelog

## 0.8.0 — 2026-10-05

- Share queued and active metadata lookups by canonical document URL, including equivalent IPFS gateways. A burst of tokens referencing one file now needs one lookup.
- Cache sanitized artwork and social details across reloads (128 records / 128 KiB of JSON maximum on disk; 256 in memory). IPFS documents expire in 24 hours; ordinary URLs in five minutes; incomplete metadata in five seconds.
- Race a second metadata host immediately for visible coins. Existing background lookups can be promoted without restarting. Respect the existing global and host budgets and cancel the losing request.
- Ignore stale metadata responses if a token changes URI while the request is in flight.
- Add contributor/security guidance and GitHub Actions for tests, syntax checks and reproducible builds.

## What changed in 0.7

- Artwork updates start loading immediately when the token store receives them, bypassing the board's 300ms render batch. Visible images start without waiting for an IntersectionObserver callback.
- Incoming new coins that pass the visible column's filters can prefetch before their row mounts. Only two incoming coins may warm at once; hidden tabs, held columns and scrolled-away new-pair lists do not speculate.
- Offscreen images leave four global request slots and two slots per host available for visible rows. Scrolling promotes queued images as they enter the viewport.
- Metadata and price changes reuse the same image node and active download. Saved raster payloads are assigned directly to nodes instead of copied into every rebuilt HTML row.

## What changed in 0.6

- Loaded thumbnails bypass the download queue. Small raster images from the public Pump/Pinata and Dexscreener thumbnail hosts are saved locally across reloads, in a separate bounded cache (240 entries, 8 MiB, 24-hour expiry). Other publishers retain normal browser image loading.
- The visible image budget is now 16 requests, with up to eight on known thumbnail CDNs and four elsewhere. Slow images race an alternate after 250ms. Dexscreener thumbnails request the actual display size instead of fetching 800px pictures for small rows.
- Visible coins have two reserved metadata slots beyond the four background jobs. Metadata also races a second gateway after 250ms, cancels losers, and respects rate limits. One missing file no longer disables an entire gateway for subsequent coins.
- Linked tweets have a blue bird icon; profile links keep the X icon. Tweet previews still open on hover/focus.

Brand-new images still depend on the publisher supplying a working URL. No paid image proxy, service key or backend is required. Local storage failures fall back to the normal loader.

## What changed in 0.5

- Visible image requests are scheduled across all columns, with 12 total requests and at most four per host. A slow source gets an alternate-host race after 500ms; the first successful image wins and cancels the other request.
- Nearby images preload, duplicate requests share work, and successful source choices are cached across reloads. Thumbnail requests use 128px instead of 160px. Missing images request metadata immediately; visible coins get bounded early metadata retries with exponential backoff starting at two seconds.
- Hover or keyboard-focus a token's X icon to preview its linked post, including media. On phones, tap for the preview and use Open on X to navigate. The originating Pulse column holds while the preview is open.
- Up to six opened post frames are retained for fast return visits. Embeds run on X's own origin in a sandbox; no X script runs in Nought's wallet page and no API key is needed.
- Profile and community links get identified cards and an outbound link. They do not identify a specific tweet. Protected, deleted or blocked posts can remain unavailable; the preview offers retry and Open on X.

## Earlier changes in 0.4

- A rebuilt terminal layout: charcoal surfaces, quieter borders, a softer blue accent, clearer type and filled quick-buy controls.
- One Pulse toolbar and one compact header per column. Launchpad selection lives in Sources; sorting and pause remain next to each column's filters.
- Compact token rows keep identity, market cap, volume, transaction flow, risk signals and quick buy together. Display → Extra metrics reveals liquidity, five-minute activity and additional quality indicators.
- The chart and trading panel remain side by side at split-window widths above 760px. Phones retain a scrolling layout and Pulse stage tabs.
- Existing image recovery and zero-house-fee checks remain in place.

## Earlier changes in 0.3

- Redesigned Pulse with larger artwork, clearer token identity, five-minute change and volume, liquidity, and holder badges that wrap instead of disappearing.
- Visible board search, a star on each coin, a saved-coins filter, per-column sorting, and explicit pause/resume controls.
- Three columns remain visible in split windows above 760px; phone tabs show one column at a time.
- Images load near the viewport with at most six requests in flight. Slow sources fail over after four seconds, original URLs are retained, successful sources are reused, and metadata/Dexscreener can supply alternate artwork.
- Failed metadata can recover after a cooldown. Missing artwork keeps initials and can be retried with the image refresh button. A coin with no published image cannot display artwork until its providers supply one.
- Missing five-minute data displays as unknown instead of inheriting a fabricated zero from hourly data.

## Earlier changes in 0.2

- The board starts independently of the SOL price request.
- Pulse polls quickly while visible, slows on other pages, and pauses while hidden.
- Trades page back to the previous history boundary instead of dropping trades beyond the latest 30; catch-up is bounded and its status is shown.
- Metadata requests have per-host limits, shorter timeouts and bounded queues.
- Provider failures use exponential backoff and Retry-After; read requests fail over sooner.
- Stable cards and trade rows retain their DOM nodes. Idle age labels and unchanged board snapshots avoid extra writes.
- Token-history caches are bounded and partial history is identified.
- Browser quota pressure evicts the disposable board before critical data. Armed orders require a persisted claim and a cross-tab lock before trading.
- Fee policy is enforced at transport/quote boundaries, and CSP blocks inline JavaScript.
