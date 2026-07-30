# Security

Report vulnerabilities through a private GitHub security advisory at
<https://github.com/coolstick784/draft-goblin/security/advisories/new>. Before release,
confirm that private vulnerability reporting is enabled and monitored for this
repository.

The extension uses Manifest V3, bundled code only, narrowly scoped host access, no cookie permission, and a fail-closed platform adapter. The service bounds request bodies, rate-limits installations/IPs, hashes passwords with scrypt and unique salts, stores only session-token hashes, expires sessions after 30 days, and uses parameterized SQLite statements.

Before public deployment: serve only over HTTPS, restrict CORS to the published extension origin, keep secrets outside the repository, add email verification or delegated OAuth, back up and encrypt the database, rotate sessions, configure reverse-proxy limits, scan dependencies/runtime images, and add structured monitoring without raw draft payloads.

Remote projection updates are inert JSON data, never executable code. The extension pins downloads to `https://coolstick784.github.io/ffb/projections/`, omits credentials, rejects redirects outside that path, limits payload size, verifies the manifest's byte count and SHA-256 digest before parsing, validates source timestamps and player rows, and retains the last known-good cache on every failure. The checksum detects corruption or mismatched deployment artifacts; it does not protect against an attacker who can replace both the Pages manifest and snapshot, so repository access controls remain part of the trust boundary.

Owned-model prospective ledgers under `data/private/` contain salted player
aliases and exact provider projections solely for private accuracy evaluation.
That directory and its digest anchors are ignored by Git and must not be
committed, uploaded as CI artifacts, or served by the projection feed. Public
freeze receipts and outcome reports contain only hashes, coverage, and
aggregate metrics; recovery verifies the private ledger against its separately
installed SHA-256 anchor before reconstructing a receipt.
