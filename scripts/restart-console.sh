#!/usr/bin/env bash
# Restart the local console on :3100.
#
# Kills by port owner, not by a name pattern: `pkill -f next-server` also
# matches the shell running this script, which silently killed the build twice.
set -euo pipefail

PORT="${1:-3100}"
WEB_DIR="$(cd "$(dirname "$0")/../web" && pwd)"

owner="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$owner" ]; then
  kill "$owner" 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$owner" 2>/dev/null || break
    sleep 1
  done
fi

cd "$WEB_DIR"
nohup bun run start -p "$PORT" >/tmp/bp-ui.log 2>&1 &

for _ in $(seq 1 40); do
  if curl -sf -m 3 -o /dev/null "http://localhost:$PORT/login"; then
    echo "console up on :$PORT"
    exit 0
  fi
  sleep 2
done

echo "console did not come up; tail of log:" >&2
tail -20 /tmp/bp-ui.log >&2
exit 1
