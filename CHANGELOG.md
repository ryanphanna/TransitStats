# Changelog

All notable changes to this project will be documented in this file.

See [CHANGELOG_ARCHIVE.md](CHANGELOG_ARCHIVE.md) for earlier history.

**See also:** [Intelligence notes](docs/INTELLIGENCE.md) · [Transfer Engine notes](docs/TRANSFER_ENGINE.md) · [Network Engine notes](docs/NETWORK_ENGINE.md)

## [Unreleased]

### Changed

- **Rebuilt V4/V5 model artifacts with agency-scoped route and end-stop labels**, so identical route numbers and stop names in different agencies cannot collide during prediction or training.
- **Prediction history is now agency-separated and model use is gated by clean agency history and verified artifact coverage**, so one-off trips in another city cannot contaminate habits, transfers, or machine-learning predictions.
- **Added anonymous GA4 website-usage measurement** for the main app, dashboard, import flow, and marketing pages, so product usage can be understood without sending trip or location data.
- **Login codes are now protected against bot/spam abuse, and fail clearly instead of hanging.** Requesting a text code goes through an invisible bot check before the SMS is sent, so opening sign-up to the public won't risk someone racking up texting costs by spamming fake numbers; if the check or API hangs, the request now fails clearly instead of leaving the button stuck on “Sending…”.
- **TransitStats is now named consistently across the app, legal pages, documentation, and operational tooling.**
- **Added a private travel-corridor map**, connecting verified boarding and exit stops so repeated trips become visibly stronger without changing the dashboard.
- **Removed the stalled Trip Paths beta**, leaving the working personal map as the foundation for future map improvements.
- **The login page map now shows the real shape of the TTC network** (Lines 1, 2, 4, 5) for visitors detected in Toronto, instead of the generic abstract squiggle every other city still gets. Station dots are smaller and filled now, matching the signed-in map's trip dots instead of the old bold hollow-ring look, on both the abstract and real versions.
- **The PRESTO import file picker now matches the app's styling** instead of showing the raw browser file-input control.
- **Phone-only accounts can now link an email in Settings.** Previously a phone account had no email at all, so signing in with an email anywhere (like the new Import page) created a separate, disconnected account with none of your trips. Linking uses the same Firebase provider as email sign-in, so afterward either one reaches the same account.
- **Added a dedicated /import page** for PRESTO pilot accounts: sign in by phone or email (magic link), then upload and import directly — no dashboard detour. Gated the same way as everywhere else (invite-only whitelist, plus the `pilot`/admin check that already gated the Settings import tab).
- **Fixed the "Use email/phone instead" link buttons rendering as solid gray boxes** instead of plain text links, on the login and import pages.
- **Added real Terms of Service and Privacy Policy pages**, linked from the login screen — Terms previously existed only as a repo file with no page to link to, and there was no Privacy page at all.
- **Hid the "Use email instead" login option**, since email-only accounts can't do manual SMS trip logging — it stood next to the phone option looking like an equal alternative when it isn't. It'll come back once there's a dedicated import-signup flow that makes that limitation clear upfront.
- **Settings is now a panel you open from wherever you are, instead of a separate page.** It matches the rest of the app's visual style, opens over the map without losing your place, and organizes sections into sidebar tabs (Account, Map, Profile, Sharing) instead of one long scroll.
- **Settings now shows your plan (Free, Premium, or Admin)** on the Account tab, so it's clear why premium-gated features do or don't work.
- **Settings hides the Map tab until a phone number is linked**, since the primary-agency setting there only affects text-in trip logging.
- **Settings panel polish**: stays a consistent size across tabs instead of resizing per tab, text-link buttons (Reset password, Change, Save, Share) now carry a small arrow so they read clearly as actions, and the Profile URL's Share button lines up with the other action buttons instead of sitting off to the side.
- **Removed the Routes page and its route-completion tracker**, a leftover from an earlier design. The map is the app's main draw, not a separate route-checklist page.
- **Admins can now import PRESTO activity from Settings**, previewing and importing PRESTO Transit Usage Reports without a separate pilot page.
- **Imported PRESTO activity shows on the public map for flagged pilot profiles once its stop is uniquely known**, leaving ambiguous or unresolved locations for later matching instead of guessing.
- **Imported PRESTO activity stays visible while stop matching is deferred**, so an unclear location doesn't block the rest of the import.
- **PRESTO pilot uploads now preview multiple reports and import activity in user-scoped batches.**
- **PRESTO trials can sign in with email only**, so trying the pilot doesn't require a second phone number.
- **PRESTO fare exports can now be previewed in an isolated report**, keeping imported fare transactions separate from canonical trip history until matched.
- **Social preview images now focus on the full-width map**, leaving trip totals and other stats in the post text where they are easier to read.
- **Profile preview image URLs now advance past cached responses**, so repaired previews and corrected dot maps can be fetched by X and other social platforms instead of reusing a failed or stale cached image.
- **The dashboard no longer shows a live-trip indicator**, keeping the map card focused on trip history and totals.
- **The browser admin area has been retired**, leaving operational maintenance in protected backend tools instead of an unfinished UI.
- **Dashboard maps now load saved dots before the full trip history finishes**, making returning visits feel immediate while fresh data loads.
- **Unauthenticated dashboard visits no longer show a fake empty dashboard while redirecting**, keeping sign-in visitors out of the signed-in shell.
- **Dashboards now link to the owner’s public Profile when sharing is enabled**, making the shared map easy to open from the account home.
- **Signed-in dashboards now consistently identify the card as Your TransitStats**, making the account view distinct from a public profile without briefly flickering back to the profile name.
- **Signed-in public profiles now put Share in the top-right account controls**, matching the dashboard’s Profile placement.
- **Admins now automatically get every premium perk over SMS**, including the STATS trend arrows that previously required a premium flag same as ASK did — one shared rule instead of a per-feature check.
- **PRESTO's import preview now separates fares from card funding**, splitting "loaded" into reloadable-balance top-ups and pass purchases instead of one combined total that made it look like a large, nonexistent balance was unaccounted for.
- **PRESTO imports now only store fare payments**, not card loads — nothing reads load rows back out of storage once imported, and the preview already summarizes them from the file before saving.
- **Public profiles are now open to every account, not just one pilot username.** Settings' Sharing tab (identity reservation, the public toggle, share links) now works for any signed-in user, and the public profile page/API/share-image no longer reject everyone but a single hardcoded account.
- **Added a ⚡ browser tab icon**, replacing the generic blank tab across every page.

### Fixed

- **The corridor map no longer zooms twice while loading**, so it settles directly on the busiest corridor area.
- **The corridor heatmap now opens on the area with the most recorded corridor use**, instead of starting at a broad multi-city overview.
- **The corridor heatmap now shows route usage without stop dots**, keeping the map focused on repeated travel patterns.
- **Travel corridor usage is now shown through colour intensity alone**, keeping every line equally readable instead of making busy routes physically thicker.
- **Travel corridors now follow verified transit route geometry instead of drawing straight lines across the map**, and one unavailable agency no longer prevents other corridors from loading.
- **Authentication and profile checks now handle missing Firestore documents correctly**, preventing phone sign-in crashes and false username/phone availability results.
- **Settings no longer crashes for a brand-new account with no agency chosen yet**, a state every new signup starts in.
- **Imported PRESTO activity now actually appears on the signed-in dashboard — map, trip counts, agencies, days ridden, and countries**, not just the public profile — the dashboard was never wired up to read it.
- **GO Transit's tap-in and tap-out are now combined into one trip**, fixing a double-counted trip and a duplicate map dot for every GO ride (GO is the only PRESTO agency that taps twice per trip).
- **Two different riders can no longer collide on the same imported PRESTO record**, which previously could fail one rider's entire import batch if a coincidental match occurred.
- **Dashboard refreshes now show a loading state while a signed-in session is restored**, instead of appearing blank during a slow auth startup.
- **Local and deployed maps no longer request Carto tiles that require an API key**, preventing the map from showing a configuration error.
- **Public profile pages now load their production CSS and JavaScript**, preventing refreshed profiles from appearing as unstyled browser-default HTML.
- **TransitStats now uses the light theme consistently**, so browser or Incognito dark-mode settings cannot unexpectedly restyle the app.
- **Public profile share images now have enough renderer capacity for larger ride histories**, so Twitter and other social sites can load the preview image.
- **Social preview images now resolve the full dot map on a light geographic canvas and cache the result**, so X cards are both readable and fast to load.
- **Social preview maps now ignore malformed coordinates**, keeping one bad stop from collapsing the entire dot map.
- **Social preview images now render real street map tiles behind the ride dots**, replacing the decorative placeholder background that made cards look generic and unrecognizable. Tile fetching is capped at a 2-second budget so a slow map server falls back to the plain background instead of stalling the card.
- **Profile share links now include a site name and fuller description**, and declare the image's type and secure URL so LinkedIn renders the large card instead of falling back to a small one.
- **The signed-in dashboard loads faster.** It was re-reading your entire trip history a second time just to build the agency list, blocking everything else until that finished; agencies are now built from the trip data the map and stats already fetch.

### Security

- **Updated the Functions query-string parser to the patched release**, closing two denial-of-service vulnerabilities in SMS webhook input handling.

## [1.49.4] — 2026-08-26

### Added

- **Admin stop review can search route- and direction-scoped GTFS metadata and add verified canonical stops with the rider’s text as an alias**, reducing guesses for stops missing from the library.

### Changed

- **The retired standalone `/map` page is no longer linked or deployed**, leaving the dashboard as the main personal map and keeping trip-path exploration available separately.
- **Admin now opens on a compact review queue with clearer failure states**, keeping stop-library maintenance secondary and avoiding a blank page when one data source is unavailable.
- **Admin stop linking records canonical stop codes on trips without rewriting rider-entered stop text**, keeping verification separate from raw trip history.
- **Map stop labels are temporarily hidden**, preventing raw or unreliable names from appearing until canonical stop labels are ready.
- **Public profile maps no longer expose raw stop labels**, keeping inconsistent names and stop codes private while preserving the aggregate footprint.
- **Public profiles skip the full stops database when rides already include coordinates and defer optional auth startup**, reducing first-load time on new devices.
- **Map dots keep the same darkness meaning when zooming**, so clusters no longer make cities look busier or quieter just because of screen grouping.

### Fixed

- **Carto map tiles are replaced with keyless OpenStreetMap tiles**, preventing map failures caused by Carto key requirements.
- **Ambiguous SMS boarding stops now offer the existing stop-choice flow**, instead of silently leaving the trip unverified.
- **Mobile dashboard sessions now retry longer through slow Firebase wake-ups**, preventing temporary restore delays from sending a valid user to sign-in.
- **Phone-authenticated dashboard sessions no longer query a client-blocked phone-number collection**, preventing the map and trip history from getting stuck during auth recovery.
- **Public-profile navigation now returns signed-in users to their dashboard**, while signed-out visitors still go to the home/sign-in page.
- **Weekly model retraining now targets the Transit Stats Firestore project explicitly and pins its Firestore client version**, preventing CI credentials or dependency updates from breaking training.
- **Login texts now use Apple’s domain-bound one-time-code format**, making iPhone code AutoFill more reliable.
- **Sign-in now waits for persistent storage before creating a session**, preventing refreshes from appearing to sign users out.
- **Public profile totals now use the same history-trip rules as the signed-in dashboard**, so active or malformed records no longer inflate logged-out ride counts.

## [1.49.3] — 2026-08-24

### Added

- **Settings now shows both custom and emoji profile URLs when available**, so admins can share either public identity.
- **Historical trips with unambiguous stop-library matches are now repairable**, increasing the trustworthy training pool without guessing missing stops.
- **Clicking a map stop now smoothly zooms toward it and highlights the selected pin**, making dense areas easier to explore.

### Changed

