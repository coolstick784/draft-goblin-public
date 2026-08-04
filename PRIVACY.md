# Draft Goblin Privacy Notice

Draft Goblin provides read-only fantasy-football draft recommendations beside supported ESPN, Sleeper, and Yahoo draft rooms. This notice applies to the Draft Goblin Chrome extension. It does not describe the repository's separate research server.

## Data the extension handles

- **Website content:** On supported draft pages, Draft Goblin reads the draft URL and identifiers, league and roster settings, draft order, current pick, selected and available players, and visible player projections or ranks. It may temporarily read the signed-in user's visible Sleeper display name only to identify that user's draft slot.
- **Local extension data:** Draft Goblin creates a random local installation identifier and stores preferences, a projection-data cache, recommendation state, and up to ten completed draft reports. The identifier is not an ESPN, Sleeper, or Yahoo account identifier.
- **Authentication data:** The extension does not request Chrome's cookie permission, read passwords, or copy ESPN, Sleeper, or Yahoo credentials. When it requests ESPN's authenticated fantasy endpoint, Chrome sends the existing ESPN session directly to ESPN as it would for the open draft page.

## How data is used and transmitted

Draft state and recommendations are processed inside the browser. Draft Goblin does not transmit draft state, browsing history, the local installation identifier, preferences, or reports to the developer.

The extension makes HTTPS requests only to:

- ESPN, Sleeper, and Yahoo, to retrieve the supported draft data needed for the user-facing recommendations.
- `coolstick784.github.io`, to download a public, checksummed projection-data snapshot. Those requests omit credentials and do not contain draft or user data.

Draft Goblin has no analytics, advertising, or telemetry service. It does not sell user data, use it for personalized advertising, or allow human review of user data. It does not transfer user data except to ESPN, Sleeper, or Yahoo as necessary to provide the draft feature, or if required for security or legal compliance.

## Storage and retention

- Current draft state uses Chrome's session storage and is cleared with the browser session.
- Preferences and the random installation identifier remain in local extension storage until the user clears extension data or uninstalls Draft Goblin.
- Completed draft reports are stored locally; only the ten most recent reports are retained.
- The extension retains at most two downloaded projection snapshots. These contain public football data, not user data.

Users can delete all locally stored Draft Goblin data by removing the extension or clearing its extension data in Chrome.

## Limited Use disclosure

Draft Goblin's use of information received from Google APIs complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. Data access is limited to providing or improving the extension's single, user-facing draft-assistance purpose. Draft Goblin does not use or transfer user data for advertising, creditworthiness, lending, or unrelated purposes.

Privacy questions may be submitted at <https://github.com/coolstick784/draft-goblin/issues>.

Last updated: July 18, 2026.
