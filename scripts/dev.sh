#!/usr/bin/env bash
# Bring up the local stack with hot reload: runtime on :8787, console on :3000.
#
# Both halves watch their own sources, so editing anything under runtime/ or
# web/ is picked up without touching this script again.
#
# Stops whatever currently holds those ports first — by port owner, not by a
# name pattern, because `pkill -f next` also matches the shell running it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Both halves read their configuration from the one .env at the root. Bun only
# picks up a .env from the directory it starts in, and the runtime starts in
# runtime/, so it is loaded here and inherited by both.
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
else
  echo "No $ROOT/.env — copy .env.example and fill it in first." >&2
  exit 1
fi

RUNTIME_PORT="${BP_PORT:-8787}"
WEB_PORT="${WEB_PORT:-3000}"

free_port() {
  local port="$1"
  local owner
  owner="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  [ -z "$owner" ] && return 0

  echo "stopping pid $owner on :$port"
  kill "$owner" 2>/dev/null || true
  for _ in $(seq 1 15); do
    kill -0 "$owner" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$owner" 2>/dev/null || true
}

wait_for() {
  local url="$1" name="$2"
  for _ in $(seq 1 60); do
    curl -sf -m 3 -o /dev/null "$url" && { echo "$name ready at $url"; return 0; }
    sleep 2
  done
  echo "$name did not come up; see the log" >&2
  return 1
}

free_port "$RUNTIME_PORT"
free_port "$WEB_PORT"

# Leftover runtimes from earlier runs hold browsers and database connections
# without owning a port, so they are invisible to the check above.
for pid in $(pgrep -f "src/server.ts" 2>/dev/null || true); do
  [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$ROOT/runtime" ] || continue
  kill "$pid" 2>/dev/null || true
done

cd "$ROOT/runtime"
nohup bun --watch run src/server.ts >/tmp/bp-runtime-dev.log 2>&1 &
cd "$ROOT/web"
nohup bun run dev --port "$WEB_PORT" >/tmp/bp-web-dev.log 2>&1 &

wait_for "http://localhost:$RUNTIME_PORT/health" "runtime" || tail -20 /tmp/bp-runtime-dev.log >&2
wait_for "http://localhost:$WEB_PORT/login" "console" || tail -20 /tmp/bp-web-dev.log >&2

echo
echo "console  http://localhost:$WEB_PORT"
echo "runtime  http://localhost:$RUNTIME_PORT"
echo "logs     /tmp/bp-web-dev.log  /tmp/bp-runtime-dev.log"
