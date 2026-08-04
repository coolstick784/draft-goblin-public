# Draft Goblin Chrome Web Store Release Checklist

## Automated release gate

Run:

```powershell
pnpm run audit:extension-release
pnpm test
pnpm run package:extension
```

The release audit verifies Manifest V3 metadata, the reviewed permission and host set, icon dimensions, remote-code restrictions, privacy and permission disclosures, and required store-asset dimensions. The packaging script rebuilds the bundled engine and produces a sorted, deterministic, byte-verified ZIP in `dist/`.

## Completed in the repository

- Manifest V3 service worker and side-panel architecture
- Bundled executable code; remote updates are validated JSON only
- HTTPS-only, host-pinned external requests
- No `cookies`, `tabs`, broad-web, analytics, ads, or telemetry permission
- Local data retention bounds and privacy disclosure
- Store description, permission justifications, privacy-practices answers, and reviewer instructions
- Versioned deterministic packaging
- Required 128 px icon and 440x280 small promotional tile

## Owner actions before submission

These require the publisher's identity, accounts, or live authenticated sessions and cannot be truthfully automated from source code:

- Register or confirm the Chrome Web Store developer account and 2-Step Verification.
- Confirm the publisher name and verify the official website in Search Console if verified-publisher status is desired.
- Enable GitHub private vulnerability reporting or replace the security contact with a monitored private email.
- Host `PRIVACY.md` at a stable public URL and paste that URL into the dashboard.
- Enter the values and disclosures in `STORE_LISTING.md`; verify every dashboard answer matches the submitted build.
- Perform current ESPN, Sleeper, and Yahoo draft-room smoke tests with the exact packaged version.
- Capture at least one full-bleed 1280x800 screenshot of the exact packaged extension in a live supported draft room. Do not substitute a mockup; store screenshots must show the actual user experience.
- Upload `dist/draft-goblin-<version>.zip`, the store assets, and reviewer instructions.
- Use staged publishing for the first release, review all dashboard warnings, then publish after approval.

## Final go/no-go criteria

Do not submit if the automated gate or tests fail, if the projection feeds lack redistribution authorization, if the privacy URL is unavailable, if the live platform smoke tests fail, or if the dashboard disclosures differ from the extension's actual behavior.
