#!/usr/bin/env bash

# Worktree setup for Paseo (referenced from paseo.json as worktree.setup).
#
# Copying .env, snapshotting .data's SQLite database consistently, and
# installing dependencies already live in scripts/t3-setup.sh, which reads
# T3CODE_* paths. Translate Paseo's equivalents and hand off, then copy the
# extra untracked files that .worktreeinclude covers for T3 Code.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source_checkout="$(cd "${PASEO_SOURCE_CHECKOUT_PATH:-$PWD}" && pwd -P)"
worktree="$(cd "${PASEO_WORKTREE_PATH:-$PWD}" && pwd -P)"

T3CODE_PROJECT_ROOT="$source_checkout" \
  T3CODE_WORKTREE_PATH="$worktree" \
  bash "$script_dir/t3-setup.sh"

if [[ "$source_checkout" != "$worktree" ]]; then
  if [[ -f "$source_checkout/nudge.config.yaml" && ! -e "$worktree/nudge.config.yaml" ]]; then
    cp -p "$source_checkout/nudge.config.yaml" "$worktree/nudge.config.yaml"
    echo "Copied nudge.config.yaml from the main checkout."
  fi
fi
