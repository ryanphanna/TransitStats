#!/usr/bin/env bash
# One-command QA environment: Firebase emulators (auth, firestore, functions) + seeded fake data
# + the app's dev server pointed at the emulators. Nothing here can reach the real project.
#   bash qa/up.sh      start (or restart) everything
#   bash qa/down.sh    stop everything
# App:  http://localhost:5188   Emulator hub: 127.0.0.1:4450
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=qa/.run
mkdir -p "$RUN"
bash qa/down.sh >/dev/null 2>&1 || true

# The Functions emulator warns that it may use Application Default Credentials for non-emulated
# services. Point them at a file that does not exist so nothing can reach production.
export GOOGLE_APPLICATION_CREDENTIALS=/nonexistent/qa-no-credentials.json
export GCLOUD_PROJECT=demo-transitstats
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8150
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9150

for port in 9150 8150 5150 4450 4550 5188; do
  if lsof -ti :"$port" >/dev/null 2>&1; then echo "Port $port is in use; free it first." >&2; exit 1; fi
done

export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"   # the Firestore emulator needs Java
nohup nice -n 15 npx firebase emulators:start --config firebase.qa.json --project demo-transitstats \
  --only auth,firestore,functions > "$RUN/emulators.log" 2>&1 &
echo $! > "$RUN/emulators.pid"

echo -n "Waiting for emulators"
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:4450/emulators >/dev/null 2>&1 && grep -q "All emulators ready" "$RUN/emulators.log"; then break; fi
  echo -n "."; sleep 1
done
echo
grep -q "All emulators ready" "$RUN/emulators.log" || { echo "Emulators failed to start; see $RUN/emulators.log" >&2; exit 1; }

node qa/seed.mjs

# Dummy client config: the demo- project id makes qa/vite.qa.config.js accept it.
export VITE_FIREBASE_API_KEY=qa-fake-key
export VITE_FIREBASE_AUTH_DOMAIN=localhost
export VITE_FIREBASE_PROJECT_ID=demo-transitstats
export VITE_FIREBASE_STORAGE_BUCKET=demo-transitstats.appspot.com
export VITE_FIREBASE_MESSAGING_SENDER_ID=0
export VITE_FIREBASE_APP_ID=qa-fake-app
nohup nice -n 15 npx vite --config qa/vite.qa.config.js > "$RUN/vite.log" 2>&1 &
echo $! > "$RUN/vite.pid"
for _ in $(seq 1 30); do curl -sf http://localhost:5188/ >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://localhost:5188/ >/dev/null || { echo "Dev server failed; see $RUN/vite.log" >&2; exit 1; }
echo "Ready: http://localhost:5188  (sign in with qa/lib.mjs signIn, or the emulator users in qa/seed.mjs)"
