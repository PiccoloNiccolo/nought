# Nought: feature matrix and build plan

Nought is a Solana-only, static, open-source memecoin terminal. It has no backend and charges no fee of its own.

**Legend**
- **YES**: buildable fully client-side on keyless, CORS-open endpoints that passed testing.
- **PARTIAL**: buildable with less scope, a heuristic, or only while a Nought tab is open.
- **NO**: needs a backend or a paid key. Replaced or dropped.
- **VERIFY**: depends on an endpoint nobody has tested yet. Spike it before building (see section 15).

**Zero-fee rule**
- Never set `platformFeeBps` or `feeAccount` on Jupiter. Never set `feeBps` on Trigger. Never set a Hyperliquid builder code.
- Every quote shows "Nought fee: 0" and lists third-party costs separately: LP fee, Jupiter Ultra fee if Ultra is used, priority fee, tip and network fee.

---

## 0. Source aliases (all tested as CORS-open and keyless unless noted)

| Alias | Endpoint |
|---|---|
| JT | `https://lite-api.jup.ag/tokens/v2/` + `recent`, `search?query={mint|symbol|mint,mint}`, `toptrending/{5m|1h|6h|24h}?limit=100`, `toporganicscore/{iv}?limit=100`, `toptraded/{iv}?limit=100` |
| JP | `https://lite-api.jup.ag/price/v3?ids=` (at most 50 ids; any extra are silently dropped) |
| JQ | `https://lite-api.jup.ag/swap/v1/quote` (GET works). `/swap/v1/swap` and `/swap/v1/swap-instructions` are POST and need VERIFY |
| JU | `https://lite-api.jup.ag/ultra/v1/` + `holdings/{w}`, `balances/{w}`, `shield?mints=` (all work). `order` and `execute` need VERIFY |
| JG | `POST https://datapi.jup.ag/v1/pools/gems` with body `{recent:{timeframe:"24h",launchpads:[..]},aboutToGraduate:{..},graduated:{..}}`. Undocumented |
| JX | `https://datapi.jup.ag/v1/txs/{mint}?traderAddress=&offset={next}` (30 per page, complete history). Undocumented |
| JH | `https://datapi.jup.ag/v1/holders/{mint}` (top 100 owners, `count`, `holderTags`, `addressInfo.funding*`). Undocumented |
| JC | `https://datapi.jup.ag/v2/charts/{mint}?interval=1_SECOND..1_MONTH&to={ms}&candles<=7000&type=price|mcap&quote=usd|native`. Undocumented |
| JTR1 | `https://api.jup.ag/trigger/v1/*`: keyless, about 0.5 RPS. `lite-api.jup.ag/trigger/v1` is the fallback while it still exists |
| JTR2 | `https://api.jup.ag/trigger/v2/*`: needs a JWT from `auth/challenge` + `auth/verify`. Never use lite-api for v2 (its 401 has no CORS header) |
| DS | `https://api.dexscreener.com/` + `tokens/v1/solana/{<=30 mints}`, `token-pairs/v1/solana/{mint}`, `latest/dex/search?q=`, `latest/dex/pairs/solana/{pair}`, `token-boosts/top/v1`, `token-boosts/latest/v1`, `token-profiles/latest/v1`, `community-takeovers/latest/v1`, `orders/v1/solana/{mint}` |
| PP | `wss://pumpportal.fun/api/data`, one socket only: `subscribeNewToken` and `subscribeMigration`. Token and account trade subscriptions need a key and are not used |
| RL | `https://launch-mint-v1.raydium.io/get/list?sort=new&size=100&mintType=default&includeNsfw=false[&platformId=FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1]` |
| RPC | `https://solana-rpc.publicnode.com` (also `wss://`) is primary. Fallbacks: `https://rpc.solanatracker.io/public` and `https://public.rpc.solanavibestation.com` (both also `wss://`) |
| GT | `https://api.geckoterminal.com/api/v2/networks/solana/...`. Fallback only, never on the critical path: a 429 has no CORS header, so the browser sees a TypeError |
| HL | `POST https://api.hyperliquid.xyz/info` and `/exchange` (`Content-Type: application/json` is required). WebSocket: `wss://api.hyperliquid.xyz/ws` |

---

## 1. Shell, landing and onboarding

- **Top nav [YES]**: the Nought "0" ring logo, then Pulse, Discover, Trackers, Vision, Perps, Portfolio, Yield.
  - Right side: search pill (shows the `/` hint), Deposit, watchlist star, notification bell, wallet pill, settings gear.
  - The wallet pill shows SOL and USDC balances from JU `balances`. Its dropdown has Convert, Withdraw, Manage wallets and "Fees saved".
  - The active link takes the accent color.
- **Sub-bar watchlist ticker [YES]**: a scrolling strip of watchlisted tokens (JP price, JT `priceChange`). It can be hidden.
- **Onboarding [PARTIAL, replaces Axiom signup]**: there are no accounts. A first-run modal offers three choices:
  - Connect a wallet through Wallet Standard (Phantom, Solflare, Backpack).
  - Create a local hot wallet: a keypair generated in the browser, encrypted with AES-GCM using a PBKDF2 passphrase key, stored in IndexedDB. The secret is shown once.
  - Import a base58 secret key or a mnemonic.
  - Email or Google login and a Turnkey embedded wallet: **NO**, they need a backend.
  - Only a local hot wallet allows true one-click trading. An external wallet asks for approval on every trade.
- **Deposit [PARTIAL]**:
  - Shows the address, a QR code from a client-side library, a copy button, and a live balance (JU `balances` polled every 5 s while the modal is open).
  - Buying SOL by card in-app: **NO**, because Coinbase Onramp needs a session token from a server. Show link-out buttons instead.
- **Withdraw [YES / VERIFY]**:
  - SOL uses `SystemProgram.transfer`; SPL tokens use a token transfer.
  - With an external wallet, `signAndSendTransaction` sends it and no RPC is needed.
  - With a local wallet, sending goes through RPC `sendTransaction` (VERIFY).
- **Convert SOL ↔ USDC [YES / VERIFY swap POST]**: JQ quote, then `/swap` (or JU order/execute), with USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- **Multi-chain switcher [NO]**: Solana only. Drop it.

