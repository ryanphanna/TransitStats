# QA environment

Runs the real app against the Firebase emulators with fake data. Nothing can reach the real project.

    bash qa/up.sh     # emulators + seed + dev server, about 15 seconds
    bash qa/down.sh   # stop everything

App: http://localhost:5188. Emulators: auth 9150, firestore 8150, functions 5150, hub 4450.

Fake users (password `qa-password`): `pilot@qa.test` (PRESTO pilot, 70+ trips, 34 imported PRESTO rows, one open trip),
`plain@qa.test` (no pilot), `admin@qa.test`, `public@qa.test` (public profile `/user/qapublic`), `empty@qa.test` (no trips).
Dates are relative to the day you seed, so "last month" always has rides, including one that crosses midnight at month end.

Playwright: `import { launch, signIn, BASE } from './qa/lib.mjs'`, then `signIn(page, 'pilot')`. `launch()` blocks any request
to the real Firebase project or Google APIs, so a bug can't leak into production.

How it works without touching app code: `qa/vite.qa.config.js` patches `js/firebase.js` at serve time to connect to the
emulators; `up.sh` sets `VITE_PUBLIC_PROFILE_URL` so public profiles use the functions emulator. It refuses to start unless the
project id starts with `demo-`. `up.sh` also points Google credentials at a missing file so the Functions emulator can't use
real ones. Ports 5001/8080 are avoided on purpose (other tools use them).

Repeatable checks (run after `bash qa/up.sh`, each prints what it found): `node qa/pages-sweep.mjs` (every main page as every
user, desktop + phone) and `node qa/flows/<name>.mjs` (signed-out redirect time, import denied for non-pilot, PRESTO import
and Recap month, sharing/public profile, Recap print/download, logout, phone dashboard map). Screenshots go to
`/private/tmp/claude-501/qa-shots`. Re-seed with `bash qa/up.sh` (it wipes and restarts the emulators).
