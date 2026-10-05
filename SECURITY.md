# Security

Nought is experimental trading software. Automated tests exercise validation logic with fixtures; they do not establish funded-wallet production readiness. No security audit is claimed.

Do not post wallet secrets, API keys, exploit payloads against real users, or sensitive browser exports in public issues. Use the repository's **Security → Report a vulnerability** option for private reports. If that option is unavailable, open an issue asking for a private reporting channel without disclosing the vulnerability itself.

Reports should identify the affected version or commit, the component, impact, and a minimal reproduction using dummy data. Never include a real seed phrase or private key.

The project uses public data endpoints. Shared premium credentials belong in a private service, never in the static app. Local wallet keys are sensitive even when encrypted; keep backups outside the project and repository.

The latest default branch receives fixes. Older snapshots have no promised maintenance schedule. External APIs and embedded content can change independently of this repository.
