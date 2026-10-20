#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-/opt/homebrew/bin/node}"
if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node)"
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "node not found" >&2
  exit 1
fi

LAUNCH="$HOME/Library/LaunchAgents"
LOGDIR="$ROOT/logs"
mkdir -p "$LAUNCH" "$LOGDIR"

install_plist() {
  local label="$1"
  local dest="$LAUNCH/$label.plist"
  cat > "$dest"
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$dest"
  echo "loaded $label"
}

install_plist "com.tdengine.aio-smoketest.daily" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tdengine.aio-smoketest.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/cli.js</string>
    <string>daily</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>7</integer>
    <key>Minute</key>
    <integer>0</integer>
    <key>TimeZone</key>
    <string>America/Los_Angeles</string>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>TZ</key>
    <string>America/Los_Angeles</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOGDIR/daily.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGDIR/daily.log</string>
</dict>
</plist>
EOF

install_plist "com.tdengine.aio-smoketest.watch" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tdengine.aio-smoketest.watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/cli.js</string>
    <string>watch</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>TZ</key>
    <string>America/Los_Angeles</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOGDIR/watch.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGDIR/watch.log</string>
</dict>
</plist>
EOF

echo "Daily brief: 7:00 AM America/Los_Angeles"
echo "New-release watch: every 15 minutes"
echo "Logs: $LOGDIR"
