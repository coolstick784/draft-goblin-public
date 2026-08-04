# Draft Goblin Publication Audit

Audit date: July 18, 2026

## Decision

**No-go for submission today.** The code and ZIP pass the technical release checks, but Chrome Web Store submission still requires an authentic 1280x800 product screenshot and publisher-controlled account, disclosure, and exact-build live-test actions.

## Technical result

- Full test suite: 699 passed, 0 failed.
- Targeted release-contract suite: 95 passed, 0 failed.
- Extension package: `dist/draft-goblin-0.4.3.zip`
- Package size: 664,602 bytes
- Package entries: 47
- SHA-256: `ABAB5A7E0926ED30D7BA43B1BC211B80043262B1F2FC655B7A1F1964F08FB456`
- Forbidden package files: 0
- Release audit: all checks pass except the deliberately missing authentic `store-assets/screenshot-01.png`.

## Security and privacy findings

- Manifest V3; executable logic is bundled.
- No `cookies`, `tabs`, broad-web, analytics, advertising, or telemetry access.
- No `eval`, `new Function`, remote script imports, inline extension scripts, keys, source maps, or environment files in the package.
- External traffic is HTTPS-only and restricted to supported ESPN, Sleeper, and Yahoo hosts and a path-pinned checksummed public projection feed.
- Draft state, preferences, installation identity, and reports are not sent to the developer.
- Local retention is bounded and now documented.
- The privacy notice now discloses locally processed website content and includes Chrome Web Store Limited Use language.

## Permission review

Every requested permission is exercised by a current feature and documented in the store copy:

- `sidePanel`, `storage`, `alarms`, `offscreen`, `scripting`, and `activeTab`
- Explicit ESPN, Sleeper, Yahoo, and `coolstick784.github.io` hosts

`activeTab` is retained for the user-initiated toolbar/launcher recovery path. It produces no install warning and complements, rather than expands beyond, the already approved supported-host scope.

## Runtime and UX findings

- Chrome confirmed that the installed extension injects the Draft Goblin launcher on the authenticated ESPN draft URL.
- Automated tests cover supported/unsupported draft detection, lifecycle recovery, local 10,000-simulation completion, stale-state protection, bounded storage, responsive layout, and offscreen-worker cleanup.
- Browser security prevented automation from opening or capturing extension-internal pages. No screenshot mockup was substituted because Chrome requires screenshots of the actual user experience.

## Work completed

- Synchronized package identity/version with extension 0.4.3.
- Scoped the test runner to repository tests so ignored worktrees under `dist/` cannot be executed accidentally.
- Added a repeatable extension release audit.
- Rewrote privacy, store-listing, permission, dashboard, and reviewer-test copy.
- Added the release checklist and private-security-reporting route.
- Created and verified the required 440x280 small promotional tile.
- Updated five stale contract assertions to match the current title-evidence, benchmark, and owned-only publishing architecture.
- Rebuilt and byte-verified the versioned ZIP.

## Remaining blockers

See `RELEASE_CHECKLIST.md`. The remaining actions require the publisher's Chrome Web Store account, public privacy-policy hosting, security-reporting configuration, and current ESPN, Sleeper, and Yahoo draft-room smoke tests.
