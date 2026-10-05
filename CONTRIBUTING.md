# Contributing to Nought

Use Node.js 22 or later. The app, build and test suite have no npm dependencies.

```sh
git clone https://github.com/PiccoloNiccolo/nought.git
cd nought
npm start
```

Open `http://127.0.0.1:3300/#/pulse`. Make changes on a branch and run:

```sh
npm test
npm run check
npm run build
```

For the compiled preview, run `npm run preview` and open `http://127.0.0.1:3302/#/pulse`. Rebuild after edits. Browser settings and wallets are scoped to the origin, including the port.

Keep pull requests focused. Explain the observable change and relevant verification. Include a screenshot for interface changes. Performance changes should include reproducible evidence, separating controlled checks from live-provider observations. Preserve existing formatting in touched files.

Do not add platform, referral or builder fees. Preserve transaction validation, missing-data states, provider rate-limit handling and bounded queues. Never include API keys, wallet exports, seed phrases, private logs or browser-storage dumps. Do not use real signing or trades in automated tests.

Public issues are suitable for ordinary bugs and feature requests. Include reproduction steps, browser version and expected behavior. Report credential leaks or wallet vulnerabilities using [SECURITY.md](SECURITY.md).

Contributions are distributed under this project's existing MIT license. Third-party code or assets need compatible permission and attribution.
