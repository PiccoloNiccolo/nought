# Changelog

## 0.8.1 — 2026-10-17

- Holders tab: holders that pump.fun's KOL list or a pump.fun profile names show their picture, name, @handle and a KOL / pump.fun tag, with All / KOLs / pump.fun filters; drag the top edge of the tabs panel to resize it (double-click resets).
- Fees saved vs other terminals: the status bar says "Saved … SOL vs Axiom" with a per-terminal breakdown (Axiom 0.95%, Photon, BullX, GMGN, Trojan, BonkBot 1%), and the PnL card shows the saving vs Axiom.
- Average entry and exit as market caps under the position row and on the PnL card; migration is a blue "M" bubble on the chart.
- PumpSwap direct: migrated pump.fun coins are quoted from their canonical pool (vaults + virtual quote reserves) and traded with buy_exact_quote_in_v2 / sell_v2, wrapping and unwrapping SOL in the same transaction — no Jupiter. Nought wallets allow PumpSwap's program for swaps.
- Coin strip: a Holdings source (wallet icon) shows the coins your trading wallets hold, biggest position first. Balances no longer depend on Jupiter: the trade panel reads SOL from the chain when Jupiter is busy, and the top pill refreshes every 15 s.
- pump.fun direct: coins still on the bonding curve are quoted from the curve itself and traded through pump.fun's own program (buy_exact_quote_in_v3 / sell_v3, src/core/pumpdirect.js) — no Jupiter, no rate limit, no aggregator fee. Nought wallets allow pump.fun's program for swaps in the signing check. Migrated coins still use Jupiter.
- One press trades: a stale quote is refreshed and the trade goes ahead (same minimum and impact cap); only very high-impact trades still ask for a second, deliberate press.
- Ultra trades from Nought wallets sign again: the signing check now accepts SPL Token's unwrapLamports (Ultra unwraps SOL with it) when the SOL goes back to the same wallet.
- Stay unlocked on this device (on by default, a tick box when unlocking): Nought wallets keep their sealed, non-extractable signing keys in this browser, so trades sign without the passphrase after a reload; sending funds out, export and adding wallets still ask for it, and Lock now forgets the kept keys.
- Your own buys and sells show on the chart the moment they land (B/S bubbles), and dashed Avg entry / Avg exit lines mark your average cost and exit like Axiom's.
- Wallet picker like Axiom's: Select all, Select all with balance (SOL for buys, this coin for sells), each wallet's SOL and coin balance, copy address.
- Sells and buys work again while Jupiter's keyless Metis quote is rate limited (it answers 429 to almost every caller): quotes and trades fall back to Jupiter Ultra automatically for a minute (Jupiter's own Ultra fee applies and is shown as Jupiter's; Nought's stays 0%).
- Trade panel: the wallet chip opens a wallet picker (tick the wallets the trade runs on, balances, use max, add or manage wallets); Share PnL in the position row; ⇄ flips Bought / Sold / Holding / PnL between SOL and dollars.
- Pulse: Final stretch opens on market cap, highest first, so the coins closest to graduating sit on top (the column's sort menu still switches it).
- Axiom-style redesign, measured from the live axiom.trade: near-black page (#06070b) with #101114 panels, #526fff accent, Geist type; 64 px top bar with a coin strip (watchlist / recently viewed / trending) and a 35 px status bar (preset, wallet, shortcuts, prices, one connection light); Pulse as one bordered box with 110 px cards, launchpad-tinted picture frames, stat pills and blue quick-buy text; token page with a full-height trade column (stats, mint Buy / pink Sell, amount box with quick amounts, settings line, Bought/Sold/Holding/PnL, presets, Token info tiles), chart on the panel colour with teal/red candles; Portfolio, wallet pop-up, Discover, Watchlist, Trackers, Vision, Landing, Settings and Upkeep restyled to match.
- Unnamed toggle: hides KOL bubbles of wallets no public profile names (the person icons).
- Smaller chart bubbles (20 px), and KOLs split like Axiom: PF (pump.fun's public KOL list, kolscan) and KOL (wallets Jupiter tags as influencers), each with its own toolbar toggle.
- Bubble pictures arrive sooner and stick: each page of trades shows as it lands and its new KOLs' pump.fun names and pictures are looked up straight away (live trades too); answers are remembered for a day, so the next visit shows pictures at once. Separate toolbar toggles for KOL, Tracked, DB/DS, SB/SS and your own B/S.
- Chart bubbles cover a coin's whole history, not just its latest 120 trades: KOL trades and sniper trades are fetched with Jupiter's own feed filters (categories=influencer, tags=sniper), back to launch.
- Sniper and dev bubbles with their own toggles: "SB"/"SS" (amber) for buys and sells by wallets Jupiter's trade feed tags as snipers, "DB"/"DS" for the dev; the chart toolbar has DB/DS and SB/SS buttons next to KOL. Panning no longer flickers: bubble groups are keyed by time (loading older candles keeps them), off-screen ones are hidden instead of rebuilt, and pictures are decoded once.
- One bubble layer on the chart for everyone who trades the coin: KOLs (X picture), tracked wallets (emoji or initials), the dev ("DB"/"DS") and you ("B"/"S", solid). The Trades tab's tracked-wallet text arrows ("Cupsey ↑") no longer repeat them underneath. Bubbles follow the chart every frame while it pans, zooms or rescales (they used to catch up every 0.4 s), and existing bubbles are moved instead of rebuilt, so pictures don't flicker.
- Multi-wallet is easy to find: the wallet menu always has a Multi-wallet box — with no wallets kept in Nought yet it explains that an extension signs for one account at a time and offers Create wallets / Import; with some it lists them to tick plus "+ Add wallets". New wallets: create 1, 2, 3, 5 or 10 at once (Sniper 1, Sniper 2, ...), ticked for multi-wallet trades together with the active one, and every secret key shown once to back up.
- Holders on brand-new coins: Jupiter indexes a coin's holders a few minutes after launch and until then returns an empty list, so the Holders tab said "No holders" on new pairs. Nought now rebuilds the list from the coin's trades (tokens bought minus sold per wallet) until Jupiter catches up, and only reads newer trades on each refresh.
- Sealed keys: an unlocked local wallet's key is now held by the browser's own Ed25519 as a non-extractable key; the decrypted bytes are zeroed the moment it is sealed (checked by signing and verifying a probe). It can sign, but nothing in the page can read it back, so stealing it needs the passphrase and the encrypted copy. Browsers without WebCrypto Ed25519 fall back to the previous in-memory key.
- Program allowlist: before a local wallet signs, every top-level program in the transaction must be on the list for its purpose (swaps: Jupiter's aggregator or JupiterZ; limit orders: Jupiter Trigger; transfers: system and token programs only; plus compute budget, token and associated-token programs). Anything else is refused with the program named. Ultra orders for local wallets ask Jupiter for those two routers only.
- KOL bubbles on the chart, like Axiom: just the trader's X profile picture with a green ring for a buy (under the candle) or red for a sell (over it); traders close together stack into one bubble (+n beyond three), so nothing covers anything at any zoom. Hover a picture for name, @handle, how much they bought or sold and when; click it for the wallet card: SOL balance, total value, PnL and every trade on this coin, top holdings, Solscan, and Track. Names, X accounts and pictures come from kolscan.io's public list (382 wallets in data/kol-wallets.json, refreshed by `node tools/kols.mjs`) and, for other wallets Jupiter labels as influencers, from the pump.fun profile the owner set up (read through the relay's new `/who`, since pump.fun refuses other sites' browsers; automatic pump.fun names are ignored). Wallets with no public profile show a person icon. The same list fills Trackers → Vision. Toggle with KOL in the chart toolbar.
- DEX Screener updates on the chart and the header: a paid profile, CTO, ad or boost appears as a blue marker at the time it was approved, the header shows "DEX paid · 15m ago" (or CTO) linking to the pair, and website and social links added through the DEX profile show next to the coin's own. Toggle with DEX in the chart toolbar.
- X icons are blue and simple: a quill for tweets, a person for accounts.
- Social links (X, website, Telegram) show for far more coins: a coin on screen without any gets its metadata read once (its URI found on-chain if Jupiter has none), and lookups through the relay get the time a fresh IPFS file needs instead of being cancelled at 2.5 s.
- The quote under Buy/Sell is one line (what you get, price impact, Nought's 0% fee); click it for the full breakdown with every fee. Impact and liquidity warnings always show.
- Hide works in the Migrated column. "On migration: Unhide" ignored every hidden coin there, including one hidden while it was already migrated; now it only brings back coins that migrated after you hid them.
- Faster landing for local (imported or created) wallets: a signed trade goes to every RPC and to Jito's block engines at the same moment, without a second preflight (Nought has already simulated it before signing), and is re-sent every 2 s until it lands, fails or expires. The "may have been sent" rule is unchanged: such a trade is confirmed, never retried.
- Import a wallet and Create a wallet are in the Connect menu, and Import wallet is in the wallet menu. Imported keys stay encrypted (AES-256-GCM, PBKDF2 600k) in this browser and sign without an extension pop-up.
- New logo: an upright zero and the NOUGHT wordmark.
- Hide buttons (coin · creator · X account) sit in a stack on the left edge of the picture when you hover a card, instead of a small strip at the bottom right.
- Pulse filters: Fees paid (SOL).
- Coin names can no longer use invisible text-direction characters to look like another coin (a symbol "\u202EROHT" showed as "THOR").
- Pulse cards are bigger by default (Display → Card size → Large: a 72–76 px picture beside the name, stats and risk rows, larger type); Standard keeps the previous size and Compact rows still win.
- X links show what they are: a blue quill for a tweet, a blue person for an X account, two people for an X community (other X links keep the X logo).
- New coins arrive with their picture: a launch's row waits until its picture is loaded, at most 1 second (Display → New coins → With picture; "Instantly" turns the wait off). Up to eight incoming launches load their pictures ahead of their rows.
- Optional metadata relay (`tools/meta-relay.mjs`, Settings → Network → Metadata relay; off by default, no keys). Coins launched with J7Tracker (most launches during testing) keep their metadata on metadata.j7tracker.io, which refuses browsers, so without a server those pictures wait for pump.fun's CDN. The relay reads one metadata document and returns only the picture link, name and social links; it refuses non-https, internal and odd-port addresses. Measured on the same 45 live launches: rows that arrive already showing their picture 26 → 37, median launch → row on screen 0.80 s → 0.49 s.
- Multi-wallet trading works like other terminals: tick local wallets in the wallet menu (Trade with · All · None, with balances) and every buy and sell (Pulse quick buy, hotkeys, token page, instant panel) goes out from all of them at the same moment instead of one after another. Each wallet buys the amount you click (default) or the amount is split (wallet menu). Wallets that hold none of a coin are skipped on sells. Parallel legs allow for each other's price impact within the 25% impact cap.
- New launches show their picture as soon as pump.fun's image CDN has it (1–3.5 s after launch for pump.fun and Bonk coins, whatever host their metadata uses). Each new coin is checked every 150 ms from the moment it reaches the stream; the CDN's placeholder (an opaque redirect) is never displayed, and the real picture's bytes go straight into the image cache. The IPFS picture from metadata still races alongside and wins for coins pinned on pump.fun's gateway (~0.6 s).
- Coins listed without a picture or metadata URI read the URI from the chain: the mint's Token-2022 metadata extension, or the Metaplex account for classic SPL mints. Batched 10 per call through the existing RPC failover, once a minute per coin at most.
- IPFS files that pump.fun's gateway has not pinned are served only by gateway.pinata.cloud, which takes 4–7 seconds. Metadata and image requests to it now get 12 seconds instead of timing out at 2.5/3.5 seconds, and a waiting metadata lookup no longer holds a queue slot from fresh launches.
- Dexscreener thumbnails no longer attempt a cached fetch that the CDN's missing CORS header always rejected; they load once, natively.
- Measured side by side against 0.8.0 (headless Chrome, the same 19 live launches): median time from the stream event to a visible picture fell from 3.0 s to 1.3 s, 90th percentile from 6.0 s to 2.0 s; 17/19 under 2 s (was 6/19).

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
