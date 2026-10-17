# Security

Nought is experimental trading software. Automated tests exercise validation logic with fixtures; they do not establish funded-wallet production readiness. No security audit is claimed.

Do not post wallet secrets, API keys, exploit payloads against real users, or sensitive browser exports in public issues. Use the repository's **Security → Report a vulnerability** option for private reports. If that option is unavailable, open an issue asking for a private reporting channel without disclosing the vulnerability itself.

Reports should identify the affected version or commit, the component, impact, and a minimal reproduction using dummy data. Never include a real seed phrase or private key.

The project uses public data endpoints. Shared premium credentials belong in a private service, never in the static app. Local wallet keys are sensitive even when encrypted; keep backups outside the project and repository.

The latest default branch receives fixes. Older snapshots have no promised maintenance schedule. External APIs and embedded content can change independently of this repository.

## Local (imported or created) wallets

- **At rest:** each secret key is encrypted in this browser's IndexedDB with AES-256-GCM under a key derived from your passphrase (PBKDF2-SHA256, 600,000 iterations). Nothing is sent anywhere.
- **While unlocked:** each key is sealed as a non-extractable Ed25519 key in the browser's own WebCrypto. The decrypted bytes are zeroed at once. The key can sign, but no page code can read it back. The vault locks after 15 idle minutes (configurable) and when the tab closes.
- **Before every signature** (`src/core/txcheck.js`): the transaction is simulated. Nought refuses to sign when:
  - more SOL or any other token would leave the wallet than the user approved;
  - the wallet's authority would be used for approvals, authority changes or closing accounts to someone else;
  - any top-level program is outside the allowlist for the purpose. Swaps may use Jupiter's aggregator or JupiterZ, limit orders Jupiter Trigger, and transfers only the system and token programs.
- **Limits:** these checks stop a bad API answer or a bug from taking more than the user approved. They cannot protect a wallet while malware or a malicious extension controls the browser and the vault is unlocked. Keep only trading funds in a hot wallet.
