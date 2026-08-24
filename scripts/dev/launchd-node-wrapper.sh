#!/bin/bash
# launchd boot wrapper for the OmniRoute headless daemon.
#
# Why this exists: the LaunchAgent previously pinned an absolute Homebrew
# Cellar node path (e.g. /opt/homebrew/Cellar/node/26.4.0/bin/node). When brew
# upgraded node or a linked dylib (ada-url), the pinned binary stopped loading
# and the daemon crash-looped at every power-on until a human intervened.
#
# This wrapper resolves the first node binary that actually runs, in order:
#   1. /opt/homebrew/opt/node/bin/node   (version-independent opt symlink)
#   2. newest runnable /opt/homebrew/Cellar/node/*/bin/node
#   3. newest runnable fnm-installed node
# It then execs scripts/dev/run-headless.mjs with the production V8 flags.
set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

NODE_BIN=""
# Iterate newest-first over Cellar + fnm installs; safe against spaces in paths.
for candidate in "/opt/homebrew/opt/node/bin/node"     $(ls -t /opt/homebrew/Cellar/node/*/bin/node 2>/dev/null | while IFS= read -r f; do printf '%q ' "$f"; done)     $(ls -t "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | while IFS= read -r f; do printf '%q ' "$f"; done); do
  eval "cand=$candidate"
  if [ -x "$cand" ] && "$cand" --version >/dev/null 2>&1; then
    NODE_BIN="$cand"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  echo "[launchd-wrapper] FATAL: no runnable node binary found" >&2
  exit 1
fi

echo "[launchd-wrapper] $(date '+%Y-%m-%dT%H:%M:%S') using node: $NODE_BIN $("$NODE_BIN" --version)"

exec "$NODE_BIN" \
  --expose-gc \
  --max-old-space-size=2048 \
  --max-semi-space-size=32 \
  "$REPO_DIR/scripts/dev/run-headless.mjs"
