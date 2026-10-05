# Nought project guide

Nought is an original, MIT-licensed Solana terminal with zero Nought platform, referral or builder fees. Its source repository is https://github.com/PiccoloNiccolo/nought. It is independent of Axiom and does not include Axiom source code or branding.

## Working on the project

Use Node.js 22 or later. No package installation is required. Run `npm test`, `npm run check`, and `npm run build` before submitting changes. `npm start` serves source at port 3300; after building, `npm run preview` starts a persistent local preview at port 3302. A static deployment serves `dist/`.

See README.md for setup and feature limits, CONTRIBUTING.md for changes, SECURITY.md for reporting, docs/BUILD.md for architecture, docs/QA.md for verification, and CHANGELOG.md for release history. Older dated QA/assessment sections describe the versions they name.

## Architecture and invariants

- `src/core/` owns providers, market data, storage, wallets and trading. `src/pages/` owns routes; `src/ui/` owns shared controls. The app uses browser ES modules without a framework or bundler.
- Metadata queues share work by document URI. Artwork updates bypass the board render batch. Image and metadata caches are disposable and separate from wallet data.
- Keep the zero-house-fee checks at the request and quote boundaries. Provider, pool and network fees remain distinct and visible.
- Never embed a shared API key in source, the static build or browser settings. Premium shared credentials require a private service.
- Preserve missing-data states, provider backoff, transaction validation, wallet approval and persistence failure handling.
- Do not sign or broadcast trades as part of automated checks. Funded-wallet acceptance tests remain outstanding.
- The upkeep coin is not launched or configured. Perps are read-only; browser-armed orders require the tab to stay open.