- **Logged-in and logged-out maps now open with the same overview and card-aware framing**, so the initial location does not shift between views.
- **Logged-in and logged-out map cards now use the same compact mobile sizing**, so the stats panel does not change shape between views.
- **Signed-in map branding now sits in the same position as logged-out map branding**, keeping the two map views visually consistent.

### Fixed

- **Phone-authenticated dashboard sessions no longer query a client-blocked phone-number collection**, preventing the map and trip history from getting stuck during auth recovery.
- **Public-profile navigation now returns signed-in users to their dashboard**, while signed-out visitors still go to the home/sign-in page.
- **Weekly model retraining now targets the Transit Stats Firestore project explicitly**, preventing CI credentials from resolving the wrong database.
- **Weekly model retraining pins its Firestore client version**, preventing a dependency update from breaking trip export before training starts.
- **Dashboard refreshes now allow more time for auth recovery**, preventing a slow token refresh from sending a still-valid user back to the sign-in screen.
- **Login texts now use Apple’s domain-bound one-time-code format**, making iPhone code AutoFill more reliable.
- **Sign-in now waits for persistent storage before creating a session**, preventing refreshes from appearing to sign users out.
- **Public profile totals now use the same history-trip rules as the signed-in dashboard**, so active or malformed records no longer inflate logged-out ride counts.

## [1.49.2] — 2026-08-22

- **Maps now show nearby stop dots first and fill in the rest progressively**, making large ride histories feel faster without hiding the full footprint.
- **Public profiles now reuse a short-lived local cache**, making repeat visits appear immediately while refreshing their stats in the background.
- **Public profiles now use a light map presentation, stronger stop-dot contrast, and full ride-footprint framing**, making ride coverage easier to see at a glance.
- **Public profile browser tabs now identify the profile owner**, such as “Ryan’s TransitStats.”
- **Ambiguous boarding stops no longer block trip logging**, leaving the stop unverified when the rider does not choose between matches.
- **Punctuation-only stop-name duplicates now resolve to one rider-facing stop**, avoiding unnecessary choices such as “St Clair West Station” versus “St.Clair West Station.”
- **Directional platform names now resolve from the trip direction**, avoiding unnecessary stop-choice prompts for platforms like Northbound Platform.
- **Dashboard activity stats now show the last 7 and 30 days**, making the time windows consistent and unambiguous.
- **Experimental prediction paths now receive the same previous-route, agency, and learned-network context** after stop disambiguation, keeping fallback inference aligned with normal trip starts.
- **Weekly model retraining now stops before deployment when validation accuracy drops materially**, preventing an automatic refresh from silently replacing a stronger model.
- **Firebase compatibility calls now use the modular Auth and Firestore APIs without changing stored data.**
- **Missing stop coordinates can now be backfilled from local GTFS without changing trip history, names, or aliases.**
- **Public profile maps now refit after cached data refreshes**, so repeat visits do not stay centered on an incomplete or stale city footprint.
- **Public profile maps now resolve stops without saved coordinates**, so older trips still appear outside the main city.

## [1.49.1] — 2026-08-15

### Fixed
- **Hidden public-profile error cards no longer appear over valid profile maps.**
- **Public profile cards are shorter on mobile**, keeping more of the map visible while retaining scrolling for the details.
- **Mobile public-profile stats now stay in one horizontal, scrollable row** instead of stacking into two rows.
- **The public-profile logo now renders its lightning icon** instead of showing an empty square.
- **Public profiles now show a neutral loading card instead of a blank screen or placeholder name**, and possessive endings match the display-name colour.
- **Mobile public-profile activity stats now fit in one row** instead of requiring horizontal scrolling.
- **Public-profile calls to action now say “Make your own map”** instead of using a generic “Sign up” label.

## [1.49.0] — 2026-08-15

### Changed
- **Admin now has a protected processing overview** for users, login activity, ride finalization, stop matching, AI queries, and prediction-model usage.
- **Admin navigation now uses the shared shell and keeps Rocket out of the normal menu** while preserving its protected direct route.
- **Prediction grading tests now use the normal V3 path explicitly**, so experimental-model access controls cannot make the end-to-end safety check flaky.
- **Large ride totals now use thousands separators consistently on dashboard and public profiles.**
- **Dashboard and public-profile cards now share one renderer and parity checks, preventing copy and layout drift between surfaces.**
- **Public profile links now show a clear not-found state and use the same title and branding as the signed-in dashboard.**
- **Public profiles now keep the map visible on phones by placing the stats card at the bottom as a scrollable sheet.**
- **Experimental V4/V5 prediction shadowing is now opt-in per user**, keeping candidate model work away from regular users until it is ready.
- **Dashboard maps now show cached stop markers immediately and avoid snapping from a city zoom to the final overview.**
- **Wide map views now show more distinct stop locations instead of collapsing coverage into a few dots.**
- **The dashboard now verifies the Leaflet CDN script before loading it.**
- **Public profile pages now render their returned stats instead of staying on the zero-state screen.**
- **Admin profile links can use a custom username while preserving the emoji URL as an alias.**
- **Share actions now fail quietly when the browser cannot share or copy a link.**
- **Recent activity replaces the vague “Recent movement” dashboard label.**
- **Possessive name endings now use the same emphasis as the display name.**
- **Map zoom controls are stacked vertically for a more familiar layout.**

## [1.48.0] — 2026-08-14

### Changed
- **Promote the redesigned dashboard, map, settings, and sign-in experience from beta to main.**

## [1.47.16] — 2026-08-14

### Added
- **Shared sign-in across TransitStats surfaces** — moving between the regular, beta, and admin sites no longer requires another login.
- **Theme choices and multi-agency route coverage** — choose System, Light, or Dark and see route progress across every agency you have ridden.
- **Phone-first homepage sign-in** — reopen your ridership dashboard with an SMS code instead of remembering an email or password.
- **Animated homepage map** — flowing routes and pulsing stations make the ridership graphic feel alive.
- **Local transit theming** — the homepage quietly adapts its route colours to the visitor’s approximate city when available.
- **Personal trip-paths beta** — see your saved rides over the scheduled route shapes, using Atlas stop coordinates when a trip is missing saved coordinates.
- **Atlas-first stop resolution beta** — compare Atlas matches, Firestore fallbacks, and unresolved trip stops without changing the production map or trip data.
- **Route Tracker now loads agency route inventories** and compares them with saved rides.

### Changed
- **Replaced Firebase compatibility APIs with modular Auth and Firestore calls** without changing stored data.
- **Main, beta, and admin now deploy independently** so each hostname reflects its own branch.
- **Map basemaps are now quieter and label-free** so personal trip data stays the visual focus.
- **Trip-path beta lines now use uniform strokes and route colours** so overlapping routes remain readable.
- **Trip-path beta now clips lines to each verified ride** so the map shows where you rode, not every stop on the route.
- **Map controls and diagnostics now stay above the Leaflet map** so filters and match counts remain visible.
- **Internal tools now have a separate admin surface** so the rider site stays focused on trips and maps.
- **Route Tracker now uses the full dashboard width** instead of being squeezed into the profile column.
- **Route Tracker now shows a compact coverage summary** instead of listing every missing route by default.
- **Route Tracker now has its own Routes page** so the dashboard stays focused while the full network remains easy to explore.
- **Settings now uses the available page width** instead of reserving an empty second column.
- **Dashboard route coverage now includes a visual progress bar** so the compact card shows progress at a glance.
- **Shared navigation now stays visible while scrolling** and redundant Routes-page back navigation is removed.
- **Settings is more compact** with Account and Preferences side by side and tighter profile rows.
- **Routes now opens on the main agency** with a lighter summary instead of an all-agencies selector and nested stat cards.
- **Routes now keeps the main agency detailed and summarizes other agencies compactly** with progress bars instead of a long route wall.
- **Routes now highlights the main agency’s top five routes** while keeping the complete route list collapsed until needed.
- **Routes now hides other-agency coverage until route data is available** so incomplete inventory is not presented as rider-facing information.

### Fixed
- **Deployment verification now checks downloaded pages safely** so successful admin and beta publishes are not reported as failures.
- **Route coverage progress bars now display** on agency pages such as HSR instead of showing only the route count.
- **Map popups now use the resolved stop name** when coordinates identify a stop instead of showing an unknown stop label.
- **Admin navigation now returns to the admin homepage** when the TransitStats logo is clicked.
- **Map filters now sit below the fixed navigation** instead of covering the logo and page links.
- **Route coverage now uses rider-facing language** instead of exposing the internal Atlas source name.
- **Clipboard and settings notices are now visible** with valid success and error colours.
- **Homepage sign-in buttons now keep their bright styling on hover** instead of turning dark.
- **Phone sign-in now loads in production** — hosting deploys preserve the Firebase configuration needed to enable SMS login, including when the phone field is autofilled.
- **Theme bootstrap now ships inside every built page** so saved themes work in production without a flash or missing script.
- **Incomplete trips now stay clearly marked** and map labels no longer show `undefined` when stop data is missing.
- **Public and signed-in maps now share the same visual language** without exposing private trip details.
- **Settings and navigation actions are now clearer** with visible save controls, working emoji selection, consistent branding, and a shared sign-out action.
- **Route Tracker now counts the user’s actual trips** instead of always reporting zero routes ridden.
- **Route Tracker now groups route branches and shuttles under their Atlas base route** so coverage is not undercounted.
- **Display names no longer fall back to email prefixes** such as `rhanna` when no name was chosen.
- **Admin sign-in now stays on the admin hostname** so the separate admin session can complete instead of redirecting back to the rider homepage.
- **The map now ignores malformed trip coordinates** instead of opening at a world-level zoom.
- **The map now renders saved trip points** instead of stopping after Leaflet initializes.
- **Profile map stop matching now prefers Atlas and reports fallback coverage** so missing coordinates are visible instead of silently dropped.
- **Phone sign-in now restores older linked accounts** instead of failing before the dashboard opens.
- **Map pages no longer fail during startup** when the browser loads the shared topology constraint module.
- **Homepage now fills normal laptop windows without clipping content** while keeping the full map and sign-in flow visible on mobile.
- **TTC homepage palette now uses the actual yellow, green, purple, and orange line colours** instead of a misleading red route.

## [1.47.15] — 2026-08-09

### Security
- **Patched six root dependency vulnerabilities** in `undici`, `brace-expansion`, and `nanoid`.

## [1.47.14] — 2026-07-27

### Security
- **Patched high-severity `postcss` path traversal and `brace-expansion` denial-of-service vulnerabilities** in the root dependency tree.

## [1.47.13] — 2026-07-24

### Security
- **Patched a high-severity `fast-xml-parser` vulnerability** (GHSA-8r6m-32jq-jx6q) by overriding and updating its version to the secure `5.10.1` release.