## 2. Pulse

- **Three-column board [YES]**: columns New, Final Stretch and Migrated. Each scrolls on its own, newest first, and keeps about 100 rows.
  - **Base data:** one JG POST every 4 s fills all three columns, 30 pools each. The launchpad filter goes in the body.
  - **Real-time additions:**
    - PP `subscribeNewToken` prepends to New instantly. Events with `pool:"pump"` carry name, symbol and uri. `pool:"bonk"` covers any Raydium LaunchLab launch and has no name or symbol; fill those in from JT/JG later.
    - PP `subscribeMigration` moves a row to Migrated (`pool` is `pump-amm` or `raydium-cpmm`), then rehydrates it from JT `search`.
    - JT `recent` every 5 s catches launchpads that PP does not stream.
  - **Live launchpads:** pump.fun, letsbonk.fun, raydium-launchlab, stonkfun, met-dbc, bags.fun, moonshot, jup-studio, forge. Boop, moonit and heaven only have history. Not available: believe and zora.
  - **Fallback if JG breaks:** JT `recent` for New; GT `dexes/pump-fun/pools` and `dexes/pumpswap/pools?sort=h24_tx_count_desc` for the other two, throttled.
  - **PP metadata:** the PP `uri` (IPFS JSON) gives the icon early. Fetching it is VERIFY because gateway CORS is untested. Otherwise wait for JT/JG.
- **Card metrics [PARTIAL]**:
  - **Base fields from JG `baseAsset` or JT:** icon, symbol and name; short CA with copy; age (from `pool.createdAt` or `firstPool.createdAt`); a launchpad-colored ring and corner badge; holders (`holderCount`); MC (`mcap`); V (`buyVolume + sellVolume`); TX (`numBuys + numSells`) with a green/red split bar; Top10 % (`audit.topHoldersPercentage`); Dev % (`audit.devBalancePercentage`, 0 when absent); dev migrations/creations shown as `audit.devMigrations / audit.devMints`.
  - **Socials:** twitter, website and telegram links, plus a search-on-X link (`https://x.com/search?q={mint}`).
  - **Bonding-curve ring:** use `pool.bondingCurve`. For pump.fun rows that only came from PP, compute `1 − (vTokensInBondingCurve − 279,900,000) / 793,100,000` (VERIFY the constants).
  - **Organic badge:** `organicScore` / `organicScoreLabel`. This is Nought's stand-in for the "Pro traders" count and for "F" (fees paid).
  - **Lazy enrichment for cards on screen** (IntersectionObserver, concurrency 4, cache 30 s):
    - JH gives Snipers % and Insiders %: the sum of `amount` for holders whose `holderTags` include sniper or insider, divided by `circSupply`.
    - JH also gives the KOL count: holders that appear in the bundled `kol-wallets.json`.
    - JH also gives Cluster %: the share held by three or more holders with the same `addressInfo.fundingAddress`. Label it as a bundler proxy.
    - DS `tokens/v1` in batches of 30 gives a Dex Paid proxy (`info` present or `boosts.active`) and missing socials.
    - During the build, log the full set of `holderTags` values seen. Only `insider` and `sniper` are confirmed.
  - **Not available:** pro traders count, global fees paid (F), watchers, pump livestream badge, exact Bundlers %.
- **Per-column filters [YES, applied client-side]**: settings are saved in localStorage, with Reset and Apply buttons.
  - **Supported:**
    - Launchpads (also sent to the JG body), include/exclude keywords, and "CA ends in pump".
    - Min/max ranges: age, Top10 %, dev %, holders, dev migrations, dev mints, liquidity, volume, MC, bonding %, txns, buys, sells, organic score.
    - Social requirements: has X, website or Telegram, or at least one social.
    - Dex Paid, plus Snipers %, Insiders % and KOLs, which apply after enrichment. While one of these is set, rows stay hidden until they are enriched.
  - **Twitter reuse [PARTIAL]:** counts how many tokens in Nought's IndexedDB cache share the same X URL.
  - **Not available:** pro traders, global fees, tweet age.
- **Filter import/export [YES]**: the share string is `base64url(JSON {v:1, columns:{...}})`. You can also download a .json file. Import checks the schema first.
- **Quick Buy [YES; VERIFY the send path]**: each column has its own SOL amount box. The active preset applies. Button sizes: S, L, Mega, Ultra.
  - **MEV off:** JQ quote → `/swap` (`dynamicComputeUnitLimit:true`, priority settings from the preset, no fee params) → sign with a local wallet → RPC `sendTransaction` (VERIFY). With an external wallet, `signAndSendTransaction` instead.
  - **MEV protected:** JU `order?taker=` → sign → JU `execute` (VERIFY).
  - Confirm with RPC `getSignatureStatuses` (VERIFY) or the execute response, then show a toast with the fill.
- **Presets P1, P2, P3 [PARTIAL]**: each preset stores separate buy and sell settings:
  - Slippage, which becomes `slippageBps`.
  - Priority fee, which becomes `prioritizationFeeLamports:{priorityLevelWithMaxLamports:{maxLamports, priorityLevel:"veryHigh"}}`.
  - Jito tip, which becomes `{jitoTipLamports}`.
  - MEV mode: Off (JQ swap) or Protected (JU Ultra). Axiom's "Secure" mode (whitelisted validators): **NO**.
  - Using both a priority fee and a tip means calling `/swap-instructions`, adding a transfer to a Jito tip account, and compiling a v0 transaction with the lookup tables fetched through RPC `getMultipleAccounts` on solanatracker (VERIFY).
- **Display menu [YES]**: settings are saved in localStorage.
  - Options: metric text size, Quick Buy size, grey or colored badges, circle or square images, progress ring, compact or spaced rows, no decimals, show search bar, show hidden tokens, unhide on migrate.
  - "Customize rows" toggles cover only the fields Nought has.
- **Blacklist [YES]**: a master list in IndexedDB covering dev wallet, mint, keyword and X handle/URL.
  - Cards offer one-click "Hide" and "Blacklist dev" on hover.
  - A manage modal lists entries, removes them, and imports or exports the list.
