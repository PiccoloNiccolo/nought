# Nought 0.8 verification — 5 October 2026

60 automated checks pass. New metadata coverage verifies a 20-token burst uses one shared lookup, equivalent IPFS gateway URLs coalesce, visible lookups race their backup immediately, in-flight background lookups promote without restarting, saved metadata resolves without another request after reload, stale URI responses are ignored, and unsafe cached URLs are rejected. The shared queues retain host limits, failure backoff and cancellation.

The 20-to-1 result is a deterministic request-count comparison. It does not establish a 20× reduction in overall image latency or an advantage over another terminal. Source availability and network conditions still matter. Existing signed-transaction limitations below remain unchanged; no wallet or real trade is used by the tests.

The public repository includes application code, build/preview tools, tests, license and documentation. A targeted scan found no embedded provider credentials or private machine paths in the publication files. Browser storage, local logs, chat history and the original local handoff notes are not part of the repository.

---

# Nought 0.7 verification — 5 October 2026

54 checks pass. Added coverage verifies immediate artwork notification ahead of the 300ms board redraw, visible loading before the observer callback, preservation of active and loaded images during metadata changes, incoming-coin prefetch shared with its future row, exclusion of cached raster payloads from generated row markup, reserved visible-image capacity, and scroll promotion of an already queued image.

In the live 900×988 board, the first reload observation at 715ms found 19/24 visible images loaded, including nine marked saved; two coins had no source URL. No browser runtime errors appeared in that check. This is a changing live-board observation, not an isolated cold-cache comparison with 0.6. The structural speed improvement verified by deterministic checks is removal of the up-to-300ms board-render wait, with no higher global network limit. A synthetic 40KB saved image produces a tag under 500 characters instead of embedding that payload in every row render.

The early new-coin path honors launchpad/search/watchlist/column/blacklist filters, column holds, scroll position, document visibility, two-coin capacity and an eight-second expiry. Metadata arrivals update only the image while the board is held. Financial controls and fee rules remain unchanged.

Screenshot: `nought-images-v07.jpg` beside the project.

---

# Nought 0.6 verification — 5 October 2026

## Thumbnail cache and launch metadata

46 automated checks pass; 62 application/tool modules parse. New checks cover saved-image queue bypass, cache restoration and storage failure, payload/type/credential rejection, memory limits and expiry, thumbnail sizing, reserved visible-token metadata capacity, metadata gateway racing, loser cancellation, and avoiding host-wide suppression after one unavailable metadata file.

In a live 1280×720 Pulse reload, the first image observation at 638ms found 13/15 visible images loaded, 11 using locally held raster data, and one without a supplied source URL. A later full reload with explicit cache-origin markers found 11/15 loaded at 810ms, including ten confirmed saved rasters restored before any download for those images; one coin had no source URL. These are two point-in-time observations of a changing live board, not controlled cold-cache benchmarks or a universal subsecond guarantee. A keyboard focus scroll moved the Migrated column to scrollTop 1316.5; all five visible rows had loaded images on the subsequent check. No runtime errors were reported in the test tab.

The browser cache is separate from wallet/settings storage, accepts only bounded raster data, expires after 24 hours, and holds at most 240 entries / 8 MiB. CDN fetches omit credentials; non-CORS publishers use normal image elements. Multiple tabs merge their saved thumbnails. A blocked cache falls back to normal loading. Images and metadata both start an alternate at 250ms; this is the race start, not a completion promise. Metadata reserves two extra jobs for visible tokens beyond four background jobs and caps individual requests at 2.5 seconds. Actual 429s retain a five-second host cooldown. Missing artwork and failed external hosts remain possible.

