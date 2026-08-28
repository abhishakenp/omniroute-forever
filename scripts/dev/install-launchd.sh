#!/bin/bash
# install-launchd.sh — install/update the OmniRoute launchd service.
#
# Run this after `git pull` to ensure launchd starts the Bun headless server
# instead of the old Node server.
#
# Usage:
#   ./scripts/dev/install-launchd.sh          # install + load
#   ./scripts/dev/install-launchd.sh --unload # unload + remove
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_SRC="$REPO_DIR/scripts/dev/com.abhi.omniroute.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.abhi.omniroute.plist"
LABEL="com.abhi.omniroute"

# Unload existing service if running
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  echo "[install-launchd] Unloading existing $LABEL..."
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

if [ "${1:-}" = "--unload" ]; then
  echo "[install-launchd] Service unloaded. To re-install, run this script without --unload."
  exit 0
fi

# Generate plist with correct paths
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_DST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${REPO_DIR}/scripts/dev/launchd-bun-wrapper.sh</string>
    </array>
    <key>WorkingDirectory</key><string>${REPO_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PORT</key><string>20128</string>
      <key>NODE_ENV</key><string>production</string>
      <key>DATA_DIR</key><string>${HOME}/.omniroute</string>
      <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.bun/bin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>ProcessType</key><string>Background</string>
    <key>StandardOutPath</key><string>${HOME}/.omniroute/logs/omniroute.log</string>
    <key>StandardErrorPath</key><string>${HOME}/.omniroute/logs/omniroute.log</string>
</dict>
</plist>
PLIST

# Ensure log directory exists
mkdir -p "$HOME/.omniroute/logs"

# Load the service
echo "[install-launchd] Loading $LABEL..."
launchctl load "$PLIST_DST"
echo "[install-launchd] Done. Service will auto-start on boot and restart on crash."
echo "[install-launchd] Logs: tail -f ~/.omniroute/logs/omniroute.log"
echo "[install-launchd] Health: curl http://localhost:20128/health"
