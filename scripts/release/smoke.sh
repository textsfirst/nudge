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

cleanup() {
  if [[ -n "$console_pid" ]]; then
    kill "$console_pid" 2>/dev/null || true
    wait "$console_pid" 2>/dev/null || true
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
"$launcher" version
"$launcher" help >/dev/null

release_path="$bundle/runtime/bin:$bundle/app/apps/server/bin:${PATH:-/usr/bin:/bin}"
PATH="$release_path" "$bundle/app/apps/server/bin/mcp" --help >/dev/null
PATH="$release_path" "$bundle/app/apps/server/bin/skills" --help >/dev/null

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
  sed -n '1,200p' "$console_log" >&2
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

kill "$console_pid"
wait "$console_pid"
console_pid=""

echo "Release smoke test passed: $(basename "$archive")"