- **Hover tooltips [PARTIAL]**:
  - Image zoom [YES], with reverse-image link-outs to Google Lens (`https://lens.google.com/uploadbyurl?url=`) and Yandex.
  - Tweet preview [VERIFY]: `platform.twitter.com/widgets.js` with `twttr.widgets.createTweet(id, el, {theme:"dark"})`, for `/status/` links only.
  - Chart preview [YES]: JC `1_MINUTE`, 60 candles.
  - Dev funding: JH `addressInfo`, only when the dev is in the top 100.
  - KOL holders [YES]: from JH.
  - Instagram, TikTok and similar previews: **NO**, link-out only.
- **Sound alerts [YES]**: WebAudio, per column, with a volume control. Sound plays only after the first user gesture and only when a new row passes the column's filters.
- **Pump livestream badge [NO]**: the pump.fun API is blocked by CORS.
- **PnL on Pulse [PARTIAL]**: for mints the active wallets hold (JU `holdings`), cost basis comes from JX `?traderAddress=` (cached), with current value from the row.
- **Rapid mode, Nought's version of Katana [YES]**: a toggle in the Pulse header.
  - Hovering a card shows Buy, Sell 25%, Sell 50% and Sell 100% buttons, with no confirmation.
  - B and S hotkeys act on the hovered card.
  - Needs a local hot wallet.
- **Pulse Tracker floating panel [YES]**: a draggable mini feed of one column's filtered rows. Its position is saved.

## 3. Discover

- **Trending table [YES]**: JT `toptrending/{5m|1h|6h|24h}?limit=100`, polled every 10 s.
  - Check that `body.status !== 400`: a bad interval still returns HTTP 200.
  - Filter to `launchpad != null`. An "Include majors" toggle turns this off.
  - **Columns:**
    - Pair info: icon, ticker, name, copy, age, socials.
    - Sparkline: JC `15_MINUTE`, 32 candles, lazy per visible row.
    - MC with % change (`statsX.priceChange`), liquidity, volume, and TXNs as buys/sells.
    - Info pills: top10, dev %, organic score, mint/freeze authority, and Paid (DS batch).
    - Watchlist star and a Buy pill.
  - The timeframe chips are only 5m, 1h, 6h and 24h. The source has no 1m or 30m. Sorting is client-side.
  - Fallback: GT `trending_pools?duration=`, throttled.
- **Organic and Top Traded tabs [YES]**: JT `toporganicscore/{iv}` and `toptraded/{iv}`, with the launchpad filter.
- **DexScreener tab [YES]**:
  - Sources: DS `token-boosts/top/v1`, `token-boosts/latest/v1`, `token-profiles/latest/v1` and `community-takeovers/latest/v1`, filtered to `chainId==="solana"`.
  - Enrich with DS `tokens/v1` in batches of 30.
  - Label it "Boosted = paid promotion".
