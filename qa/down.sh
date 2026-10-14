#!/usr/bin/env bash
# Stops the QA dev server and emulators started by qa/up.sh (by saved pid and by their ports).
cd "$(dirname "$0")/.."
for name in vite emulators; do
  pidfile="qa/.run/$name.pid"
  [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null
  rm -f "$pidfile"
done
for port in 5188 9150 8150 5150 4450 4550 9151; do
  pid=$(lsof -ti :"$port" 2>/dev/null | head -1)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
done
sleep 1
echo "QA environment stopped."
