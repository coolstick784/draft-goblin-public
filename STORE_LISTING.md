# Chrome Web Store Listing

## Single purpose

Draft Goblin provides read-only, live fantasy-football decision support beside ESPN, Sleeper, and Yahoo snake drafts.

## Short description

Compare live projections, ranges, roster fit, and next-pick availability beside ESPN, Sleeper, and Yahoo drafts.

## Detailed description

Draft Goblin keeps a live decision board beside supported ESPN, Sleeper, and Yahoo snake drafts. It compares the current site's projections with Draft Goblin's model, explains floor and ceiling, roster fit, and next-pick availability, and runs deeper simulations for the eight leading options.

The extension is read-only: it never submits a pick or changes a league. Recommendations run locally in the browser, completed reports stay in local extension storage, and packaged projection data remains available when the optional public update feed is unreachable.

Supported in this release:

- NFL snake redraft leagues on ESPN, Sleeper, and Yahoo
- Standard, half-PPR, and PPR scoring
- Live available-player board and eight-player decision view
- Local completed-draft reports

Not supported: auction, keeper, dynasty, third-round reversal, or superflex drafts. The extension fails closed when it cannot verify a supported draft.

## Permission explanations

- `sidePanel`: keeps the decision board visible beside the live draft.
- `storage`: saves local preferences, current draft state, projection cache, recommendation evidence, and up to ten completed draft reports.
- `alarms`: checks periodically for a fresh public projection-data snapshot.
- `offscreen`: keeps the local simulation worker alive when the side panel is temporarily hidden.
- `scripting`: starts the bundled ESPN, Sleeper, or Yahoo adapter in a verified supported draft tab and restarts it after an extension reload.
- `activeTab`: provides user-initiated access to the current draft tab when the toolbar action or in-page launcher is used.
- ESPN host access: reads the open ESPN fantasy draft and requests ESPN's authenticated read-only draft data directly from ESPN.
- Sleeper host access: reads the open Sleeper draft and retrieves Sleeper's official read-only draft data.
- Yahoo host access: reads the open Yahoo fantasy draft and Yahoo's official read-only draft-status feed for settings, players, clock, and completed picks.
- `coolstick784.github.io` host access: downloads public, checksummed Draft Goblin projection data. Requests omit credentials and contain no draft or user data.

Draft Goblin contains no remote executable code. Projection updates are validated JSON data, never JavaScript or WebAssembly.

## Privacy-practices answers

- Single purpose: read-only fantasy-football draft decision support.
- Website content: **Yes**, limited to supported ESPN, Sleeper, and Yahoo draft content required for recommendations.
- Web history: **No**. Draft Goblin does not collect or transmit browsing history.
- Authentication information: **No collection**. Existing ESPN authentication is sent only from Chrome directly to ESPN for the supported endpoint.
- Personally identifiable information: **No collection by the developer**. A visible Sleeper display name may be processed transiently in-browser to identify the user's slot.
- User activity / analytics: **No**.
- Data sold or used for advertising: **No**.
- Data transmitted to the developer: **No**.
- Privacy policy URL: `https://github.com/coolstick784/draft-goblin/blob/main/PRIVACY.md`

## Dashboard values

- Category: Sports
- Language: English
- Mature content: No
- Pricing: Free
- Distribution: Public, all supported regions
- Homepage: `https://github.com/coolstick784/draft-goblin`
- Support: `https://github.com/coolstick784/draft-goblin/issues`

## Reviewer test instructions

1. Install the submitted build and pin Draft Goblin.
2. Open a supported Sleeper or Yahoo snake mock draft URL, or an authenticated ESPN snake draft URL.
3. Use the in-page **Open Draft Goblin** launcher or toolbar action.
4. Confirm the side panel connects, displays the live player board, and updates after a pick.
5. Confirm lobby and unsupported-format pages do not activate recommendations.

No Draft Goblin account or test credentials are required. ESPN itself may require the reviewer to use an ESPN account to enter an ESPN mock draft; Sleeper or Yahoo can be used for the primary review path.