- **Discover filters [YES, client-side]**: Dex Paid, Top10 range, liquidity, volume, MC, txns, ticker search, launchpad multi-select, minimum organic score.
- **Surge [YES, Nought's own algorithm]**: polls JT `toptrending/5m` and `toporganicscore/5m` every 10 s.
  - A token surges when `vol5m ≥ 3 × (vol1h / 12)`, `numNetBuyers > 0` and `priceChange5m > 5%`. All thresholds can be tuned.
  - Results show in a live list with a "×N" badge, Quick Buy and optional sound.
- **Pump Live tab [NO]**: CORS-blocked.
- **Lighthouse [PARTIAL]**: a sampled market overview.
  - PP session counters: creates per pool (pump, bonk) and migrations (pump-amm, raydium-cpmm), in 5m and 1h buckets counted from page load.
  - JG plus JT sums by launchpad: volume, buys, sells, traders.
  - Label it "sampled / since page open". True market-wide totals: **NO**.
- **Similar tokens and OG mode [PARTIAL]**:
  - JT `search?query={symbol}` and `?query={name}`, deduplicated.
  - OG mode sorts by `firstPool.createdAt` ascending, then by `mcap` descending.
  - Image matching only works when the icon URL is identical. Perceptual image matching: **NO**, because the canvas is tainted.
- **Watchlist [YES]**: mints stored in IndexedDB, shown in the star panel and the ticker strip.
  - JP every 10 s, in chunks of 50.
  - JT `search` with comma-separated mints every 30 s for MC and % change.
  - Quick Buy on each item.

## 4. Search

- **Global search [YES]**: a modal opened with `/` or the top pill, debounced at 200 ms.
  - Main source: JT `search` (Solana-only, up to 20 results).
  - If the query looks like a base58 pubkey of 32–44 characters, also call DS `token-pairs/v1/solana/{mint}` for the pool, dex and socials.
  - Each row: icon, ticker, name, age, MC, 24h volume, liquidity, socials, Quick Buy.
  - Sort by relevance, age, MC or volume.
  - Recent searches: the last 20, in localStorage.
  - A Paste-CA button uses `navigator.clipboard.readText`. Enter opens the token page.

## 5. Token page (`#/token/{mint}`)

- **Header [YES / PARTIAL]**:
  - **From JT `search?query={mint}`, refreshed every 10 s:** icon, ticker and name; copy and share buttons; watchlist star; age; socials; a large MC figure; price, using subscript-zero notation for tiny prices (e.g. `$0.0₅7`); liquidity; supply (`circSupply` / `totalSupply`); holders; launchpad; whether it graduated (`graduatedAt`).
  - **ATH:** the maximum `high` from JC `1_HOUR` candles.
  - **Bonding-curve %:**
    - pump.fun: RPC `getMultipleAccounts` (base64) on the bonding-curve PDA (seeds `["bonding-curve", mint]`, program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`). Read the u64 `realTokenReserves` at byte offset 24. Progress = `1 − real / 793.1M×1e6` (VERIFY the layout).
    - LaunchLab: RL `finishingRate`.
    - Otherwise: JG `bondingCurve`. Last resort: GT `/tokens/{mint}/info` `graduation_percentage`.
  - **Tax:** the Token-2022 `transferFeeConfig` extension, read with RPC `getMultipleAccounts` jsonParsed on the mint (solanatracker).
  - **Global fees paid: NO.**
  - **Alert button:** price alerts (see the Alerts section).
- **Chart [PARTIAL]**:
  - Rendered with `lightweight-charts`, Apache-2.0, loaded from jsdelivr. The TradingView Advanced library is licensed and cannot be loaded from a CDN, so there are no full drawing tools.
  - **Data:** JC with intervals 1s, 15s, 30s, 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d.
    - The first load uses `to=Date.now()` and `candles=1000`.
    - Earlier pages use `to = oldest.time × 1000`, since `to` is in ms and exclusive.
    - The last 2 candles are polled every 3 s.
  - **Toggles:** `type=price|mcap` and `quote=usd|native`.
  - **Markers:**
    - Your own fills: JX `?traderAddress=` for each active wallet.
    - Dev buys and sells (DB/DS): JX `?traderAddress={dev}`.
    - Tracked wallets that have bubbles turned on: at most 10 calls.
    - Migration: a marker at `graduatedAt`, plus a horizontal migration-MC line from a constant.
  - **Limit-order lines:** draggable (`createPriceLine` plus pointer handlers).
  - **Indicators:** SMA, EMA, VWAP and volume, computed client-side. Drawing is limited to horizontal lines.
  - **Fallback:** GT pool OHLCV. Stitch the pump-fun pool and the pumpswap pool, which you find through `tokens/{mint}/pools`. Throttled.
- **Trades tab [YES]**: JX polled every 3 s. Scrolling back uses the `next` cursor and can reach the token's first trade.
  - **Columns:** age, side, MC at the fill (`usdPrice × circSupply`), token amount, SOL/USD (`nativeVolume` / `usdVolume`), the trader with labels, an `isMev` flag, and a Solscan link.
  - **Labels:** `holderTags`, plus dev, you, tracked wallets (with emoji) and KOL.
  - **Filters:** Dev, You, Tracked, a single wallet (`?traderAddress=`), and a minimum size.
  - **Fallback:** GT pool `trades` (last 300 only).
  - **P2 true-live option:** RPC `logsSubscribe` with `mentions:[pool]`, then `getTransaction`.
- **Positions tab [YES]**:
  - The mints come from JU `holdings` across the active wallets.
  - For each mint, fetch JX `?traderAddress=` across all pages, plus Nought's local trade journal.
  - Columns: bought, sold, remaining, average entry, realized PnL, and unrealized PnL (priced with JP).
  - Buttons: Sell 25/50/100% and Share PnL.
- **Orders tab [YES]**:
  - JTR1 `getTriggerOrders?user=&orderStatus=active|history`, queued at 0.5 RPS or slower.
  - JTR2 `orders/history`, when a JWT exists.
  - Locally armed orders (migration, client-side TP/SL), with a "needs open tab" badge.
  - Cancel: JTR1 `cancelOrder` → sign → `execute`.
- **Holders tab [PARTIAL]**: JH, giving the top 100 plus `count`.
  - Each row: % of supply (`amount / circSupply`) with a bar, SOL balance, funded-by (`fundingAddress`, `fundingAmount`, and the age from `fundingBlockTime`), tags, and the labels dev, KOL, tracked and you.
  - The `Pool` tag lets you hide the LP row.
  - Expanding a row fetches JX `?traderAddress=` for average entry, average exit, PnL and hold time.
  - A star adds the wallet to the tracker.
  - Holders beyond the top 100: **NO**.
- **Top Traders tab [PARTIAL]**:
  - Aggregate JX pages client-side by `traderAddress`.
  - If the token has 150 pages or fewer (about 4,500 trades), fetch the whole history at about 3 requests/s and cache it in IndexedDB. Otherwise show "last N trades".
- **Dev Tokens tab [PARTIAL]**:
  - The counts come from `audit.devMints` and `audit.devMigrations`.
  - Listing them: VERIFY whether JT or `datapi.jup.ag/v1/assets/search` accepts a dev pubkey. Otherwise list the dev's tokens that Nought has seen in its local cache (PP `traderPublicKey`, JG `baseAsset.dev`).
- **Trader Scan [YES]**: clicking any wallet opens a drawer.
  - Data: JX `?traderAddress=` for this mint, plus JU `balances`.
  - Shows bought, sold, current holding, realized PnL, first and last trade, and hold time.
  - Classification:
    - Accumulating: net buyer with no sells.
    - Distributing: sold more than 50% of what it bought.
    - Scalping: 3 or more round trips with a median hold under 5 minutes.
  - A Track button adds the wallet to the tracker.
- **Audit grid [PARTIAL]**: a 3×3 grid of tiles with configurable green, amber and red thresholds.
  - **Tiles:** Top10, Dev H., Snipers, Insiders, Clusters/Bundlers (heuristic), LP Locked, Holders, Organic Score (replaces Pro Traders), Dex Paid.
  - **LP Locked** comes from GT pool `locked_liquidity_percentage`, cached for 10 minutes. Show "—" if unavailable.
  - **Dex Paid** comes from DS `orders/v1/solana/{mint}`: true if any order has `status=="approved"`. Cache for 10 minutes and keep calls at or below 1 per second.
  - **Rows below the grid:** mint and freeze authority (`audit.*AuthorityDisabled`), JU `shield` warnings, and CA and DA copy rows with links to Solscan and to X search.
- **Bundle checker [PARTIAL]**: a heuristic, labelled as such.
  - Flag 4 or more buys from different wallets within the same second (JX `timestamp`).
  - Optionally confirm the slot with RPC `getTransaction` for flagged groups only.
  - Add JH clusters that share a funding wallet.
  - "Bundled %" = what the flagged wallets hold now ÷ `circSupply`.
- **Bubble map [PARTIAL, P2]**: a force graph of the JH top 100.
  - Node size is % held. Edges link wallets with the same `fundingAddress`, or a wallet funded by another holder.
  - Transfer-graph edges and Atlas live/rewind modes: **NO**.
- **Stats strip [YES]**: JT stats for 5m, 1h, 6h and 24h, refreshed every 10 s.
  - Shows volume, buys (count and volume), sells, net volume, net buyers and traders, with a ratio bar.
- **Trade panel [YES / PARTIAL]**: Buy/Sell tabs, then Market, Limit and Adv. tabs.
  - Buy chips (editable): 0.01, 0.1, 1, 10. Sell chips (editable): 10, 25, 50, 100%. Sell amounts use JU `balances`.
  - **Wallet selector:** one or more wallets. With several local wallets, the amount is split evenly or randomized by ±x%.
  - **Quote panel:** expected output, `priceImpactPct`, minimum received, the route label, the Ultra fee when Ultra is used, and "Nought fee 0".
  - **Low-liquidity warning:** when liquidity is under $5k or price impact is over 5%.
  - A large "Buy $TICKER" button, then a Bought / Sold / Holding / PnL row.
- **Limit orders [PARTIAL / VERIFY]**: JTR1 `createOrder` → sign → `execute`. Orders are non-custodial PDAs.
  - **Request:** `{inputMint, outputMint, maker, payer, params:{makingAmount, takingAmount, expiredAt?}}`.
  - The target is entered as MC or price and converted to `takingAmount`.
  - **Limits:** at least $5; only buy-below and sell-above.
  - Dragging the chart line cancels the order and creates a new one. Expiry can be chosen.
- **TP/SL [PARTIAL]**:
  - **A (default, non-custodial):** legs are stored in IndexedDB. JP is polled every 2 s, and a local wallet places a market sell when a level is hit. Works only while the tab is open; show a banner and a Notification.
  - **B (opt-in, with a warning):** JTR2 OCO/OTOCO. Flow: `auth/challenge` → `signMessage` → `auth/verify` → `deposit/craft` → `orders/price`. Funds go into a custodial Privy vault, the minimum is $10, and the API is beta.
  - A take-profit alone can use a V1 limit order.
- **Migration orders [PARTIAL]**:
  - Arm a "buy on migration" or "sell X% on migration" in IndexedDB.
  - When a PP `subscribeMigration` event arrives for that mint, fire a swap through a local wallet with the order's own preset. If routing fails, retry the quote with backoff for up to 30 s.
  - The tab must be open. External-wallet mode shows a popup at migration time.
- **Execution gauges [VERIFY]**:
  - Jito tip floor: `GET https://bundles.jito.wtf/api/v1/bundles/tip_floor`.
  - Priority fee: RPC `getRecentPrioritizationFees`.
- **Global fees paid [NO]**: show organic score and organic volume instead.
- **Instant Trade floating panel [YES]**: a draggable panel with:
  - 4 buy-SOL buttons and 4 sell-% buttons, all editable.
  - A preset switch and a wallet selector.
  - Split-supply sell: each selected wallet sells the same % of its own balance.
  - A live position/PnL line and a hotkey toggle.
- **Share PnL card [YES]**: drawn on a 1200×675 canvas, then downloaded as PNG or copied with `ClipboardItem`.
  - Shows token, invested, sold, and PnL in SOL, USD and %.
  - Can merge several wallets, and "Reset on entry" counts only fills after the last time the balance was zero.
  - Custom background from a local file, color pickers, and a "nought · 0% fees" wordmark.
  - Load the icon with `crossOrigin="anonymous"`. If the canvas is tainted, draw the ticker initials instead.
- **Communities/chat [NO]**: needs a backend. Link out to the token's Telegram or X community.

## 6. Trackers

- **Wallet tracker management [YES]**: stored in IndexedDB with no practical limit (10k or more is fine).
  - Each wallet has an emoji, name, address and group, with toggles for alert, sound, chart bubbles and include-in-feed.
  - A search box and a groups sidebar.
  - **Import:** a JSON array `[{address, name, emoji, group}]`, CSV, or newline-separated addresses. **Export** in the same formats.
  - **Per row:** balance from JU `balances` (lazy, 60 s cache) and last active from RPC `getSignaturesForAddress` with limit 1 (lazy).
- **Live trades feed [PARTIAL]**:
  - **Subscriptions:** RPC WebSocket `logsSubscribe {mentions:[wallet]}`, one subscription per in-feed wallet, spread across the publicnode, solanatracker and vibestation sockets, with failover.
  - **On each notification with `err:null`:** call `getTransaction` with `{encoding:"jsonParsed", maxSupportedTransactionVersion:1}`. Solanatracker accepts batches; publicnode takes only one per request.
  - **Decoding:** the token change comes from pre/post token balances where `owner == wallet`. The SOL change comes from pre/post balances at the wallet's index, with the fee added back. Skip transactions that are not swaps.
  - **Enrichment:** JT `search`, batched.
  - **Row:** time, emoji and name, side, token, SOL amount, MC at the fill, launchpad, and Quick Buy to copy the trade.
  - **Filters:** buy/sell, min/max SOL, MC range.
  - **Limits:** subscribe up to 50 wallets live; it is unknown how many subscriptions one socket accepts, so test that. The rest are polled every 60 s with `getSignaturesForAddress` limit 5.
  - These trades also feed chart bubbles and the "tracked dev" badge on Pulse.
- **Monitor / consensus tab [PARTIAL]**: JU `holdings` for each tracked wallet, one wallet every 2 s, cached for 5 minutes.
  - Shows tokens held by 2 or more tracked wallets, with their count and total value.
  - Practical up to about 200 wallets.
- **X/Twitter tracker [NO]**: the X API is paid and not CORS-open. The only X feature is the tweet embed on cards.
- **Truth Social tracker [NO].**
- **Floating windows [YES]**: Wallet feed, Pulse, Discover mini, PnL and Instant Trade.
  - Each is toggled from the status bar and is draggable and resizable.
  - Positions are saved. A red dot means the window is active.
- **Vision [PARTIAL]**:
  - Ships an open, PR-maintained `kol-wallets.json` with address, name, X handle and tags.
  - KOL cards show live recent trades through `logsSubscribe` on the subset in view.
  - A "Discovered" leaderboard comes from Top-Traders aggregation over the current JT trending tokens: realized PnL, win rate across scanned tokens, and volume. It is labelled "computed this session".
  - One-click Track.
  - True historical wallet PnL: **NO**. There is no free wallet-PnL API, and RPC history only goes back about 33 h.
- **Copy trading [PARTIAL, P2, opt-in]**: a per-wallet copy toggle.
  - Uses a fixed SOL amount or a % of the source trade, with a spending cap and a copy-sells option.
  - Needs a local wallet and an open tab. Off by default, with a risk notice.

## 7. Alerts

- **Toasts [YES]**:
  - **Events:** fills, failures, limit or TP/SL triggers, migration snipes, tracker trades.
  - **Advanced toasts:** amount, price, the updated position and PnL, and a Sell quick action.
- **Sounds [YES]**: per feature (Pulse, tracker, fills, alerts) with a master volume.
- **Notification bell [YES]**: a local log in IndexedDB with an unread badge.
- **Desktop notifications [YES]**: the Notification API, opt-in.
- **Price/MC alerts [YES, tab open]**: thresholds are checked on each JP poll.

## 8. Portfolio

- **Spot portfolio [PARTIAL]**: a wallet selector covers one wallet or all of them.
  - **Top block:** total value (JU `holdings` × JP, plus SOL), available SOL, unrealized PnL.
  - **Active positions:** cost basis from JX `?traderAddress=` for each mint.
  - **History:**
    - Uses the zero-balance token accounts in JU `holdings`, which are mints the wallet traded before, plus the local trade journal.
    - JX fetches each mint's trades and gives realized PnL.
  - **Performance:** total and realized PnL, tx count, and buckets >500%, 200–500%, 0–200%, 0 to −50%, and < −50%.
  - **Activity:** merged JX fills showing type, token, amount, MC at the fill, age and a Solscan link.
  - **PnL chart (1d, 7d, 30d, max):** cumulative realized PnL. Unrealized PnL appears only as the latest point.
  - **Gap:** mints whose token accounts were closed and that were never traded through Nought cannot be seen.
- **PnL calendar [YES]**: daily realized PnL in a month grid, shareable as PNG.
- **Live PnL widget [YES]**: floating, measured from a session-start snapshot, in big type. It has a reset button, and colors and background can be customized.
- **PnL modal graph [YES]**: a JC chart with your fill markers and a running PnL line.
- **Perps portfolio [YES, read-only]**: HL `clearinghouseState`, `userFills` and `openOrders` for an EVM address, either connected or pasted. HL `portfolio` is VERIFY.

## 9. Perps

- **Markets and data [YES]**:
  - HL `metaAndAssetCtxs` every 15 s. Filter out entries with `isDelisted`.
  - **Screener columns:** mark price, 24h change (`markPx / prevDayPx − 1`), hourly funding, OI in USD (`openInterest × markPx`), `dayNtlVlm`, max leverage.
  - The WebSocket carries `allMids`, `l2Book`, `trades` and `candle`. Send a ping every 50 s.
  - Chart history from `candleSnapshot`. Funding from `fundingHistory` and `predictedFundings`.
- **Trading [PARTIAL, P2]**: needs an EVM wallet through EIP-1193 (MetaMask, Rabby, or Phantom's EVM account).
  - **Setup:** sign `approveAgent` once (EIP-712). Nought then generates an agent key in the browser, stored encrypted in IndexedDB, which signs `order`, `cancel`, `modify` and `updateLeverage` without popups.
  - **Orders:** a market order is an IOC at mark ± slippage. TP/SL are trigger orders. Leverage goes up to the market's max, cross or isolated.
  - **Libraries:** `@nktkas/hyperliquid` and `viem` from jsdelivr.
  - No builder code, so Nought adds no fee. Show a jurisdiction and terms notice.
- **Deposit/withdraw [PARTIAL]**:
  - **Deposit:** USDC on Arbitrum sent to bridge `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7`, minimum 5 USDC.
  - **Withdraw:** the user-signed `withdraw3` action.
  - SOL into HL USDC in-app: **NO**. Hyperunit lands it as a spot asset, so link out.
- **Prediction markets [NO for now / VERIFY]**: nothing was tested. Spike `gamma-api.polymarket.com` CORS before any read-only view. Trading needs Polygon CLOB auth, so defer it.

## 10. Yield

- **Liquid staking [YES, via swap]**: staking is a Jupiter swap from SOL to an LST (JupSOL, JitoSOL, mSOL and others); unstaking is the swap back.
  - The LST list comes from JT `tag?query=lst` (VERIFY the payload size; `verified` was 5.3 MB).
  - APY: no tested source, so show "—" (VERIFY).
- **Native staking [PARTIAL / VERIFY]**: `StakeProgram` create plus delegate, built client-side.
  - Needs RPC `getLatestBlockhash` and `getVoteAccounts`, then the wallet sends it.
- **Lending [NO for now]**: no lending API was tested. Show link-out cards to Kamino, Jupiter Lend and marginfi. Spike `lite-api.jup.ag/lend/v1/earn/*` later.

## 11. Rewards (replaced)

- **Cashback tiers [NO]** → replaced by **"Fees saved" [YES]**: the sum of trade notional × 1% (Axiom's reference rate, configurable), taken from the local journal and shown in the wallet menu.
- **Referrals, points, quests, leaderboards and competitions [NO]**: there is no fee to share and no backend.

## 12. Settings

- **Multi-wallet manager [PARTIAL / VERIFY send]**:
  - Create, import, rename, archive and export local wallets. Up to 25 can be active for a trade; storage is unlimited.
  - An external wallet can be connected alongside them.
  - Each wallet shows its balance (JU `balances`).
  - SOL can be moved between your own wallets (`SystemProgram.transfer`, then RPC `sendTransaction`, which is VERIFY).
  - Wallets lock automatically after an idle period.
- **Hotkeys [YES]**: bindings can be changed and are saved in localStorage.
  - `/` opens search.
  - With Instant Trade hotkeys on, Space plus a bound key runs a preset buy X or sell Y%.
  - On Pulse: J/K move, H hides, B buys, Enter opens.
- **Themes [YES]**: CSS custom properties, with presets Nought Dark (default), Grey, OLED and Light. Each token can be recolored, and themes can be exported or imported as JSON.
- **Security and data [YES]**:
  - Export keys after re-entering the passphrase and confirming.
  - Wipe local data.
  - **RPC selector:** publicnode, solanatracker, vibestation, or a custom URL (e.g. the user's own Helius key) stored only in this browser. This replaces Axiom's execution-region setting.
  - An optional Jupiter API key slot switches to `api.jup.ag` with `x-api-key`.
  - Chart font size and default amounts.
- **Bottom status bar [PARTIAL]**:
  - Active preset chip, and a wallets chip showing count and SOL.
  - Floating-window toggles.
  - SOL price (JP), with BTC and ETH from HL `allMids` over WebSocket.
  - Priority and tip gauge (VERIFY).
  - Connection dots for the PP, RPC WebSocket and HL WebSocket.
  - RPC selector, theme button, links to GitHub and Docs, and a "0% fees" badge.

## 13. Navigation and pages

These use hash routes so the site works on static hosting.

| Route | Content |
|---|---|
| `#/pulse` | Default page. Three columns. The header has Display, Blacklist, Sound, Hotkeys, Rapid toggle, wallet selector and launchpad chips |
| `#/discover?tab=trending\|surge\|organic\|traded\|dexscreener\|lighthouse&iv=5m\|1h\|6h\|24h` | Discover table and tabs |
| `#/token/{mint}` | Header; chart (about 70%); bottom tabs Trades, Positions, Orders, Holders, Top Traders, Dev Tokens; a right column of about 320 px with the stats strip, trade panel, position row, audit grid, CA/DA rows and similar tokens |
| `#/trackers?tab=wallets\|live\|monitor` | Wallet tracker |
| `#/vision` | KOL and discovered wallets |
| `#/portfolio?tab=spot\|perps\|calendar` | Portfolio |
| `#/perps/{coin}` | Screener sidebar, chart, order book and trades, order form, positions, orders and history |
| `#/yield` | LST swap and lending link-outs |
| `#/settings?tab=wallets\|presets\|display\|hotkeys\|theme\|rpc\|data` | Settings |
| `#/about` | Open source, the zero-fee policy, data sources, risk notice |

- **Modals:** Search, Deposit, Withdraw, Convert, Wallet create/import, Preset editor, Column filters, Display, Blacklist, Filter import/export, Share PnL, Trader Scan drawer.
- **Floating panels:** Instant Trade, Wallet feed, Pulse, Discover mini, PnL.
- **Look:** an original dense dark terminal.
  - Colors: background `#08090B`, panels `#101216`, 1 px borders `#1E2128`, Nought accent ice-cyan `#38D6F5` (not Axiom's violet), buy `#22D39A`, sell `#FF4D6D`, warning `#F5B83D`, text `#C9CBD3`, muted `#767A8A`.
  - Type: Geist plus Geist Mono (Google Fonts) with tabular figures.
  - Values flash green or red when they change.

## 14. Priority order

**P0: core parity. Ship this first.**
1. App shell: nav, status bar, theme tokens, hash router, and a data layer with caching, failover, rate-limit queues and schema guards.
2. Wallets: Wallet Standard connect, plus encrypted local hot wallets (create, import, export).
3. The swap path, after its VERIFY items: JQ quote and swap, JU order and execute, signing, sending and confirming. Presets P1–P3 with slippage and priority settings.
4. Pulse: JG, PP, JT `recent`; base card metrics; per-column filters; Quick Buy; per-column amounts; blacklist (hide token, blacklist dev).
5. Search modal.
6. Token page: header, chart (JC with lightweight-charts, price/MC and USD/SOL toggles), Trades, Holders, Positions, stats strip, Market trade panel, audit grid with JH snipers and insiders, DS Dex Paid, JU shield.
7. Discover Trending, plus the watchlist and its ticker strip.
8. Deposit (address and QR), Convert SOL ↔ USDC, Withdraw.
9. Spot portfolio basics: holdings, value, cost-basis PnL.
10. Toasts and sounds.

**P1**
- Trading and orders: Limit orders (JTR1) and the Orders tab; Instant Trade panel; hotkeys; Rapid mode; multi-wallet split buys and wallet-to-wallet transfers.
- Pulse extras: lazy card enrichment (KOLs, clusters, organic); full Display menu; filter import/export; hover tooltips (zoom, tweet embed, chart preview); PnL on Pulse; Pulse Tracker floating panel.
- Discover extras: Surge, Organic, Top Traded and DexScreener tabs.
- Token page extras: Top Traders, Trader Scan, Dev Tokens counts, similar tokens and OG mode, chart markers and draggable order lines.
- Trackers: wallet tracker with import/export, and the live feed over `logsSubscribe`.
- Floating windows, migration orders, client-side TP/SL, price alerts.
- Portfolio extras: Share PnL card, PnL calendar, live PnL widget, PnL modal graph, Fees saved.
- Themes, plus RPC and API-key settings.

**P2**
- Perps: read-only screener, chart, book and portfolio first, then EVM agent trading and the deposit bridge.
- Trackers and discovery: Vision, Monitor (consensus), combined Pulse and tracker layout, copy trading (opt-in).
- Analytics: bubble map, bundle checker, Lighthouse (sampled), live trades through pool `logsSubscribe`.
- Yield: LST swaps, native staking, lending link-outs.
- Orders: JTR2 OCO/OTOCO (custodial, opt-in).
- Chart: multi-chart layout and drawing plugins.
- Desktop notifications, and Polymarket read-only if its CORS checks out.

**Will not build:**
- Accounts: email or Google signup, Turnkey embedded wallet, card on-ramp inside the app.
- Social trackers: X/Twitter and Truth Social.
- Missing data: Pump Live, global fees paid, pro traders count, communities/chat.
- Rewards: cashback, referrals, points, leaderboards, competitions.
- Platform: multiple chains, execution regions, MEV "Secure" mode.

## 15. Spikes to run before writing trade code (VERIFY list)

1. `POST lite-api.jup.ag/swap/v1/swap` and `/swap-instructions`: CORS preflight and the response.
2. `lite-api.jup.ag/ultra/v1/order` and `/execute`: CORS, landing, and the fee fields in the response.
3. RPC `sendTransaction`, `getLatestBlockhash`, `getSignatureStatuses`, `getRecentPrioritizationFees`, `getVoteAccounts` on publicnode, solanatracker and vibestation.
4. Jito: `bundles.jito.wtf/api/v1/bundles/tip_floor` and the block-engine `/api/v1/transactions` CORS.
5. JTR1 `createOrder` live with a mint over $5, and the V2 `auth/verify` round trip.
6. Pump.fun bonding-curve account layout and progress constants. Compare against JG `bondingCurve`.
7. CORS on the IPFS gateway behind PP `uri`. `platform.twitter.com/widgets.js` embed behavior.
8. JT `search` batch size beyond 2 mints. Whether JG accepts filter fields in its body. Whether any Jupiter endpoint accepts a dev pubkey query.
9. `logsSubscribe` subscription limit per socket for each provider.
10. Size of JT `tag?query=lst`. LST APY and lending APIs. Polymarket `gamma-api` CORS. HL `metaAndAssetCtxs` with `dex`. HL `portfolio`.

## 16. Data-layer rules

- **Jupiter (`lite-api`):**
  - Always read the body's `status` field, since an error can arrive as HTTP 200.
  - `stats5m`, `stats1h`, `usdPrice`, `mcap`, `icon` and `devBalancePercentage` can be missing; default them to 0 or a placeholder.
  - DS sometimes omits `m5` keys; default those to 0 as well.
- **Chunk sizes:** JP 50, DS `tokens/v1` 30. In DS results, group by `baseToken.address` and keep the pair with the most liquidity.
- **Jupiter host failover:** `lite-api.jup.ag`, then `api.jup.ag` (keyless token bucket at 0.5 RPS, reading the `x-ratelimit-*` headers), then the user's own key. `lite-api` is being retired.
- **datapi.jup.ag:** undocumented. Wrap it in an adapter with shape checks so each feature degrades on its own (fallbacks are listed per feature above).
- **GT:**
  - One global serial queue: 1 request per 20 s, cache 60 s or longer.
  - Treat a fetch `TypeError` as a 429 and back off 30–60 s.
  - Never put GT in a P0 critical path.
- **RPC:**
  - Never use `api.mainnet-beta.solana.com`.
  - Always pass `maxSupportedTransactionVersion:1`.
  - Publicnode accepts only one `getTransaction` per batch.
  - Solanatracker answers 429 with `Retry-After: 10`.
  - History retention is about 33 h on publicnode and about 7 h on solanatracker.
- **PP:**
  - One socket with both subscriptions.
  - Messages without a `signature` are control messages.
  - Reconnect with backoff from 1 s up to 30 s.
- **HL:** send `Content-Type: application/json`. All numbers come back as strings.
- **Poll cadence:**

  | Source | Interval |
  |---|---|
  | JG | 4 s |
  | JT `recent` | 5 s |
  | JT trending | 10 s |
  | JX (token page) | 3 s |
  | JC last bars | 3 s |
  | JH | 15 s on the token page, 30 s for lazy cards |
  | JP | 10 s |
  | DS `tokens/v1` | 2 s minimum gap |
  | DS `orders` | 1 per second max, cached 10 min |

- When the tab is hidden, pause polling. Keep running armed orders, tracker sockets and price alerts.
- **Storage:** IndexedDB holds encrypted wallets, the trade journal, tracked wallets, the token cache, the blacklist, armed orders and notifications. localStorage holds settings, filters, display options, hotkeys, theme and recent searches.

## 17. Endpoints that FAILED CORS or are unusable from a browser (avoid)

**CORS-blocked or origin-blocked**
- `frontend-api-v3.pump.fun/*` (`coins/search`, `coins/{mint}`, `coins/latest`, `coins?…`, `trades/all/{mint}`, `candlesticks/{mint}`): 403 "Not allowed by CORS".
- `swap-api.pump.fun/v1|v2/coins/{mint}/trades|candles`: 403 CORS.
- `api.mainnet-beta.solana.com`, `api.mainnet.solana.com`, `explorer-api.mainnet-beta.solana.com`: 403 for any Origin. Its WebSocket never opens. `getTokenLargestAccounts` is disabled on it.
- `io.dexscreener.com/*` (chart bars, trade log), `gmgn.ai/*`, `api-v2.solscan.io/*`: Cloudflare 403 with no CORS header.
- `app.geckoterminal.com/api/p1/*`: 400 with no CORS header.
- `api.axiom.trade/*`: 425 with no CORS header, and needs a session.
- `api2.bags.fm`: "Origin not allowed".
- `api.dexpaprika.com` pool transactions: 403, needs a plan, no CORS header.
- `solana-mainnet.g.alchemy.com/v2/demo`: 429 with no CORS header.
- `lite-api.jup.ag/trigger/v2/*`: its 401 has no CORS header. Use `api.jup.ag`.
- GT 429 responses carry no CORS header (they show up as network errors). `networks/trending_pools` and cross-chain `new_pools` were always 429.

**Need a key, a payment or a paid plan (CORS passes, still unusable)**
- Data APIs: Birdeye (`public-api.birdeye.so/*`), Moralis, Mobula (free plan blocked), Solana Tracker data API (`data.solanatracker.io`), Solscan Pro, `public-api-v2.bags.fm`.
- GeckoTerminal paid routes: token-level `trades` and `ohlcv`, the `second` timeframe, and anything older than 180 days.
- CoinGecko: `api.coingecko.com/api/v3/onchain/*`, and `simple/token_price` with more than one address.
- PumpPortal `subscribeTokenTrade` and `subscribeAccountTrade`.
- RPC: publicnode indexed methods (`getTokenSupply`, `getTokenLargestAccounts`); solanatracker `getProgramAccounts`, `getTokenAccountsByOwner` and `getTokenLargestAccounts`.
- RPC providers: Helius, Ankr, dRPC (free plan), BlockPI, Blockeden, Chainstack, OnFinality (429 at 1 rps).

**Dead or not resolving**
- `advanced-api-v2.pump.fun` (530), `api.moonshot.cc`, `api.boop.fun`, `api.solana.fm` (502), omniatech (521), extrnode, `solana.therpc.io`, getblock, `1rpc.io/sol`, blastapi, grove, tatum, metaplex, lavenderfive, `mainnet.rpc.solana.com`.
- Guessed `dbc-api.meteora.ag` and `dammv2-api.meteora.ag` paths returned 404.

**Use only with heavy throttling**
- `api.geckoterminal.com/*`: about 2–5 calls a minute in practice.
- `api.jup.ag/*` without a key: about 5 requests per window, 0.5 RPS.
- `api.coingecko.com/simple/price`: majors only.
- `api-v3.raydium.io/mint/price`: Raydium pools only.