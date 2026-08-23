#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"
version="${1:-edge}"
output_arg="${2:-$repo_root/release}"

if [[ ! "$version" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*$ ]]; then
  echo "Release version may contain only letters, numbers, dots, underscores, plus signs, and hyphens." >&2
  exit 2
fi

case "${NUDGE_RELEASE_PLATFORM:-$(node -p 'process.platform')}" in
  linux) platform="linux" ;;
  darwin) platform="macos" ;;
  *)
    echo "Release packaging supports Linux and macOS." >&2
    exit 2
    ;;
esac

case "${NUDGE_RELEASE_ARCH:-$(node -p 'process.arch')}" in
  x64) arch="x64" ;;
  arm64) arch="arm64" ;;
  *)
    echo "Release packaging supports x64 and arm64." >&2
    exit 2
    ;;
esac

required_builds=(
  "apps/server/dist/index.js"
  "apps/console/dist/server/index.js"
  "apps/console/dist/public/index.html"
  "packages/agent/dist/index.js"
  "packages/photon/dist/index.js"
  "packages/schedule/dist/index.js"
  "packages/store/dist/index.js"
)
for required in "${required_builds[@]}"; do
  if [[ ! -f "$repo_root/$required" ]]; then
    echo "Missing $required. Run pnpm build before packaging." >&2
    exit 1
  fi
done

mkdir -p "$output_arg"
output_dir="$(cd "$output_arg" && pwd -P)"
staging_parent="$(mktemp -d "${TMPDIR:-/tmp}/nudge-release.XXXXXX")"

cleanup() {
  if [[ -n "${staging_parent:-}" && -d "$staging_parent" && "$staging_parent" == *"/nudge-release."* ]]; then
    rm -rf -- "$staging_parent"
  fi
}
trap cleanup EXIT

artifact="nudge-$version-$platform-$arch"
bundle="$staging_parent/$artifact"
app="$bundle/app"
mkdir -p "$app/apps/server" "$app/apps/console" "$app/packages" "$bundle/bin" "$bundle/runtime/bin" "$bundle/licenses"

cp "$repo_root/package.json" "$repo_root/pnpm-lock.yaml" "$repo_root/pnpm-workspace.yaml" "$app/"

for package_dir in apps/server apps/console packages/agent packages/photon packages/schedule packages/store; do
  destination="$app/$package_dir"
  mkdir -p "$destination"
  cp "$repo_root/$package_dir/package.json" "$destination/"
  cp -R "$repo_root/$package_dir/dist" "$destination/dist"
done

cp -R "$repo_root/apps/server/bin" "$app/apps/server/bin"
cp -R "$repo_root/packages/agent/content" "$app/packages/agent/content"

(
  cd "$app"
  pnpm install --prod --frozen-lockfile --ignore-scripts
)

node_binary="$(node -p "require('node:fs').realpathSync(process.execPath)")"
node_root="$(cd "$(dirname "$node_binary")/.." && pwd -P)"
cp "$node_binary" "$bundle/runtime/bin/node"
chmod 755 "$bundle/runtime/bin/node"

node_license=""
for candidate in "$node_root/LICENSE" "$node_root/LICENSE.txt" /usr/share/doc/nodejs/copyright; do
  if [[ -f "$candidate" ]]; then
    node_license="$candidate"
    break
  fi
done
if [[ -z "$node_license" ]]; then
  echo "Could not find the bundled Node runtime's license file." >&2
  exit 1
fi
cp "$node_license" "$bundle/licenses/Node.js-LICENSE"

cp "$repo_root/LICENSE" "$bundle/LICENSE"
cp "$repo_root/.env.example" "$bundle/.env.example"
cp "$repo_root/README.md" "$bundle/PROJECT-README.md"
cp "$script_dir/RELEASE-README.md" "$bundle/README.md"
cp "$script_dir/nudge" "$bundle/bin/nudge"
chmod 755 "$bundle/bin/nudge" "$app/apps/server/bin/"*

commit="${NUDGE_RELEASE_COMMIT:-$(git -C "$repo_root" rev-parse HEAD)}"
printf '%s\n' "$version" > "$bundle/VERSION"
printf '%s\n' "$commit" > "$bundle/COMMIT"

NUDGE_METADATA_VERSION="$version" \
NUDGE_METADATA_COMMIT="$commit" \
NUDGE_METADATA_PLATFORM="$platform" \
NUDGE_METADATA_ARCH="$arch" \
NUDGE_METADATA_NODE="$("$bundle/runtime/bin/node" --version)" \
  "$bundle/runtime/bin/node" -e '
    const { writeFileSync } = require("node:fs");
    const metadata = {
      channel: "edge",
      version: process.env.NUDGE_METADATA_VERSION,
      commit: process.env.NUDGE_METADATA_COMMIT,
      platform: process.env.NUDGE_METADATA_PLATFORM,
      arch: process.env.NUDGE_METADATA_ARCH,
      node: process.env.NUDGE_METADATA_NODE,
    };
    writeFileSync(process.argv[1], `${JSON.stringify(metadata, null, 2)}\n`);
  ' "$bundle/BUILD.json"

raw_licenses="$staging_parent/third-party-licenses.json"
(
  cd "$app"
  pnpm licenses list --prod --json > "$raw_licenses"
)
"$bundle/runtime/bin/node" -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
  for (const packages of Object.values(report)) {
    for (const packageInfo of packages) delete packageInfo.paths;
  }
  writeFileSync(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
' "$raw_licenses" "$bundle/THIRD-PARTY-LICENSES.json"

archive="$output_dir/$artifact.tar.gz"
temporary_archive="$staging_parent/$artifact.tar.gz"
(
  cd "$staging_parent"
  COPYFILE_DISABLE=1 tar -czf "$temporary_archive" "$artifact"
)
mv -f "$temporary_archive" "$archive"

echo "$archive"