### Changed
- **Upgraded `firebase-admin` to v14.2.0** and **`firebase-functions` to v7.3.0** (integrating Dependabot PRs #162, #163, and #164) and refactored the Functions codebase to use the new v14 modular app and database APIs.
- **Upgraded `setup-python` GitHub Action to v7** (integrating Dependabot PR #161).
- **Expanded stop enrichment** (`functions/lib/atlas-enrich.js`) to support all configured transit agencies (GO, MiWay, YRT, etc.) from Atlas R2 data (shipped for Issue #152).

### Fixed
- **Fixed chronological age-decay leakage** and **stop canonicalization mismatch** in `NetworkEngine` (resolving V6 end-stop replay regressions for Issue #156).

## [1.47.11] — 2026-07-18

### Fixed
- **Patched a high-severity `adm-zip` denial-of-service vulnerability** by forcing the Functions dependency tree to use the first patched release (`0.6.0`).

## [1.47.12] — 2026-07-19

### Fixed
- **Closed a gap in the `profiles` Firestore rule** that let an owner write arbitrary extra fields on profile update (only `isAdmin`/`isPremium` were previously pinned) — updates are now restricted to the known client-writable field set.

## [1.47.10] — 2026-07-15

### Fixed
- **V6 end-stop evaluation now canonicalizes topology stop aliases**: subway station suffixes no longer count as wrong destinations while directional streetcar platforms remain distinct.
- **V6 end-stop evaluation now separates transfer gaps from long gaps**: destination buckets no longer pool short connection trips with unrelated later outings from the same stop.
- **NetworkEngine confidence is now trips-only**: GTFS/topology stop-source metadata no longer makes learned graph edges more trusted than completed-trip observations support.
- **NetworkEngine replay no longer over-filters strong V6 destination buckets**: trips-only reachability can narrow candidates opportunistically without forcing weaker fallback predictions when the learned graph is sparse.

### Added
- **Historical end-stop replay evaluator**: V3/V4/V5/V6 can now be compared across clean trip history instead of only the small production shadow-stat slice.
- **Chronological NetworkEngine replay toggle**: V6 end-stop replay can now measure trips-only learned reachability separately from topology legality.

## [1.47.9] — 2026-07-15

### Fixed
- **510 end-stop menus now respect platform direction at Spadina/Nassau**: Southbound trips from Spadina Station no longer offer the northbound-only Nassau platform just because it shares the same logical intersection.
- **510 Queens Quay platform variants are now direction-specific**: the remaining collapsed side-platform alias no longer lets a trip suggest the physically wrong platform.
- **GTFS/topology legality now vetoes learned NetworkEngine destination suggestions**: observational trip history can narrow predictions, but it no longer outranks physical route/platform constraints.
- **V6 end-stop evaluation now applies topology legality**: the offline destination baseline beats V3 on the scoped TTC SMS slice instead of tying it.

## [1.47.8] — 2026-07-13

## [1.47.7] — 2026-07-12

### Fixed
- **Mitigate remaining polynomial ReDoS in SMS email registration regexes (CodeQL alert #49)** (`functions/lib/handlers-commands.js`): The 1.47.6 fix bounded the repeated `(?:\.[^\s@.]+)` group but left the local-part (`[^\s@]+`) and domain-label (`[^\s@.]+`) quantifiers unbounded — two adjacent unbounded quantifiers over overlapping character classes, still exploitable (e.g. a long run of `!` characters with no `@`). Bounded both to RFC-sane lengths (`{1,64}` local-part per RFC 5321, `{1,63}` per domain label per RFC 1035). Verified: legitimate addresses still match, a 50,000-character adversarial string now resolves in ~11ms instead of hanging.

## [1.47.6] — 2026-07-12

### Fixed
- **Mitigate Polynomial ReDoS in SMS email registration regexes** (`functions/lib/handlers-commands.js`): Replaced unbounded repetition `+` with a bounded repetition `{1,10}` in both the validation regex (`emailRegex`) and matching regex (`embedded`) within `handleRegister`. This eliminates polynomial backtracking complexity while preserving identical matching/extraction parity.

## [1.47.5] — 2026-07-11

### Fixed
- **`functions/`'s `npm test` script never actually excluded `test_integration.js`, only `test_e2e.js`** — another previously-unreachable bug, surfaced now that the `unit` job gets far enough to run functions' tests at all. `test_integration.js` requires a hardcoded local Firebase service account key path (`/Users/ryan/Desktop/Dev/Credentials/...`) and is meant to run only via the separate `test:integration` script, same category as the emulator-only `test:e2e`. Added it to the exclusion glob. Local suite: 237/237 (down from 249, correctly excluding the 12 integration tests).

## [1.47.4] — 2026-07-11

### Fixed
- **`unit` job's real, previously-unreachable bug: root tests ran before `functions/` was installed**: with `npm ci` finally out of the way (1.47.3), CI got far enough to hit an actual test failure for the first time — `tests/gemini.test.js` (root) imports `functions/lib/gemini.js`, which needs `@google/generative-ai`, a `functions/`-only dependency. The `unit` job ran root `npm test` before `cd functions && npm install`, so Node's `require()` had nothing to find walking up from `functions/lib/`. Reordered: `functions/` now installs before either test step runs. Reproduced locally by removing `functions/node_modules` and confirmed the fix restores it.

### Docs
- **Changelog audit**: found and fixed the same duplicate-`###`-header defect (from many work sessions each appending a fresh header instead of merging) in `CHANGELOG.md`'s `[1.46.0]` block and across `CHANGELOG_ARCHIVE.md`. Also fixed two genuine version-numbering bugs in the archive: `[1.4.0]` was used for two different releases six days apart (the March 9 one, same-day successor to `[1.3.1]`, renamed to `[1.3.2]`), and a stray empty `## [1.30.0]` header with no content was removed.

## [1.47.3] — 2026-07-11

### Fixed
- **1.47.2 also failed — root cause was `npm ci`'s strict tree-matching itself, not lockfile staleness**: CI wanted `@emnapi/core`/`@emnapi/runtime` at *both* `1.11.1` and `1.11.2` simultaneously (two nested copies), while every local regeneration attempt (plain reinstall, full clean reinstall, npm cache cleared, npm 10 via `npx` to match CI's pinned version, `--os=linux --cpu=x64` to force cross-platform resolution) only ever produced one. This looks like a genuine Node 22 (CI) vs. local Node version difference in how npm resolves a loose `^1.7.1` range for this package's transitive optional dependency, not reproducible locally at all. Rather than keep chasing exact lockfile parity, switched `.github/workflows/test.yml` from `npm ci` to `npm install` in all three jobs — `npm install` resolves and adapts instead of hard-failing on any tree drift. Less strict reproducibility guarantee, but actually reliable for a single-maintainer project where the lockfile drifting slightly between a Mac and a Linux CI runner isn't a real risk worth this much friction.

## [1.47.2] — 2026-07-11

### Fixed
- **1.47.1's lockfile fix was incomplete — CI still failed the same way**: a plain `npm install` (both root and `functions/`) synced the version field but still left the tree missing `@emnapi/runtime@1.11.2` and other entries, because it only touches packages that changed rather than fully recomputing the tree. Deleted `node_modules` + `package-lock.json` in both directories and reinstalled from scratch; verified `npm ci` now succeeds clean in both, and the full test suite (165 root + 249 functions) still passes.

## [1.47.1] — 2026-07-11

### Fixed
- **CI Test workflow broken on every push since it was added this session**: two separate bugs, found immediately after 1.47.0 pushed and the `Test` workflow failed. (1) `npm ci` failed in both `unit` and `rules` jobs — root and `functions/` `package-lock.json` still had `"version": "1.45.1"` after the 1.47.0 bump; `npm ci` requires the lockfile's own version field to match `package.json` exactly, and separately `@emnapi/runtime` was missing from the lockfile from an earlier unrelated drift. Fixed by running `npm install` in both directories to resync. (2) `rules` and `e2e` jobs failed with `firebase: not found` — `.github/workflows/test.yml` (added this session) never installs `firebase-tools`, which only worked locally because it's installed globally on this machine, not as a project dependency. Added `npm install -g firebase-tools` to both jobs.

## [1.47.0] — 2026-07-11

### Added
- **`NetworkEngine.inferStopSequence(graph, direction)`** (`functions/lib/network.js`): reconstructs a best-guess linear stop order for a route/direction from observed edge durations alone — no GTFS, no topology.json, no Atlas input. Anchors on one of the two stops with the largest observed pairwise duration (very likely the true line endpoints) rather than an arbitrary or most-observed stop; anchoring on a middle stop is ambiguous (two stops equidistant on opposite sides look identical) and silently scrambles the order. Includes transitive (2-hop) edges so sparse graphs still resolve pairs never observed directly. Returns only the stops it can actually place — a stop with no real or transitive path to the anchor is honestly omitted, not guessed. Not yet wired into any prediction/handler path; purely additive, unit-tested (`functions/test_network.js`) against synthetic graphs only.

### Fixed
- **Default Agency Initialization** (`js/profile.js`): Fixed synchronization of `window.currentUserProfile` with `this.data` during cached load, full profile load, profile updates, and identity reservations.
- **Two-Tap Confirmation Button Pattern** (`js/pages/settings.js`, `js/trips/TripFeed.js`, `js/admin.js`): Replaced browser-native `confirm()` calls with a custom two-tap confirmation pattern (3-second timeout and armed state) for the settings sign-out button, trip feed discard button, and admin buttons (linking all trips, deleting a route, and deleting a stop).
- **Stop Disambiguation SKIP Loop** (`functions/lib/handlers-utils.js`): Added `stopInput: parsedStop.stopName || null` to the `confirm_stop` pending state in the active-trip conflict path to resolve a potential skip loop.
- **Agency Disambiguation SKIP Loop** (`functions/lib/dispatcher.js`): Changed `agencyExplicit: false` to `agencyExplicit: true` when agency selection is skipped, preventing redundant disambiguation prompts.
- **Firestore Query Sorting Error** (`functions/lib/handlers-trip.js`): Replaced the Firestore query that filtered on inequality `endStopName != null` while ordering by `endTime` desc (which threw a runtime error without a composite index) with an in-memory filter and slice on the top 100 most recent trips, keeping the top 25 completed trips.
- **GCF Database Writes** (`functions/lib/finalization.js`): Modified prediction stats grading `es` function to be async, awaiting the database writes, and awaited all calls concurrently with `Promise.all` to ensure database writes complete before the Cloud Function exits.
- **Background finalization silently failed for every trip since 2026-05-26 — no prediction grading, journey linking, or finalized marker for over a month** (`functions/index.js`): the `onTripFinalized` trigger passed the raw Firestore `after.data()` into `runPostEndFinalization` without the document's own ID (`.data()` never includes it). Every downstream `tripData.id` read came back `undefined` — `predictionStats` writes threw and were silently caught, and the closing `backgroundFinalizedAt` update threw on an empty document path, so trips always looked unprocessed. Fixed by merging `{ id: event.params.tripId, ...after }`, matching the pattern `triggerManualFinalization` already used correctly. Introduced in 29ff83f. Backfilled grading/journey-linking for all 131 trips ended since, oldest to newest. Closes #153.
- **Same 29ff83f refactor also dropped `agency`/`route` fields and V3's own end-stop grading from `predictionStats`** (`functions/lib/finalization.js`): `gradeAllPredictions` writes stopped including `agency` (breaking `--agency=` filtering in `audit-prediction-shadow.js` for all new data, not just the backlog) and endstop writes never carried `route`. Separately, nothing graded V3's own end-stop guess (`activeTrip.endStopPrediction`) even though V3 is the live production predictor — old pre-refactor code did this, the extraction to `finalization.js` silently dropped the call. Also found while fixing this: the `habit-endstop` grading call passed `habitPrediction` directly into the shared `es()` helper, which reads `pred.stop` — but `habitPrediction.stop` is the *starting* stop the habit matched on, not the predicted end stop (`habitPrediction.endStop`), so habit-endstop accuracy was comparing the wrong field entirely. All three fixed; backfilled data patched/corrected for the 131-trip backlog (32 new V3-endstop rows written, 144 rows patched with `route`, no bad `habit-endstop` rows existed in this window to correct).
- **Public Profiles exposed full trip documents, not just the aggregate stats shown on the page** (`firestore.rules`, `functions/lib/public-profile.js`, `functions/index.js`, `js/public.js`): the `trips` Firestore rule granted read access to the *entire* document once `isPublic` was true — Firestore rules can't restrict individual fields, so anyone inspecting network traffic on a public profile page could read `userId`, route, stop names, and exact timestamps for every public trip, not just the trip/hour totals and heatmap the UI renders. Trips are no longer publicly readable at all; a new `publicProfile` Cloud Function reads them with the Admin SDK and returns only aggregate/anonymized fields (totals + untyped lat/lng points). `js/public.js` now calls that endpoint instead of querying Firestore directly.
- **Root `firebase-admin` had drifted to v14 while `functions/` stayed on v13, breaking every script in `Tools/`** (`package.json`, `package-lock.json`): v14 removed the root-level `admin.credential.cert`/`admin.firestore()` namespace that all 19 `Tools/*.js` scripts are written against (`Cannot read properties of undefined (reading 'cert')`, then `admin.firestore is not a function`). Pinned back to `^13.10.0` to match `functions/package.json` rather than migrating 19 scripts to the v14 modular API.
- **`admin.firestore.FieldValue`/`.Timestamp` (the namespaced static access) silently fail inside the Firestore Functions emulator** — found while getting `functions/test_e2e.js` running for the first time (see Test infra below): grading and finalization threw `Cannot read properties of undefined (reading 'increment'/'serverTimestamp')` under `firebase emulators:exec`, even though the exact same calls work fine in production. Replaced with the modular `require('firebase-admin/firestore')` import everywhere across `functions/` — the officially recommended pattern, and forward-compatible with any future v14 upgrade. Centralized the import once in `functions/lib/db/core.js` (re-exported via `db/index.js`) instead of repeating it per file. **That first pass missed 4 files** — `functions/lib/db/trips.js` (`createTrip`/`getActiveTrip`/`setPendingState`, used on every trip start), `functions/lib/db/rate-limit.js` (idempotency, dedup, and the unknown-number throttle), `functions/lib/db/stops.js`, and `functions/lib/db/conversations.js` — found and fixed while auditing the onboarding flow below, since `rate-limit.js` sits directly on that path.
- **`functions/lib/public-profile.js` reimplemented profile-fetch logic instead of reusing it**: derived its own `admin.firestore()` instance rather than the shared singleton in `functions/lib/db`, and re-queried the `profiles` collection inline instead of calling `getUserProfile()`. Now imports `db`/`getUserProfile` from `./db`.
- **`functions/lib/finalization.js`'s route-normalize logic was a duplicated inline closure**: `gradeAllPredictions` had a local `normalize(r, agency)` closure duplicating (not delegating to) `ml_utils.js`'s `normalizeRouteForMl`. Confirmed the two aren't interchangeable — `normalizeRouteForMl`'s TTC-collapse only fires when the trip's agency matches the user's configured PRIMARY agency, but grading needs unconditional TTC-collapse since it always compares within one trip's own agency — so merging them would have silently changed grading for non-TTC-primary users. Extracted the closure verbatim into a named, exported `normalizeRouteForGrading()` in `utils.js` instead: same behavior, one canonical location. Also dropped two dead imports (`normalizeRoute`, `isStopMatched`) that were never called in this file.
- **`functions/lib/atlas-enrich.js` path correction (self-correcting an earlier entry in this same file)** — the previous entry here changed the fetch path to `stops-meta/{slug}.json`, trusting Atlas issue #161's body text over Atlas's actual shipped code. Checked directly in the Atlas repo: #161 was already implemented and committed (`0276e20`, "Closes #161") — the pipeline (`process-gtfs.ts`, `refresh.ts`) and the frontend's own `getAgencyArtifactUrls()` both use `atlas/{slug}-stops-meta.json`, the original path. Reverted back to match. The file wasn't live on R2 yet only because that commit hadn't been pushed/run against production R2 — now run manually for TTC (see Atlas's own changelog).
- **Onboarding flow (Transit-Stats#154) — audited first-text-to-first-trip and fixed 5 real bugs:**
  - **Verification-code TTL mismatch**: the SMS told new users "reply within 20 minutes" and the pending state matched, but `storeVerificationCode()` (`functions/lib/db/users.js`) hardcoded the actual Firestore doc's expiry to 15 minutes with no way to override it — a code entered between minute 15 and 20 was told "No pending registration," contradicting what the user was just sent. `storeVerificationCode` now takes a `ttlMs` param; the REGISTER call site passes 20 minutes to match.
  - **Backwards argument order in the first post-verification instruction**: `"Text \"[stop] [route]\" to log trips"` told a brand-new user the opposite order from what the parser actually requires and from what HELP itself documents (`ROUTE STOP DIRECTION`). Fixed to `"[route] [stop]"`.
  - **"REGISTER foo@bar.com" retry loop**: while `awaiting_email` is pending, any reply — including a literal retry of the exact instruction the user was just given — was passed whole into the email regex, so `"REGISTER foo@bar.com"` failed the same "Invalid email format" check forever. `handlePendingState` (`functions/lib/dispatcher.js`) now lets a `REGISTER `-prefixed reply (and HELP/STATUS/etc., matching every other pending state) fall through to its normal handler instead of being swallowed here; `handleRegister` also now extracts an embedded email from natural replies like `"it's foo@bar.com"` instead of requiring an exact-string match.
  - **Regressed URLs**: CHANGELOG v1.45.0 recorded that the unknown-number welcome text included `transitstats.fyi`; it no longer did (both the SMS and MMS first-contact variants), and the "Invite-only" rejection never had one at all. Both now point new users to transitstats.fyi.
  - Confirmed but **not** changed: an unregistered user who doesn't finish REGISTER within the pending-state window goes fully silent for up to an hour (the unknown-number auto-reply is capped at once/hour, by design, to prevent this endpoint being used as an SMS relay/spam vector). Flagged in the issue for a product decision rather than silently loosening the anti-abuse limit.

### Test infra
- **`test:rules` was excluded from its own vitest config** (`vite.config.js`, `vitest.rules.config.js` new, `package.json`): `tests/firestore.rules.test.js` was listed in `vite.config.js`'s test exclude list, so `npm run test:rules` always reported "No test files found" — it has likely never actually run. Gave it a dedicated vitest config. Added a regression test for the Public Profile incident above (verified it fails against the pre-fix rule, passes against the current one).
- **`functions/test_e2e.js` never actually exercised `onTripFinalized`** — three separate blockers, found while getting it running for the first time: (1) it connected to a different Firestore emulator project ID than the one `.firebaserc`/the Functions emulator uses, so the trigger's Eventarc listener never saw its writes at all; (2) the FieldValue/Timestamp emulator bug above; (3) `NetworkEngine.observe()` requires a non-zero trip `duration`, but back-to-back START+END in a test produces `duration: 0` and silently no-ops — added a `backdateActiveTripStart()` helper; (4) journey-linking history requires `stop_matched: true`, which needs a seeded `stops` collection the test never had — added one. Also fixed a stale `networkGraph` doc-ID format in the test's own assertion helper (`user_{id}_...` — the real format has no `user_` prefix). All 3 e2e tests pass now, reproducibly. Excluded `test_e2e.js` from the plain `node --test` glob (needs the emulator) and wired `unit`/`rules`/`e2e` into a new CI workflow (`.github/workflows/test.yml`) so none of this goes unrun again.

### Changed
- **Docs cleanup after the Atlas integration landed** (`README.md`, `SECURITY.md`, `DOCUMENTS.md`, `Tools/README.md`, `docs/ROADMAP_TECHNICAL.md`, `.gitignore`): README now credits Atlas as the data provider. SECURITY.md lists it as a read-only third-party data source. DOCUMENTS.md's dead link to a legacy `setup-admin.md` (never tracked, lives under gitignored `_legacy_v1/`) is removed. Tools/README.md documents six scripts that existed but weren't listed (stop-metadata backfill, trip-hub migration/rollback, trip-based stop enrichment). ROADMAP_TECHNICAL.md's "Broader GTFS stop import" and "Scheduled GTFS refresh" items are checked off — both now handled by Atlas's weekly refresh. `.gitignore` typo fixed (`**/ .npm-cache/` → `**/.npm-cache/`).
- **`Tools/README.md`**: documented the interim cadence for `backfill-stop-metadata.js` (rerun quarterly until Atlas#161 ships) — Phase 1 of Transit-Stats#152's layered stop-data plan.
- **`.gitignore`**: added `.agents/` — working-state scratch from a separate agent-orchestration tool that ran against this repo, not meant to be tracked.
- Removed a stray tracked duplicate (`functions/package-lock 2.json`) and untracked sync-conflict/scratch files (`Tools/backfill-stop-metadata 2.js`, `Tools/backfill-stop-metadata-dryrun 2.js`, `count-trips-node.js` x2) that had accumulated outside git.

## [1.46.0] — 2026-07-10

### Added
- **Route Tracker on the dashboard, powered by Atlas** (`js/route-tracker.js`, `js/pages/dashboard.js`, `dashboard.html`): The per-agency route completion tracker now loads route definitions from Atlas's public R2 GeoJSON (`atlas/{slug}.json`) instead of the manually imported Firestore `routes` collection — route lists stay current with Atlas's weekly refresh, no admin GTFS uploads. Parsed client-side (189 unique TTC routes), cached in IndexedDB keyed by refresh week, Firestore fallback kept for agencies Atlas doesn't carry. Tracker card now lives on the main dashboard (8 GTHA/Ottawa agencies selectable); admin copy unchanged.
- **Stops now enrich themselves from Atlas on creation** (`functions/lib/atlas-enrich.js`, `functions/index.js`, `functions/test_atlas_enrich.js`): New Firestore trigger `onStopCreated` fills Layer-2 facts (direction, routes, official-name alias, `stopRoutes` doc) on any newly created stop doc from Atlas's published `atlas/{slug}-stops-meta.json` — the manual-paste decay problem can't restart. Layering rules enforced in code: `name` is never touched, official names land in `aliases` verbatim, only missing fields are filled, and paired platforms sharing a code only contribute facts every entry agrees on. No-ops gracefully until the Atlas artifact exists on R2; TTC mapped first, other agencies are one slug entry each. 4 unit tests.

### Data
- **TTC stop metadata backfilled from GTFS** (`Tools/backfill-stop-metadata.js`, `Tools/backfill-stop-metadata-dryrun.js`, Firestore `stops` + `stopRoutes`): Months of manually pasted stop info had been saved without its direction/route fields — 104 of 169 manual stops were name+code only, and the `stopRoutes` collection (which all route-aware narrowing reads) had zero docs since it was built. One pass against the official TTC GTFS fixed it: 127 stop docs updated (89 directions, 117 route lists, 92 official-name aliases), 131 `stopRoutes` docs created. Guardrails: never overwrites curated values, direction only written when ≥90% of scheduled visits agree and the official name suffix doesn't contradict it (14 genuinely bidirectional stops left direction-less on purpose). Verified live: `510 + Spadina/Dundas + Northbound` now narrows to stop 7349 with no prompt. Script is idempotent — rerun after future GTFS updates.

### Changed
- **SMS: stop clarification is no longer an interrogation** (`functions/lib/handlers-utils.js`, `functions/lib/dispatcher.js`, `functions/test_handlers.js`, `functions/test_dispatcher.js`): Three changes to the "Multiple stops match" flow. (1) When every candidate shows the same name and none has a direction, the prompt is skipped entirely — "Spadina / Dundas (stop 8121) vs (stop 7349) vs (stop 2190)" is unanswerable for a rider; the trip now starts silently with the shared name and `stop_matched:false`. Prompts still appear when candidates are human-distinguishable (different names or direction labels). (2) New `SKIP` reply dismisses the clarification and keeps the trip — previously the only exit was DISCARD, which cancels the whole trip. (3) Prompt copy now says the choice can be made anytime during the trip and that DISCARD cancels the trip, not just the choice. Added 2 regression tests.
- **Dependency updates** (`package.json`, `functions/package.json`, `.github/workflows/retrain.yml`): `firebase` 12.14.0 → 12.15.0, `vitest`/`@vitest/ui` 4.1.8 → 4.1.10, `playwright` 1.60.0 → 1.61.1, root `firebase-admin` 13.10.0 → 14.1.0, `eslint` 10.4.1 → 10.6.0, `globals` 17.6.0 → 17.7.0, `onnxruntime-node` 1.26.0 → 1.27.0, `actions/checkout` v4 → v7. Held back `functions/firebase-admin` at 13.10.0 — `firebase-functions@7.2.5`'s peer range tops out at admin v13, so bumping it to 14 would create a real peer conflict, not just an npm warning.
- **Retrain workflow now records results to MODEL_LOG.md automatically** (`.github/workflows/retrain.yml`, `ml/train_endstop.py`, `ml/train_routes.py`): V4 accuracy is now saved to meta files (`model_v4_endstop_meta.json`, `model_v4_meta.json`) alongside existing V5 metas. After each retrain, a dated entry covering all four models (V4/V5 route + end-stop) is prepended to `ml/MODEL_LOG.md` and committed with the artifacts. Route models are now also retrained automatically — previously only end-stop ran in CI.

### Fixed
- **Two stale unit tests brought back in line with shipped behavior** (`functions/test_dispatcher.js`, `functions/test_handlers.js`): The MMS unknown-user test still expected the pre-v1.45.0 "Text REGISTER [email]" reply (now conversational onboarding + `awaiting_email` state), and the anomaly-note tests mocked the pre-v1.44.0 `NetworkEngine.load` path — `detectAnomaly` now reads the personal `networkGraph` doc directly, so the harness never served it and the note path was silently untested. Harness now serves a `networkGraph` doc and defines `_docId`; both features were working in production all along. Functions suite: 244/248, only the emulator-dependent e2e file remains red without an emulator.
- **SMS: stop-disambiguation reply "1" died with "Could not understand" if sent more than 5 minutes after the prompt** (`functions/lib/handlers-utils.js`, `functions/lib/dispatcher.js`, `functions/test_dispatcher.js`): The `confirm_stop` pending state expired after the 5-minute default TTL — too short for a rider mid-trip — so the numeric reply fell through every parser to the fallback, which also logged a junk `needs_review` trip for the bare "1". Three changes: (1) `confirm_stop` TTL raised to 60 minutes; (2) `END`/`STOP` now pass through `confirm_stop` so a trip can be ended before its start stop is picked (previously the longer-lived state would have nagged "Reply with a number" instead of ending); (3) a bare number reaching the fallback now gets "That choice expired..." instead of "Could not understand", and no junk trip is written. Added 2 regression tests.
- **Weekly retrain workflow's YAML was invalid and would have failed on its next scheduled run** (`.github/workflows/retrain.yml`): The `MODEL_LOG.md` entry was built from a triple-quoted Python f-string embedded inside a YAML block literal (`run: |`); its markdown headers and `---` separator started at column 0, which is less-indented than the block literal requires — a hard YAML parse error, confirmed by GitHub's own workflow validator. Rebuilt the entry as a list of consistently-indented lines joined with `\n` instead of a multi-line string, sidestepping the indentation trap. Output is byte-for-byte identical to the original intended format.
- **`npm ci` was failing in CI on every open PR** (`package-lock.json`): Lock file was generated with npm 11, which resolves optional deps differently than npm 10 (CI's pinned Node 22 bundle) — missing an `@emnapi/runtime` entry. Regenerated with npm 10 to match CI; also fixed a stale `version` field left over from the 1.45.1 release.
- **Firebase hosting deploy no longer fails when frontend content is unchanged** (`.github/workflows/firebase-hosting-merge.yml`): Replaced `action-hosting-deploy@v0` with a direct CLI step that treats Firebase's "current active version" 400 error as a success — the site was already up to date.

## [1.45.2] — 2026-06-22

### Fixed
- **Weekly model retrain workflow had been silently failing for 6+ weeks** (`.github/workflows/retrain.yml`, `ml/train_endstop.py`, `ml/requirements.txt`): Four separate issues resolved: (1) missing `requirements.txt` caused pip cache step to abort before any code ran; (2) `onnxmltools` dependency on `packaging` wasn't installed; (3) `evaluate()` assumed `le.classes_` and `model.classes_` always matched — if a rare end-stop class got no training samples, `LogisticRegression` output fewer probability columns and crashed `top_k_accuracy_score`; (4) `FIREBASE_TOKEN` secret was unset, blocking deploy. Also raised the minimum end-stop class threshold from 3 → 10 trips so classes with too little data are dropped before training.

## [1.45.1] — 2026-06-20

### Security
- **Resolved CodeQL polynomial regular expression ReDoS alert** (`functions/lib/handlers-commands.js`): Fixed the `AGENCY` command parsing regex which was vulnerable to catastrophic backtracking when given multiple spaces. The pattern now strictly anchors on a non-whitespace character (`\S`), preventing overlapping matches.
- **Dependency updates** (root `package.json`, `package-lock.json`): Upgraded `undici` override to `^7.28.0` to patch CVEs relating to TLS validation bypass via SOCKS5 and shared cache whitespace bypass. Regenerated package lock.

## [1.45.0] — 2026-06-18

### Security
- **Verification code brute-force via repeated REGISTER** (`functions/lib/handlers-commands.js`, `functions/lib/db/users.js`): After 3 failed code attempts, phone is locked for 10 minutes — re-calling REGISTER during lockout is blocked with a countdown message. `getVerificationData` no longer deletes a locked doc on expiry so the lockout survives the code TTL.
- **Removed verbose debug logging from Twilio signature validation** (`functions/lib/twilio.js`): `console.info` calls on every request were logging URL structure and body keys to Cloud logs. Now only warns on genuine validation failure.

### Fixed
- **SMS registration: verification code pending state expired in 5 minutes** (`functions/lib/db/trips.js`, `functions/lib/handlers-commands.js`): The default `setPendingState` TTL is 5 min — too short for email delivery + user response. Verification state now uses a 20-minute TTL via a new optional `ttlMs` parameter. Confirmation message now tells the user they have 20 minutes.
- **SMS registration: dead-end messages gave no URL** (`functions/lib/handlers-commands.js`, `functions/lib/dispatcher.js`): "No account found" and the unknown-number welcome now include transitstats.fyi so users know where to sign up.
- **`checkOutboundLoop` catch block referenced undefined `trace`** (`functions/lib/dispatcher.js`): If the Firestore get ever threw, the catch block itself would throw a `ReferenceError` that propagated uncaught through dispatch. Removed the undefined reference.
- **`resolveTripAgency` prompted agency disambiguation when stop only existed in default agency** (`functions/lib/handlers-utils.js`): The third branch fired `promptAgencyChoice` even when `stopInLast` was false — i.e. the user's last-trip agency didn't even have that stop, yet both were offered. Now silently uses the default agency in that case.

### Changed
- **Dependencies: bumped `form-data` and `protobufjs`** (root and `functions/package-lock.json`): Fixed 3 high `form-data` CRLF injection alerts and 1 moderate `protobufjs` schema-shadowing alert via `npm audit fix`.

## [1.44.0] — 2026-06-18

### Fixed
- **SMS: `confirm_start` handler fell through to "Could not understand"** (`functions/lib/dispatcher.js`): Replies that weren't START/DISCARD/FORGOT (e.g. "1" from a prior agency disambiguation) returned `false` from `handleConfirmStartState`, falling all the way through to the fallback. Now passes STATUS/STATS/etc. through and sends a reminder for everything else. Same fix class as the v1.42.0 `confirm_stop` regression.
- **SMS: agency disambiguation labels "Toronto / GTA" vs "Toronto" were confusingly similar** (`functions/lib/handlers-utils.js`): Disambiguation prompt now shows the agency names directly (e.g. "1. GO Transit" / "2. TTC") instead of city labels, which were identical enough to be misleading.
- **SMS: anomaly detection "took longer than usual" used global trip data** (`functions/lib/finalization.js`): `NetworkEngine.load()` falls back to the all-users global graph when personal history is sparse. This caused "typical X min" to reflect other users' trips. `detectAnomaly` now reads the personal graph document directly — if it doesn't exist, no anomaly is reported. Also removed the boarding-stop-wide median fallback; anomaly only fires when the specific start→end edge has personal history.

### Added
- **SMS: SKIP reply for agency disambiguation** (`functions/lib/dispatcher.js`): When asked "Which [stop]? 1. GO Transit 2. TTC", replying SKIP uses the default agency and skips the prompt. Prompt now shows all three options.
- **SMS: SETTINGS command** (`functions/lib/handlers-commands.js`, `functions/lib/dispatcher.js`): `SETTINGS` shows current default agency. `SETTINGS AGENCY [name]` changes it (validates against known agency list). Shown in HELP output.

## [1.43.3] — 2026-06-17

### Fixed
- **Parser: "Down Mountain" / "Uphill" wrongly parsed as agency** — added "Down Mountain", "Downhill", "Up Mountain", "Uphill" (and hyphenated/no-space variants) to `normalizeDirection` and `CANONICAL_DIRECTIONS`, so escarpment-style direction terms on line 3 are recognized correctly instead of falling through to the agency slot.
- **Data: corrected agency on 7 trips from today** — Route 20 ×2, Route 25, Route 41, Route 5A (all → HSR) and Lakeshore West ×2 (→ GO Transit), where "Down Mountain" or "Uphill" had been stored as the agency.

## [1.43.2] — 2026-06-17

### Changed
- **Security**: bumped `vite` to 8.0.16 (CVE fixes for Windows alternate-path bypass and NTLMv2 hash disclosure via UNC paths); updated both `devDependencies` and `overrides` so vitest's transitive dep resolves to the patched version.

## [1.43.1] — 2026-06-12

### Changed
- **Dependency updates**: bumped `firebase` to 12.14.0, `eslint` to 10.4.1 in `/functions`, `vitest` and `@vitest/ui` to 4.1.8 in root. `firebase-admin` held at 13 — `firebase-functions@7.2.5` peer dep does not yet declare support for v14.
- **CI: upgrade to Node.js 24 actions** (`.github/workflows/`): Updated `actions/checkout` to v6 and `actions/setup-node` to v6 ahead of GitHub's June 16 Node.js 20 deprecation deadline.

## [1.43.0] — 2026-06-11

### Fixed
- **Gemini model deprecated** (`functions/lib/gemini.js`): Updated model from `gemini-2.0-flash` (404 Not Found) to `gemini-2.5-flash`, now centralized as `GEMINI_MODEL` constant so future upgrades are a one-line change. ASK, MMS, and parsing commands were all failing silently. Also added 404/"no longer available" to the no-retry list in `retryWithBackoff` so permanent failures fast-fail instead of burning 3 attempts.

### Added
- **ML check-in task system** (`functions/lib/ml-tasks.js`, `functions/lib/handlers-trip.js`): After each trip ends, checks Firestore `mlTasks` collection for pending check-ins scoped to the user. When a task's trip threshold is crossed, fires an SMS reminder and marks the task triggered. Phone number is looked up from `phoneNumbers` at fire time so the system works for any user. First task seeded: audit V4/V5 shadow accuracy after 30 TTC trips since 2026-06-09 (stop feature fix).

## [1.42.0] — 2026-06-09

### Fixed
- **`lastEndStopName` missed legacy `endStop` field** (`functions/lib/handlers-trip.js`): Inference read only `endStopName`, but older trips in history only have `endStop`. Training export uses both (`endStopName or endStop`). `last_end_stop` would be null for the next trip after any legacy trip, firing `last_stop_none` instead of the actual prior stop. Fixed with a one-line fallback.
- **Training/inference skew: multiple feature mismatches** (`functions/lib/ml_utils.js`, `functions/lib/predict_v4.js`, `functions/lib/predict_v5.js`, `ml/train_endstop.py`, `ml/train_routes.py`): (1) All `stop_*` and `last_stop_*` features were silently zero in every production inference call — Python exported feature names with spaces/slashes (`stop_bay station`) but JS generated underscores (`stop_bay_station`); (2) `" and "` separator not handled in JS `canonicalizeStop`; (3) `last_stop_none` vs `last_stop_unknown` mismatch on first trip of the day; (4) V4 route `transfer_rarity` never set in inference (always 0); (5) V5 `transfer_rarity` took first route match instead of averaging. Models were predicting on time + route + direction only — no stop identity signal — since V4/V5 were introduced.
- **SMS stop disambiguation ignores reply "1"** (`functions/lib/dispatcher.js`, `functions/test_dispatcher.js`): When a user replied with a number during stop disambiguation, a concurrent iOS API trip command could fall through the `confirm_stop` handler and overwrite the pending state with `confirm_start`. The user's next "1" then hit the wrong handler and fell through to "Could not understand." Fix: unrecognized input in `confirm_stop` now sends a reminder and returns early. STATUS/STATS/ASK/FORGOT/INFO still pass through normally. Added 3 regression tests.

### Changed
- **V5.5/V4.5 end-stop models** (`ml/train_endstop.py`): Retrained on 288 cleaned trips (573 exported). End-stop V5.5 84.5% top-1 (+7.9pp vs V5.3), V4.5 75.9% (+7.8pp). Direction (northbound/southbound/eastbound/westbound) added as one-hot feature — root cause of prior low production accuracy was Route 1 northbound/southbound trips being indistinguishable. New 19th end-stop class. `normalizeDirectionForMl` added to `ml_utils.js`.
- **V5.5/V4.5 route models** (`ml/train_routes.py`): Route V5.5 81.9% top-1 (+14.9pp vs V5.3), V4.5 63.8% (+3.6pp). Stop feature name fix applies here too.
- **Stop library additions**: Added College St at St George St (stop 845, Westbound, route 506); updated College / Beverley (stop 815, Eastbound) with aliases; added Dufferin St at Dufferin Park Ave (stop 2040, Northbound, routes 29/929); added directions to Bathurst / King stops 161 (Northbound) and 162 (Southbound, route 511). Backfilled `stop_matched=true` on 35 trips.
- **Refactor: pending-state handlers** (`functions/lib/dispatcher.js`): Extracted shared `PENDING_PASSTHROUGH` set to a module-level constant. All three disambiguation handlers now use the same passthrough check. Added `logger.warn` for unknown state types.
- **Slim stopCandidates in pending state** (`functions/lib/handlers-utils.js`): Candidates stored in `confirm_stop` now stripped to `{ stopCode, stopName, direction, routes }` before writing to Firestore.
- **Restored V3 as PredictionEngine** (`functions/lib/predict.js`): `predict.js` was pointing to V5, but `handlers-trip.js` calls V3-only methods — the entire prediction block was silently failing on every trip start. Restored V3 as the `PredictionEngine` export.
- **Fixed stopsLibrary out of scope in detectProvisionalTransfer** (`functions/lib/handlers-trip.js`): `stopsLibrary` was a free variable, causing a `ReferenceError` on every call. Now passed as an optional 5th parameter.
- **Test infrastructure: finalization module mocked** (`functions/test_handlers.js`): All 20 `test_handlers.js` tests now pass (up from 14).

## [1.41.0] — 2026-06-05

### Added
- **Strictly Normalized Hub Model** (functions/lib/transfer.js, functions/lib/finalization.js, iOS App): Refactored the entire project to follow a strictly normalized data architecture: Trips link to Stops, and Stops link to Hubs. Hub resolution is now performed dynamically at the reasoning layer (e.g., during journey linking) rather than being denormalized onto the trip record.
- **Hub-Aware Transfer Engine** (functions/lib/transfer.js): Upgraded the journey linking logic to prioritize dynamic hubId resolution via the stops library. Trips sharing a verified Hub ID now achieve high-confidence transfer status automatically, bypassing fragile name-matching heuristics.
- **Database-Driven Hub Model** (firestore.rules, stops collection): Migrated hardcoded stop complexes from transfer-connections.js into the Firestore stops collection using a new hubId field. This enables dynamic, shared stop grouping that can be updated without code deployments.
- **Stop Hub Migration Tool** (Tools/migrate-hubs-to-firestore.js): Utility to bootstrap the Firestore hubId and verified fields from existing JS configuration, deduplicating 18 canonical station complexes.
- **Stop Enrichment Engine** (Tools/enrich-stops-from-trips.js): Implemented a "Discovery Loop" that scans trip GPS data to automatically geocode unmapped stops and suggest new physical Hub clusters based on high-precision coordinate consensus.
- **iOS API Endpoint** (functions/api.js, functions/index.js): Added a secure HTTP API endpoint in Firebase Cloud Functions that authenticates iOS client users via Firebase Auth ID tokens, performs user phone lookup, and runs the dispatcher inside an AsyncLocalStorage context.

### Fixed
- **Security Hardening (ReDoS & Dynamic Dispatch)** (functions/lib/parsing.js, functions/lib/ml_utils.js): Resolved CodeQL security alerts (js/polynomial-redos and js/unvalidated-dynamic-method-call). Fixed polynomial backtracking in vehicle matching regex and secured the ML policy registry against prototype pollution by using null-prototype objects.
- **Data Restoration (Denormalization Cleanup)** (Tools/rollback-trip-hubs.js): Successfully executed a restoration script to remove denormalized startHubId and endHubId fields from 416 historical trip records, ensuring the production database adheres to the strictly normalized architectural mandate.



## [1.40.0] — 2026-05-27

### Added
- **SMS request tracing** (`functions/lib/logger.js`, `functions/lib/dispatcher.js`, `functions/sms.js`, all handlers): Every SMS request now carries a short correlation ID (`t:xxxxxxxx`) through the full dispatch lifecycle. Logger now emits `[INFO][t:abc12345]` style prefixes and accepts `traceId` in data objects (or as a convenience parameter). Dispatcher, trip handlers, query handlers, command handlers, and key intelligence paths all propagate the ID. This enables end-to-end correlation of complex flows (pending states, disambiguation, prediction paths, Gemini calls) in Cloud Logging without changing any existing call sites.

### Changed
- **ML route normalization policy layer complete** (`ml/route_normalization.py`, `functions/lib/ml_utils.js`, `ml/train_routes.py`, `ml/train_endstop.py`, `ml/calibrate_v4.py`, `functions/lib/handlers-trip.js`, `functions/lib/predict_v4.js`, `functions/lib/predict_v5.js`): Fully replaced TTC-biased hardcoded normalization with a neutral per-agency policy system. Added PRIMARY policy support (with `primary_agency` parameter) so the special collapse behavior follows each user's dynamically computed default agency from recent trips. Training and calibration scripts are now PRIMARY-aware. Automatic recompute of `defaultAgency` added on trip end. All configs use "PRIMARY" + "DEFAULT" (no hardcoded agency names). Live V4/V5 paths updated. Task delivered consistently on training + inference sides.
- **V6 analysis stop normalization** (`ml/v6_sequence_audit.py`, `ml/calibrate_v4.py`): Updated the main V6 sequence/transfer experiment script and V4 calibration backtest to load the curated stops library and canonicalize stop names (instead of using raw values). This makes the signal measurements consistent with the normalized stops + aliases system.
- **Correction auto-re-finalization blocked** (`functions/index.js`, `functions/lib/finalization.js`): High-impact corrections (correctedFields, needs_reprocess, exclude_from_*) now strictly prevent automatic background re-runs of `runPostEndFinalization`. Trigger only fires on new `endTime`; idempotency guard skips on `backgroundFinalizedAt` unless `force` (manual only via `triggerManualFinalization`). Protects V3/V4/V5 accuracy % and Network/Transfer/Habit learning from known-bad original data. Matches TRIP_CORRECTIONS.md intent and explicit user decision. (Reverses prior "safer corrections" auto path.)
- **E2E test skeleton for background finalization** (`functions/test_e2e.js`, `functions/package.json`): Added `npm run test:e2e` (emulators:exec for firestore+functions) and initial skeleton. First step toward emulator-backed coverage of full dispatch → background finalization paths + correction exclusion logic (approved Notion task).
- **E2E chunk 2** (`functions/test_e2e.js`): Added `waitForFinalization` polling helper and first real assertions on `backgroundFinalizedAt` + `finalization.steps` (learning + grading) after END. Still under single approved Notion task.
- **E2E chunk 3** (`functions/test_e2e.js`): Added helpers + assertions verifying side-effects: `predictionStats` rows written and `networkGraph` updated by background finalization (core of the approved task).
- **E2E chunk 4** (`functions/test_e2e.js`): Added correction exclusion test — high-impact edit after finalization does not auto re-run learning/grading (finalization timestamp unchanged). Manual `triggerManualFinalization` correctly re-processes. Directly validates the approved "corrections must not taint accuracy" behavior.
- **E2E chunk 5** (`functions/test_e2e.js`): Added background journey linking test (short-gap sequential trips) asserting `journeyLinked`, `linkedJourneyId`, and shared journeyId written back to prior leg.
- **E2E task complete** (`functions/test_e2e.js`): Robust emulator-backed coverage for the full approved Notion task (dispatch + background finalization, side effects, correction safety, journey linking). Anomaly note helpers noted as future polish (out of core scope). Single task throughout.
- **Post-trip finalization extracted** (`functions/lib/finalization.js`, `functions/lib/handlers-trip.js`): Moved prediction grading, journey linking, anomaly detection, next-leg suggestions and learning side-effects out of `handleEndTrip` into dedicated module. Handler is now thin; functions reusable from background triggers.
- **Background trip finalization trigger** (`functions/index.js`, `functions/lib/finalization.js`): Added `onTripFinalized` Firestore trigger. Post-end work (NetworkEngine, Habit rebuild, grading) now runs reliably in background. Removed synchronous grading + learning calls from handler.
- **Handler cleanup for post-end logic** (`functions/lib/handlers-trip.js`): Handler now only calls lightweight compute functions (`computeJourneyLink`, `detectAnomaly`, `getNextLegSuggestion`) for the SMS reply. All heavy side effects are fully in the background path.
- **Journey linking centralized** (`functions/lib/finalization.js`): Added shared `detectJourneyLink` helper. Duplicated detection logic removed from handler. Background finalizer now uses the same logic for reliable linking.
- **Journey link result persisted** (`functions/lib/finalization.js`): Background finalization now writes `journeyLinked` + `linkedJourneyId` back to the trip so the link is durable and queryable later (for corrections, STATUS, etc.).
- **Handler post-end cleanup** (`functions/lib/handlers-trip.js`): Removed outdated provisional journey detection code and cleaned up comments. Handler is now clearly separated from background side effects.
- **Background finalizer observability** (`functions/lib/finalization.js`): Added structured logging (start/finish + per-phase success/error) to `runPostEndFinalization`. Errors are now isolated so one failure doesn't block other background work.
- **Finalization execution metadata** (`functions/lib/finalization.js`): `runPostEndFinalization` now writes a `finalization` object (`ranAt` + `steps` array) to the trip, making it easy to see exactly what the background system executed for any given trip.
- **Last synchronous post-end side effect removed** (`functions/lib/handlers-trip.js`, `functions/lib/finalization.js`): Gtfs stop verification promotion (`source: 'verified'`) moved into the background finalizer. The handler now performs zero direct Firestore side-effect writes after trip end.
- **Manual re-finalization support** (`functions/lib/finalization.js`): Added `triggerManualFinalization(tripId)` which forces `runPostEndFinalization` to run on any trip, bypassing idempotency. Useful for corrections, admin repair flows, and future scheduled maintenance.

## [1.39.1] — 2026-05-26

### Fixed
- **SMS stop disambiguation now uses route metadata before prompting** (`functions/lib/handlers-utils.js`, `functions/test_handlers.js`): Named-stop trip starts now enrich ambiguous candidates from `stopRoutes` before deciding whether to ask for clarification, and direction narrowing now prefers explicit direction matches over generic directionless candidates. This reduces unnecessary prompts for cases like `506 + Dufferin / College + Eastbound` once normalized stop records include the correct physical stop direction. Multi-stop SMS prompts also now include blank lines around the choice list for better readability.

### Security
- **Dependency updates** (`package.json`, `package-lock.json`): Resolved 9 security vulnerabilities identified by Dependabot and `npm audit`.
  - Updated `firebase-admin` to `^13.10.0`.
  - Updated `playwright` to `^1.60.0`.
  - Updated `vitest` and `@vitest/ui` to `^4.1.7`.
  - Updated `vite` to `^8.0.14`.
  - Added `uuid@^11.1.1` override to resolve buffer bounds check vulnerability (GHSA-w5hq-g745-h8pq) across transitive dependencies (`@google-cloud/storage`, `google-gax`, etc.).

## [1.39.0] — 2026-05-24

### Added
- **Vehicle field tracking** (`functions/lib/parsing.js`, `functions/lib/gemini.js`, `functions/lib/handlers-trip.js`, `functions/lib/dispatcher.js`, `dashboard.html`, `js/pages/dashboard.js`, `js/trips/TripFeed.js`, `functions/test_parsing.js`): Added end-to-end support for tracking vehicle numbers/names. Includes heuristic extraction from SMS lines or inline stop names, updated Gemini AI extraction, Firestore storage, and display/edit capability in the Web UI.

### Changed
- **STATS — "Top route" on its own line** (`functions/lib/handlers-query.js`): Top route summary in the 30-day stats response is now a separate paragraph (e.g., "Top route: 1 (39×)") and the word "Ridden" has been replaced for a cleaner, more conversational tone.
- **Route validation now rejects obvious direction/street/transit fragments without breaking legitimate named services** (`functions/lib/utils.js`, `tests/utils.test.js`, `functions/test_utils.js`): Tightened the permissive named-route fallback so generic tokens like `NB`, `BUS`, `ST`, and `TRAIN` no longer pass as valid routes, while keeping support for real labels such as `Orange`, `Green Line`, and `Pacific Surfliner`.
- **Default Vitest discovery now stays inside the real repo test surface** (`vite.config.js`): Scoped the default test run to `tests/**/*.test.js`, excluded agent/worktree folders, and left Firestore rules coverage on the explicit emulator-backed `npm run test:rules` path so `npm test` remains a local unit-test command.
- **Habit confidence and stale-pattern detection now anchor to trip context instead of wall-clock drift** (`functions/lib/habit.js`): Habit extraction scores against the latest trip in the snapshot, matching re-scores confidence against the attempted boarding time, and stale-habit replacement checks use the dataset’s own recency window so long-lived tests and offline rebuilds do not silently decay or miss emerging replacements just because real time passed.

## [1.38.0] — 2026-05-20

### Added
- **Post-trip SMS notes command** (`functions/lib/dispatcher.js`, `functions/lib/handlers-commands.js`, `functions/lib/handlers-trip.js`, `functions/test_dispatcher.js`, `functions/test_handlers.js`): Trip-end replies now advertise `Reply NOTES (your note) to add a note.`, and `NOTES ...` attaches text to the most recent completed trip.
- **Correction metadata foundation** (`functions/lib/db/trips.js`, `functions/lib/db/index.js`, `ml/export_trips.py`, `ml/analyze_predictions.py`): High-impact trip corrections can now be marked for reprocessing/exclusion so corrected trips do not silently remain in training and accuracy-analysis paths as if they were untouched.

### Changed
- **Transfer-complex stop resolution now prefers the right physical stop class by route mode** (`functions/lib/db/stops.js`, `functions/lib/handlers-utils.js`, `functions/test_handlers.js`): Resolver narrowing now uses TTC route-mode heuristics to prefer station-like candidates for rapid transit and surface-platform candidates for streetcar/bus routes, reducing needless ambiguity across shorthand like `College`.

### Fixed
- **End-trip text resolution no longer drops single matched candidates that lack a stop code** (`functions/lib/handlers-trip.js`, `functions/test_handlers.js`): When the end-stop matcher narrows text input to one stop-library candidate, that candidate is now used directly instead of being lost on a second code-only lookup.
- **Admin prediction-accuracy panel removed from Settings** (`settings.html`, `js/pages/settings.js`): Stale incremental accuracy counters are no longer surfaced in the Settings UI; raw `predictionStats` remains the truth source for manual model evaluation.

## [1.37.1] — 2026-05-20

### Fixed
- **Prediction audit rows now retain the originating trip ID** (`functions/lib/handlers-trip.js`): All `predictionStats` writes now include `tripId`, so route/end-stop grading rows can be traced back to the exact trip that produced them instead of relying on fuzzy matching by timestamp, version, or labels.

## [1.37.0] — 2026-05-18

### Added
- **Transfer-pair candidate audit tool** (`Tools/audit-transfer-pair-candidates.js`, `functions/lib/transfer.js`, `functions/test_transfer.js`):
  - **Evidence-only mining**: Added `TransferEngine.suggestConnectedPairs()` to surface repeated short-gap stop-pair candidates from real linked journeys without auto-mutating the canonical transfer map.
  - **Review script**: New Firestore-backed audit tool prints candidate connected pairs for a user with count, median gap, gap range, and route-pair evidence so recurring handoffs can be reviewed before promotion into `transfer-connections.js`.

### Fixed
- **Generic TTC transfer names now resolve through the transfer-complex layer** (`functions/lib/db/stops.js`, `functions/lib/handlers-trip.js`, `functions/lib/handlers-utils.js`, `functions/test_stops.js`, `functions/test_handlers.js`): Stop lookup no longer depends only on exact stop-library aliases for generic names like `College`. The resolver now gathers exact and transfer-complex-connected candidates together, then narrows them by `route` and `direction`. This allows behaviors like `506 + College + Westbound -> westbound surface stop`, `1 + College -> subway station`, while still falling back to clarification when direction is missing or ambiguity remains.
- **Stop clarification prompts now expose the physical stop more clearly** (`functions/lib/handlers-utils.js`, `functions/test_handlers.js`): Multi-match SMS prompts now include stronger labels like direction plus `stop ####` when candidates share the same display name or transfer complex, making fallback prompts for cases like `College` materially clearer than a list of near-identical names.

## [1.36.1] — 2026-05-17

### Added
- **Firestore privilege-boundary rules tests** (`tests/firestore.rules.test.js`, `package.json`): Added emulator-backed security tests covering normal profile creation, blocked self-promotion to `isPremium`/`isAdmin`, and admin-only privileged profile updates.

### Fixed
- **Profile privilege escalation via user-writable flags** (`firestore.rules`, `functions/lib/db/users.js`, `functions/lib/handlers-query.js`, `functions/lib/handlers-trip.js`, `functions/test_handlers.js`, `functions/test_dispatcher.js`): Users can no longer promote themselves by editing `profiles/{userId}`. Profile writes now preserve `isPremium` and `isAdmin` unless performed by an actual admin from `allowedUsers`, and backend admin-only behavior now checks `allowedUsers` directly instead of trusting mutable profile fields.
- **Twilio webhook validation logs exposed auth-derived material** (`functions/lib/twilio.js`): Removed `secretPrefix` and full `X-Twilio-Signature` values from production logs while keeping request-shape diagnostics for webhook debugging.

## [1.36.0] — 2026-05-17

### Added
- **NetworkEngine v2.1 — Pure Empirical Learner** (`functions/lib/network.js`, `functions/lib/handlers-trip.js`, `Tools/diagnose-naming-drift.js`):
  - **Discovery Mission**: De-coupled the engine from `topology.json`, restoring it as a pure learner that must "earn" its knowledge of the network through observation rather than reading from a hardcoded map.
  - **Temporal Deduction**: Surface routes (buses/streetcars) now learn adjacency by comparing trip durations. If A→C is 30m and A→B is 15m, the engine infers B precedes C and injects the B→C segment as an `inferred_temporal` edge.
  - **Canonical IDs**: Graph edges now store stable stop IDs and source metadata (`fromStopId`, `fromStopSource`, etc.) instead of relying on fragile display names.
  - **Weighted Confidence**: Upgraded the confidence model to factor in recency (decaying old edges) and source trust (preferring `verified` or `gtfs` stops over raw text).
  - **Drift Diagnostics**: New `Tools/diagnose-naming-drift.js` script to identify and clean up legacy naming inconsistencies in the historical graph data.
- **Geographic Prediction Constraints ("Menu-Based Filtering")** (`functions/lib/predict_v4.js`, `functions/lib/predict_v5.js`, `functions/lib/handlers-trip.js`):
  - **Hard Constraints**: ML models (V4/V5) are now restricted to a "Menu" of physically reachable stops provided by the Atlas and NetworkEngine before they make a guess. This eliminates "Hub Gravity" hallucinations where the model would guess popular destinations (like Spadina) even when they weren't on the current route.
- **TTC Surface Atlas Expansion** (`functions/lib/topology.json`): Added GTFS-verified stop sequences for major streetcar and bus trunks (510, 506, 505, 501, 511, 512, 504, 41) to serve as a high-fidelity prediction fallback and safety net.
- **End-stop legality telemetry + regression coverage** (`functions/lib/handlers-trip.js`, `functions/lib/predict_v4.js`, `functions/lib/predict_v5.js`, `functions/test_handlers.js`, `tests/predict.test.js`):
  - **Constraint source tracking**: Trip-start flows now record whether end-stop predictions were constrained by `network`, `topology`, or `none`, and log the legal-stop set size for auditability.
  - **Masked-top logging**: V4/V5 now log when the raw top ML destination is removed by the legality mask, making "physics beat popularity" interventions measurable in production.
  - **506 regression fixture**: Added rule-level tests proving a statistically dominant but illegal destination is excluded from the prediction menu for `506` from `College Station`, without any route-specific or stop-specific blacklist.
- **Transfer-complex reasoning + provisional journey hints** (`functions/lib/transfer-connections.js`, `functions/lib/transfer.js`, `functions/lib/handlers-trip.js`, `functions/test_transfer.js`, `functions/test_handlers.js`):
  - **Connected-stop library**: Added a curated transfer-complex layer for real TTC station handoffs, including `college`, `queen's park`, `spadina`, `union`, `king`, `dundas west`, `broadview`, `bathurst`, `main street`, `bloor-yonge`, `cedarvale`, `keelesdale`, `st george`, `lawrence west`, `sheppard-yonge`, and `osgoode`, so separate normalized stops can remain distinct records while still counting as one rider-meaningful transfer point.
  - **Provisional transfer detection at trip start**: New trips now score the most recent completed trip immediately and store lightweight provisional transfer metadata (`provisionalPrevTripId`, confidence) for real-time journey context, while final `journeyId` writes still happen conservatively at second-leg end.
  - **Connected-stop transfer matching**: `TransferEngine` stop-pair matching now accepts exact-stop matches or configured connected-stop pairs, fixing cases where adjacent surface/subway stops represent the same transfer complex in practice.
  - **Intersection-style connection pairs**: Added a second, narrower relationship layer for proven adjacent-stop handoffs like `College / Bay ↔ College Station`, `Spadina / Queens Quay ↔ Spadina / Queens Quay West`, and similar corner-to-corner TTC transfers without broadening station-complex groups.

### Fixed
- **Topology-covered routes now enforce a true legal downstream menu** (`functions/lib/predict.js`, `js/predict.js`, `tests/predict.test.js`): For covered route/boarding-stop/direction contexts, destinations outside the downstream stop sequence are now removed as physically impossible instead of being kept as "unknown." This closes the remaining loophole where a popular off-route stop like `Spadina Station` could survive alias drift and still win by historical weight on route `506`.
- **Topology alias matching normalized for slash/at variants** (`functions/lib/predict.js`, `functions/lib/predict_v4.js`, `functions/lib/predict_v5.js`, `js/predict.js`, `tests/predict.test.js`): Topology lookups now canonicalize stop names before matching, so rider text like `Spadina / College`, `College / Spadina`, and similar variants resolve to the same topology stop instead of silently disabling route constraints.
- **Journey linking can now bridge exact-stop boundaries inside a transfer complex** (`functions/lib/transfer.js`, `functions/lib/handlers-trip.js`, `functions/test_transfer.js`, `functions/test_handlers.js`): A `506` trip ending at the normalized surface stop outside `College Station` can now link correctly to a `Line 1` trip starting at `College Station`, without merging the two stops in the normalized stop library or changing displayed stop names.
- **Transfer matching now survives common TTC naming drift** (`functions/lib/transfer-connections.js`, `functions/test_transfer.js`): TransferEngine now canonicalizes a small set of observed stop-text variants and typos like `Keelsdale`, `Dundas/Sterlingp`, and `Dufferin&college`, and also handles intersection-order reversals like `Spadina / Harbord ↔ Harbord / Spadina` when matching transfer pairs.
- **SMS start-time preservation through stop/agency disambiguation** (`functions/lib/dispatcher.js`, `functions/lib/handlers-utils.js`, `functions/test_handlers.js`): Text trip starts now preserve the timestamp of the original inbound SMS even when the rider is prompted with follow-up clarification like `Which Bay?`. The provisional trip created during stop disambiguation now honors the original `startTime` instead of defaulting to the clarification reply time, preventing bogus `0 min` trips after short clarification loops.
- **Canonical stop names preserved in SMS replies** (`functions/lib/utils.js`, `tests/utils.test.js`): `getStopDisplay()` now uses matched `stopName` values from the normalized stop library as-is instead of re-running them through `toTitleCase()`. Fixes display regressions like `Bloor-Yonge Station` being degraded to `Bloor-yonge Station` after canonical lookup.
- **TransferEngine network hints actually wired through live trip-end flow** (`functions/lib/handlers-trip.js`, `functions/test_handlers.js`): `handleEndTrip()` now passes `NetworkEngine.getConnectionsAtStop()` into `TransferEngine.score()`, restoring the intended population-level transfer prior during auto-link decisions.
- **Transfer index feedback loop restored** (`functions/lib/handlers-trip.js`, `functions/test_handlers.js`): When a prior trip is identified as a transfer, `handleEndTrip()` now forwards `prevTrip.route` into `NetworkEngine.observe()`, allowing successful journey detections to populate `transferIndex` for future transfer suggestions and auto-link scoring.
- **Stop trust falls back to topology for covered routes** (`functions/lib/db/stops.js`, `tests/stops.test.js`): Stop resolution now checks the vetted normalized stop library first, then falls back to `topology.json` for route-covered subway/LRT stops before failing unresolved. This lets stops like `Davisville` on TTC Line 1 remain trusted for trip learning even when the normalized stop library is incomplete.

### Changed
- **Vetted TTC stop library expanded** (Firestore `stops` collection): Added `Davisville` as a manual TTC stop record so current Line 1 commute trips can resolve cleanly against the canonical stop library instead of falling through to unresolved raw text.

## [1.35.2] — 2026-05-12

### Fixed
- **Dependabot Alerts**: Resolved 8 high/moderate security vulnerabilities in `functions` by updating the `protobufjs` dependency tree to `7.5.8` via `npm audit fix`.

## [1.35.1] — 2026-05-12

### Fixed
- **CI Build Failure**: Removed `--omit=optional` from the root `npm install` command in GitHub Action workflows. Vite/Rolldown native bindings are installed as optional dependencies, and omitting them was causing `MODULE_NOT_FOUND` errors during the `npm run build` step.
- **SSRF CodeQL Alert**: Hardened MMS URL processing in `functions/lib/handlers-intelligence.js` by expanding the trusted Twilio domain whitelist, fully reconstructing target URLs to prevent bypasses, and ensuring guards and the `fetch` sink occur in the same try-block to resolve CodeQL alert #44.

## [1.35.0] — 2026-05-12

### Fixed
- **Next-leg suggestion displays original route label** (`functions/lib/network.js`, `functions/lib/handlers-trip.js`): Transfer index now stores `toLabels[connKey] = originalRoute` alongside counts. `getConnectionLabels()` retrieves them. Handlers-trip uses the original label for the "Usually take the X from here" SMS — fixing "510a" displaying instead of "510A", "greenline" instead of "Green Line", etc.
- **Anomaly detection uses destination-specific edge median** (`functions/lib/network.js`, `functions/lib/handlers-trip.js`): Added `getEdgeMedianDuration(graph, fromStop, toStop, hour)` to look up the specific A→C edge duration rather than aggregating across all edges leaving the boarding stop. Anomaly detection now calls this first and falls back to the aggregate only when no direct observation exists for the actual start→end pair. Prevents false positives on routes with diverse destinations (short ride to stop B vs. long ride to stop C from the same boarding stop).
- **SSRF guard restructured** (`functions/lib/handlers.js`): Merged the MMS URL validation and fetch into a single try block so the allowlist check directly guards the `fetch()` call. Also replaced an undefined `logger.warn` reference with `console.warn`, which was causing the two `handleMmsTrip` tests to fail with `ReferenceError`. Test URLs updated to use a trusted Twilio domain to match the validation.
- **Biased random in emoji picker** (`js/identity.js`): Replaced `Math.floor(randomUint32 / 0x100000000 * n)` with rejection sampling (`_randomIndex()`), eliminating the floating-point bias flagged by CodeQL alert #42. Bias was negligible in practice but the fix is correct and simple.
- **V4/V5 route grading normalization** (`functions/lib/handlers.js`): Route grading now normalizes both the predicted and actual route labels before comparing, matching the agency-aware normalization applied during ML training. Previously, a V5 prediction of `510` against an actual trip logged as `510A` always scored as a miss — grading compared raw labels, not normalized ones.
- **NetworkEngine mask uses MIN_TRIPS=2** (`functions/lib/network.js`): `getMask()` uses a lower confidence threshold (2 observations) than `filterCandidates()` (3 observations). Zeroing out ML probability mass is less risky than hard-filtering historical trip candidates, so the mask can act on sparser edge data.
- **NetworkEngine v1.3 — transitive reachability** (`functions/lib/network.js`): `getMask()` and `filterCandidates()` now augment the graph with inferred A→C edges derived from A→B + B→C pairs in the same direction before computing reachability. Inferred edges are single-hop only (no chaining through other inferred edges) and never overwrite observed edges. `tripCount = min(count1, count2)`, `medianMinutes = median1 + median2`. This makes any stop reachable via a learned intermediate stop available for prediction filtering after fewer real trips to that endpoint. 7 new tests.
- **NetworkEngine wired into V4/V5 end stop prediction** (`functions/lib/network.js`, `functions/lib/predict_v4.js`, `functions/lib/predict_v5.js`, `functions/lib/handlers.js`): V4/V5 end stop predictions now filter impossible stops via NetworkEngine before falling back to topology.json — the same priority order V3 uses. Previously topology.json only covered subway lines (1, 2, 4, 5), so surface route predictions (e.g. 510 streetcar) had no impossibility filter, causing the model to over-predict dominant destinations like Spadina & Nassau regardless of direction or boarding stop.

### Added
- **Habit change detection** (`functions/lib/habit.js`): `rebuild()` now detects when a different route/direction is emerging in the same (stop, day, 2-hour bucket) slot within the last 30 days. Old habits with a newer replacement pattern are marked `stale: true` with a `replacedBy` field. Stale habits are filtered out by `match()` so they stop firing immediately. 3 new tests.
- **Trip start reply formatting** (`functions/lib/handlers-utils.js`): Tightened `getPredictionPrompt` — removed "FORGOT if you forgot to end" and "INFO for help" from all cases, removed "Reply" prefix, split single-prediction reply into three clean paragraphs (start confirmation / destination guess / END instruction).
- **Anomaly detection** (`functions/lib/handlers-trip.js`): END reply now flags trips that took 2× or more the hour-specific median — "This trip took longer than usual (40 min vs. typical 10 min)." Uses the NetworkEngine hour-slot median for the trip's start hour. Suppressed for short typical trips (median < 5 min) to avoid noise. 2 new tests.
- **NetworkEngine v1.2 — hour-slot travel time buckets** (`functions/lib/network.js`): `observe()` now writes trip durations into `durationsByHour[hour]` on each edge alongside the existing flat pool. `getMedianDuration()` accepts an optional `hour` parameter and uses the hour-specific bucket when it has ≥3 observations, falling back to the aggregate when sparse. Staleness detection in `determineStaleness` now passes the current hour so rush-hour and off-peak trips are compared against the right baseline. 5 new tests.
- **Next-leg suggestion** (`functions/lib/handlers-trip.js`): END reply now surfaces the most likely next route when the alighting stop is a known transfer point — "Usually take the 2 from here." Feeds from the NetworkEngine transfer index (min 2 observed connections). Suppressed when the trip is already auto-linked as part of a journey. 2 new tests.
- **HabitEngine v1.0 + habit-first pipeline** (`functions/lib/habit.js`, `functions/lib/handlers-trip.js`, `functions/test_habit.js`): New engine that learns recurring trip patterns from history. Groups completed trips by (stop, route, direction, day-of-week, 2-hour bucket) and scores each group — count × recency decay (30-day half-life) × time-window precision. When a habit fires (confidence ≥ 0.75, route/direction match), V3/V4/V5 inference is skipped entirely and the SMS reply surfaces the known destination: "Usual trip to Spadina Station." `HabitEngine.match()` accepts optional route/direction filters so a 510 habit doesn't fire when the user boards the 29. Habit end stop predictions are graded at trip end (tracked in `predictionAccuracy`). Habits are rebuilt in the background after every trip end. 37 tests. 149/149 passing.
- **`handlers.js` split into focused modules** (`functions/lib/handlers-*.js`): Split the 1712-line file into five focused siblings — `handlers-utils.js` (10 shared helpers), `handlers-commands.js` (7 simple SMS commands), `handlers-trip.js` (4 trip lifecycle handlers), `handlers-query.js` (3 stats/journey handlers), `handlers-intelligence.js` (MMS + fill predictions). `handlers.js` is now a thin barrel re-export. All 145 tests pass.
- **NetworkEngine v1.1 — route-stop + transfer indexes** (`functions/lib/network.js`, `functions/lib/handlers.js`): `observe()` now writes two new Firestore collections alongside the edge graph. `routeStopIndex` tracks which routes serve each stop (board + alight counts). `transferIndex` tracks which route pairs connect at each boarding stop, populated when a trip has a `prevRoute`. Both are queryable via `getRoutesAtStop()` and `getConnectionsAtStop()`. Indexes build automatically from future trips — no backfill needed.
- **TransferEngine v1.1 — NetworkEngine possibility signal** (`functions/lib/transfer.js`, `functions/lib/handlers.js`): Transfer scoring now uses the NetworkEngine transfer index as a population-level prior when no personal history matches. A known route pair connection at the boarding stop pushes no-pattern confidence above the link threshold for short gaps (≤ 10 min) and extends the cold-start window from 15 → 20 min. Gets smarter as the index grows.
- **Prediction stats analysis script** (`ml/analyze_predictions.py`): Reports hit rates by model version, top confusion pairs, confidence calibration, and high-confidence misses from live `predictionStats` data.
- **Trip count diagnostic** (`ml/count_trips.py`): Breaks down total Firestore trip count by export-filter category to understand how many trips are excluded from ML training and why.
- **V5.2/V5.3 grade backfill** (`ml/backfill_v5_grades.py`): One-time script to correct `isHit` values for V5.2/V5.3 prediction records that were mis-graded due to the normalization bug above. Also corrects the corresponding `predictionAccuracy` running counters.
