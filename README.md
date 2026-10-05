# Nought

An original, open-source Solana memecoin terminal with **0% Nought platform fees**. The dense interface includes Pulse discovery, token charts and trades, watchlists, tracked wallets, portfolio tools, and wallet-signed Jupiter swaps.

## Run locally

Node.js 22 or later. No package installation is required for the app, build, or unit tests.

For a preview that keeps running after its launching terminal or chat session ends:

```sh
npm run build
npm run preview
```

Open http://127.0.0.1:3302/#/pulse. Re-running the command reuses this build if already running. Run it again after restarting your Mac. It does not install a login item or publish the site.

For a foreground development server that stops when its terminal closes:

```sh
npm start
```

Open http://127.0.0.1:3300/#/pulse. Your wallet and saved settings belong to this browser origin. Changing the port opens separate browser storage.

```sh
npm test       # deterministic logic and transaction-validation checks; no real trades
npm run check  # syntax-check every application/tool module
npm run build  # produce dist/ with a manifest and gzip/Brotli assets
node tools/serve.mjs 3300 --dist
```

The `dist/` folder is a static hosting artifact. GitHub hosts the source; a public app deployment is separate. A host can serve the `.br`/`.gz` variants with the appropriate Content-Encoding and Vary headers. Ordinary files work on any static host. The local preview server handles compression and conditional caching itself.

## Fees and credentials

Nought does not add platform, referral or builder fees. Requests attempting to add them are rejected, and standard swaps reject quotes containing a platform fee. Pool/launchpad fees, network costs, priority fees and any selected provider's own execution fee remain separate. Jupiter protected execution can carry Jupiter's fee; the quote panel shows it.

The current build uses public APIs and has no embedded API keys or service credentials. A shared premium key must stay behind a private server if a premium adapter is added later. Do not put it in browser code, browser storage, or this static build. Wallet secret keys are separate from service API credentials.

The intended upkeep model is creator rewards from Nought's own coin. That coin is not launched or configured in this build; the Upkeep page explains the current status.

## Image loading

Visible coins get priority over background lookups. Metadata requests sharing the same document are combined, and successful artwork details and small raster thumbnails are cached locally across reloads. Visible metadata races two available hosts immediately; image downloads race a fallback after 250 ms. Both queues remain bounded and stop unnecessary background work when the tab is hidden.

In a deterministic launch-burst check, 20 coins sharing a document required **one metadata lookup instead of 20**. This measures duplicated work, not end-to-end internet latency. Publisher availability still determines when new artwork can arrive.

See [changes by version](CHANGELOG.md), [contributing](CONTRIBUTING.md), and [security reporting](SECURITY.md).

See [assessment and measured results](docs/ASSESSMENT.md), [QA](docs/QA.md), and [build contract](docs/BUILD.md).

## Limits

Live discovery, charts, and read-only quotes have been checked. No real wallet was connected, no transaction was signed, and no trade was broadcast in this verification. A funded-wallet acceptance test remains necessary before a trading launch. Perps are read-only. Browser-armed orders need an open tab. Public APIs can rate-limit or fail; catch-up cannot guarantee a complete history during an unlimited outage. Token images may be unavailable at their hosts.

## Code layout

`src/core/` contains market data, storage, wallets and trade logic; `src/pages/` contains screens; `src/ui/` contains shared controls. `app.js` boots the app, `index.html` provides the shell, and `css/` contains page styles. Charts and the Solana client load pinned, integrity-checked public library versions. No framework or bundler is required.

For the optional screenshot tool, supply `PLAYWRIGHT` with the import path of an installed Playwright package and `CHROME` with your Chrome executable, then run `node tools/shot.mjs screenshot.png '#/pulse' 8000`. It uses a fresh browser profile with no connected wallet.

MIT licensed. Market data and trading outcomes are not guaranteed.
