#!/bin/bash
# launchd boot wrapper for the OmniRoute headless daemon (Bun runtime).
#
# Replaces launchd-node-wrapper.sh. Bun is the preferred headless runtime:
#   - 154MB RSS vs Node's 883MB (5.7x reduction)
#   - Native Web API Request/Response (no node:http conversion)
#   - Native bun:sqlite (no better-sqlite3 native build)
#   - Same route handlers as Next.js (auto-discovered from src/app/api/)
#
# This wrapper resolves the first bun binary that actually runs, in order:
#   1. ~/.bun/bin/bun           (official installer)
#   2. /opt/homebrew/bin/bun     (Homebrew)
#   3. bun in PATH               (any other location)
# Falls back to Node (run-headless.mjs) if Bun is not installed.
set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

# ── Resolve Bun binary ──────────────────────────────────────────────────────
BUN_BIN=""
for candidate in "$HOME/.bun/bin/bun" "/opt/homebrew/bin/bun" "$(command -v bun 2>/dev/null)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
    BUN_BIN="$candidate"
    break
  fi
done

if [ -n "$BUN_BIN" ]; then
  echo "[launchd-wrapper] $(date '+%Y-%m-%dT%H:%M:%S') using bun: $BUN_BIN $("$BUN_BIN" --version)"
  exec "$BUN_BIN" "$REPO_DIR/src/server/headless/server-bun.ts"
fi

# ── Fallback: Node.js headless server ───────────────────────────────────────
# If Bun is not installed, fall back to the Node.js headless server.
# This preserves backward compatibility for machines without Bun.
echo "[launchd-wrapper] Bun not found — falling back to Node.js headless server" >&2

NODE_BIN=""
for candidate in "/opt/homebrew/opt/node/bin/node" \
  $(ls -t /opt/homebrew/Cellar/node/*/bin/node 2>/dev/null | while IFS= read -r f; do printf '%q ' "$f"; done) \
  $(ls -t "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | while IFS= read -r f; do printf '%q ' "$f"; done); do
  eval "cand=$candidate"
  if [ -x "$cand" ] && "$cand" --version >/dev/null 2>&1; then
    NODE_BIN="$cand"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo "[launchd-wrapper] FATAL: no runnable bun or node binary found" >&2
  exit 1
fi

echo "[launchd-wrapper] $(date '+%Y-%m-%dT%H:%M:%S') using node fallback: $NODE_BIN $("$NODE_BIN" --version)"

exec "$NODE_BIN" \
  --expose-gc \
  --max-old-space-size=2048 \
  --max-semi-space-size=32 \
  "$REPO_DIR/scripts/dev/run-headless.mjs"
