#!/usr/bin/env bash

set -euo pipefail

archive="${1:-}"
if [[ -z "$archive" || ! -f "$archive" ]]; then
  echo "Usage: bash scripts/release/smoke.sh <release.tar.gz>" >&2
  exit 2
fi
archive="$(cd "$(dirname "$archive")" && pwd -P)/$(basename "$archive")"

smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/nudge-smoke.XXXXXX")"
console_pid=""

# Wait up to 15 seconds for a process to exit; returns 1 if it is still alive.
wait_for_exit() {
  local pid="$1"
  for _ in {1..60}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return 0
    fi
    sleep 0.25
  done
  return 1
}

cleanup() {
  local status=$?
  if [[ -n "$console_pid" ]]; then
    kill "$console_pid" 2>/dev/null || true
    if ! wait_for_exit "$console_pid"; then
      kill -9 "$console_pid" 2>/dev/null || true
      wait "$console_pid" 2>/dev/null || true
    fi
  fi
  if [[ "$status" -ne 0 && -s "${console_log:-}" ]]; then
    echo "Console log (${console_log}):" >&2
    sed -n '1,200p' "$console_log" >&2
  fi
  if [[ -d "$smoke_root" && "$smoke_root" == *"/nudge-smoke."* ]]; then
    rm -rf -- "$smoke_root"
  fi
}
trap cleanup EXIT

tar -xzf "$archive" -C "$smoke_root"
bundle="$(find "$smoke_root" -mindepth 1 -maxdepth 1 -type d -name 'nudge-*' -print -quit)"
if [[ -z "$bundle" ]]; then
  echo "The archive does not contain a nudge-* release directory." >&2
  exit 1
fi

launcher="$bundle/bin/nudge"
node="$bundle/runtime/bin/node"
expected_version="$(sed -n '1p' "$bundle/VERSION")"
version_output="$("$launcher" version)"
echo "$version_output"
if [[ "$version_output" != *"Nudge $expected_version "* ]]; then
  echo "The launcher reported the wrong version (expected $expected_version)." >&2
  exit 1
fi
"$launcher" help >/dev/null

# Exercise the update check against a local stand-in for the release assets.
update_base="$smoke_root/update-base"
mkdir -p "$update_base"
printf '%s\n' "$expected_version" > "$update_base/VERSION"
check_output="$(NUDGE_UPDATE_BASE_URL="file://$update_base" "$launcher" update --check)"
if [[ "$check_output" != *"Up to date."* ]]; then
  echo "nudge update --check did not report up to date against a matching VERSION." >&2
  echo "$check_output" >&2
  exit 1
fi
printf '%s\n' "9999.0.0-edge.1" > "$update_base/VERSION"
check_output="$(NUDGE_UPDATE_BASE_URL="file://$update_base" "$launcher" update --check)"
if [[ "$check_output" != *"Update available."* ]]; then
  echo "nudge update --check did not detect a newer version." >&2
  echo "$check_output" >&2
  exit 1
fi

# Run these through the launcher's own PATH export so a regression there fails here.
"$launcher" exec mcp --help >/dev/null
"$launcher" exec skills --help >/dev/null

instance="$smoke_root/instance"
smoke_home="$instance/home"
data_dir="$smoke_home/.config/nudge"
mkdir -p "$instance/bin" "$smoke_home"
ln -s "$launcher" "$instance/bin/nudge"
"$instance/bin/nudge" version >/dev/null

set +e
server_output="$(
  cd "$instance"
  env -u NUDGE_DATA_DIR HOME="$smoke_home" XDG_CONFIG_HOME= "$launcher" run 2>&1
)"
server_status=$?
set -e
if [[
  "$server_status" -eq 0 ||
  "$server_output" != *"Nudge needs"* ||
  "$server_output" != *"nudge console"* ||
  "$server_output" != *"http://localhost:3100"*
]]; then
  echo "The packaged server did not reach its expected first-run validation." >&2
  echo "$server_output" >&2
  exit 1
fi

port="$("$node" -e '
  const server = require("node:net").createServer();
  server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
    server.close();
  });
')"
console_log="$smoke_root/console.log"
(
  cd "$instance"
  exec env -u NUDGE_DATA_DIR HOME="$smoke_home" XDG_CONFIG_HOME= \
    CONSOLE_HOST=127.0.0.1 CONSOLE_PORT="$port" \
    "$launcher" console
) >"$console_log" 2>&1 &
console_pid=$!

ready=false
for _ in {1..80}; do
  if "$node" -e '
    fetch(process.argv[1])
      .then(async (response) => {
        const body = await response.text();
        if (!response.ok || !body.includes("<title>Nudge Console</title>")) process.exit(1);
      })
      .catch(() => process.exit(1));
  ' "http://127.0.0.1:$port/"; then
    ready=true
    break
  fi
  sleep 0.25
done

if [[ "$ready" != true ]]; then
  echo "The packaged console did not become ready." >&2
  exit 1
fi

(
  cd "$instance"
  env -u NUDGE_DATA_DIR HOME="$smoke_home" XDG_CONFIG_HOME= "$launcher" auth show >/dev/null
)

if [[ ! -f "$data_dir/nudge.db" || ! -f "$data_dir/console-auth.json" ]]; then
  echo "The packaged commands did not use the default ~/.config/nudge data directory." >&2
  exit 1
fi

kill "$console_pid" 2>/dev/null || true
if ! wait_for_exit "$console_pid"; then
  kill -9 "$console_pid" 2>/dev/null || true
  wait "$console_pid" 2>/dev/null || true
  console_pid=""
  echo "The packaged console did not exit on SIGTERM within 15 seconds." >&2
  exit 1
fi
console_pid=""

echo "Release smoke test passed: $(basename "$archive")"
