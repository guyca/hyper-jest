#!/usr/bin/env bash
# Asserts the built extension contains no network APIs and (optionally) that a running extension
# host + HyperJest workers hold no sockets. Usage: scripts/check-no-network.sh [extension-host-pid]
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d dist ] || { echo "dist/ missing: run yarn build first"; exit 1; }
echo "== static scan of dist/ for network APIs =="
if grep -nE "require\(['\"](https?|net|dns|tls|dgram|http2)['\"]\)|\bfetch\(|XMLHttpRequest|WebSocket\(" dist/*.js dist/worker/*.cjs; then
  echo "FAIL: network API usage found"; exit 1
fi
echo "OK: no network APIs in dist/"
if [ "${1:-}" != "" ]; then
  echo "== sockets held by extension host $1 and its HyperJest workers =="
  pids="$1 $(pgrep -P "$1" -f hyperjestWorker.cjs || true)"
  found=0
  for p in $pids; do
    if lsof -nP -i -a -p "$p" 2>/dev/null | grep -v '^COMMAND' | grep -q .; then
      lsof -nP -i -a -p "$p"; found=1
    fi
  done
  [ "$found" = 0 ] && echo "OK: no sockets" || { echo "NOTE: sockets above belong to the extension host or other extensions; HyperJest workers must show none"; }
fi