Implementation references: [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) and [Mozilla image persistence](https://hacks.mozilla.org/2012/02/storing-images-and-files-in-indexeddb/). No service credentials or financial actions were used.

Screenshot: `nought-images-v06.jpg` beside the project.

---

# Nought 0.5 verification — 5 October 2026

## Image scheduling and social previews

37 automated checks pass. New coverage includes ordering visible rows ahead of offscreen work, the twelve-request/four-per-host limits, a second-host race at 500ms without prematurely cancelling the original, duplicate request sharing, cancellation, timeout and cooldown behavior, immediate enrichment of imageless tokens, early metadata recovery, priority promotion ahead of a metadata backlog, X URL normalization and rejection of spoofed/unsafe links, and X embed message parsing. A browser-only callback binding error found during development was corrected and the live loader was rechecked.

Live image observation after the scheduler change: 20 of 23 visible images loaded; two tokens had no supplied source URL at that sample. This is a point-in-time count, not a latency guarantee. Tests prove the 500ms alternate-start policy; they do not claim that every image finishes within 500ms. Metadata retries now start after two seconds and back off. Visibility, origin budgets and four early metadata checks keep recovery bounded.

A linked MetroPad post and a linked Magikarp Strategy post both rendered real X text and media on the live Pulse board. The latter reported 771px of content height through X's embed sizing messages. Closing and reopening it reused the already-ready frame; only one tweet frame existed after switching to a profile card and back. The originating column held while the preview was open. Profile-only links displayed their handle and a clear outbound link, without inventing a post. Close and keyboard focus were exercised. At 390×844, the preview occupied x=10…380 and y=14…834 with no document overflow. This responsive check used keyboard focus, not a physical touch device.

The embed frame is hosted by `platform.twitter.com`, uses `dnt=true` and a no-referrer policy, and is sandboxed. It can run X's own scripts on its own origin; no X script is authorized in the top-level wallet document. Incoming sizing messages require the exact frame Window and platform origin. API keys and wallet access are not needed. Unavailable posts have retry and Open on X controls. The frame URL and message envelope were checked against X's published widgets.js renderer; upstream availability and protocol changes remain external dependencies. See [X's embedding guidance](https://help.x.com/en/using-x/how-to-embed-a-post).

Screenshots: `nought-x-hover-v05.jpg` and `nought-x-hover-v05-mobile.jpg` beside the project. No wallet was connected, no social action was posted, and no trade was signed or submitted.

---

# Nought 0.4 verification — 5 October 2026

## Visual rebuild

Checked the live local build at 1440×900, 900×988 and 390×844. Desktop Pulse uses one toolbar and one header per stage. Standard rows measured about 99px on desktop and 104px in the split window, with larger rows only when extra indicators wrap. At the final desktop observation all three columns contained live data, with no document or column horizontal overflow. The phone showed one selected stage without document overflow.

Verified the Sources disclosure, All/pump.fun selection and restoration, Escape dismissal, search empty states and clearing, column sorting and restoration, explicit pause/resume, and Extra metrics on/off. The phone's Migrated tab selected only that stage; the original New pairs tab was restored. Display preferences used in checks were restored. Token details at 900px kept a 620px chart column beside a 280px trading panel; chart, recent trades and a zero-Nought-fee quote were visible.

All 27 existing automated checks pass, and all 58 JavaScript modules parse. The 0.4.0 build includes compressed static assets and its versioned manifest. The image loader, public data adapters and fee enforcement were retained. This pass changes interface layout and control organization; it does not establish a speed advantage over Axiom. No wallet was connected and no transaction was signed or submitted.

Screenshots beside the project: `nought-pulse-v04-current.jpg`, `nought-pulse-v04-desktop.jpg`, `nought-pulse-v04-mobile.jpg`, and `nought-token-v04.jpg`.

---

# Nought 0.3 verification — 4 October 2026

## Image and Pulse follow-up

27 automated tests pass. The seven new checks cover original IPFS URL retention, alternate-provider ordering and deduplication, unsafe image URL rejection, missing five-minute data, viewport-gated six-request concurrency, timeout/error failover, bounded metadata retries, and metadata recovery without overwriting the existing primary image.

Live browser checks used the running local build at `127.0.0.1:3302`. Pulse was inspected at 1440×900, 900px split-window width, and 390×844. No document overflow was observed; the desktop columns also had no internal horizontal overflow. Search returned the expected empty state, sorting selected liquidity correctly, pause/resume updated the control, starring a coin populated the watchlist strip and saved-only filter, and removing that test star restored the prior state. Mobile column tabs switched correctly. No buy or sell control was activated.

At one desktop sample, 13 of 15 visible thumbnails loaded; the other two had no source URL supplied by the providers. All 13 thumbnails with supplied sources were loaded at that observation. This is a point-in-time live check, not a claim that every upstream image will always be available. Initials remain for missing artwork. Images are requested directly from public hosts; no new image proxy or credential is introduced.

The original source probe found successful public image URLs, missing icons, a blocked hotlink host, gateway rate limits and timeouts. Recovery now retains original sources, tries alternate artwork, reuses successful URLs, retries failed metadata after a cooldown, and gives slow image sources four seconds before falling back. An explicit retry button works on visible missing thumbnails.

## Earlier 0.2 verification

## Automated checks

`npm test`: 20 passing tests. Coverage includes multi-page trade catch-up, resumable provider failures, one in-flight request per coin, leaving a coin during a request, repeated-cursor rejection, correct ordering for equal-time trades, fee parameter/quote rejection, exponential and server-requested retry delays, quota recovery, failed persistence notices, dirty board writes, validated withdrawal account data, visibility/route polling cadence, valid simulated spend bounds, overspend, minimum received amounts, hostile delegate approvals, changed token ownership, incomplete/failed simulations, and refusal to trade with an unsaved armed-order claim.

`npm run check`: all application and tooling JavaScript parses. `npm run build` produces the static `dist/` artifact, SHA-256 manifest, and gzip/Brotli variants. None of these checks connects a wallet or broadcasts a transaction.

## Browser checks

Headless Chrome, desktop 1440 × 900 and mobile 390 × 844. Seventeen routes passed with controlled fixtures and no page errors, console errors, or document-level horizontal overflow. Checked Discover and Surge, Trackers and Vision, Perps, Yield, Portfolio and its Calendar/Perps tabs, Watchlist, Upkeep, Settings and Display/Network/Alerts tabs, token detail, and landing. Pulse was checked separately.

Interactions passed: unchanged cards retain node identity, a comma decimal quick-buy value (`0,5`) produces the displayed `0.5` SOL amount, filters open/dismiss, mobile columns switch, and incremental trade rows retain existing elements and the reader's scroll position.

Performance measurements and assumptions are in [ASSESSMENT.md](ASSESSMENT.md). Raw browser results are saved in `qa-browser-results.json` and `qa-live-results.json`. Browser fixtures are test-only and are not part of the app's live data.

## Live provider check

The board filled all three columns; a live token opened with chart canvases, trade rows and a fee breakdown. A read-only 0.01 SOL to USDC quote succeeded and returned no platform fee. There were no page exceptions and no mobile overflow. Third-party image gateway 403s were observed. The stream initially reconnected, then showed live status during the token/mobile checks.

## Not verified

Real funded-wallet swaps, deposits/withdrawals, limit submission/cancellation, and unattended copy or armed trades. Simulation verdict tests use fixtures; they are not an independent audit or proof of on-chain behavior. API quotas, gateway availability, and live performance remain provider-dependent. The six-thousand-trade catch-up/history bounds are deliberate; a longer outage may require refreshing history.

The original Downloads project is unchanged. No API secrets were found by a targeted source-pattern check; that check does not replace a full secret audit. No transaction was signed or sent, and nothing was publicly deployed.
