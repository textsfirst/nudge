#!/usr/bin/env bash

set -euo pipefail

project_root="${T3CODE_PROJECT_ROOT:-}"
worktree_root="${T3CODE_WORKTREE_PATH:-$PWD}"

if [[ -z "$project_root" ]]; then
  echo "T3CODE_PROJECT_ROOT is not set. Run this script through T3 Code." >&2
  exit 1
fi

project_root="$(cd "$project_root" && pwd -P)"
worktree_root="$(cd "$worktree_root" && pwd -P)"

if [[ "$project_root" != "$worktree_root" ]]; then
  if [[ -f "$project_root/.env" && ! -e "$worktree_root/.env" ]]; then
    cp -p "$project_root/.env" "$worktree_root/.env"
    chmod 600 "$worktree_root/.env"
    echo "Copied .env from the main checkout."
  elif [[ ! -e "$worktree_root/.env" && -f "$worktree_root/.env.example" ]]; then
    cp -p "$worktree_root/.env.example" "$worktree_root/.env"
    chmod 600 "$worktree_root/.env"
    echo "Created .env from .env.example."
  fi

  # Pin the worktree to its own .data snapshot. Without this the default data
  # dir resolves to the shared $XDG_CONFIG_HOME/nudge, and every worktree (and
  # a copied absolute NUDGE_DATA_DIR) would open the main install's live state.
  if [[ ! -e "$worktree_root/.env" ]]; then
    touch "$worktree_root/.env"
    chmod 600 "$worktree_root/.env"
  fi
  if grep -q '^NUDGE_DATA_DIR=' "$worktree_root/.env"; then
    sed -i.t3bak 's|^NUDGE_DATA_DIR=.*|NUDGE_DATA_DIR=.data|' "$worktree_root/.env"
    rm -f "$worktree_root/.env.t3bak"
  else
    printf '\nNUDGE_DATA_DIR=.data\n' >> "$worktree_root/.env"
  fi

  # Snapshot from wherever the main checkout actually keeps its data: an
  # explicit NUDGE_DATA_DIR in its .env, else the XDG default.
  main_data_dir=""
  if [[ -f "$project_root/.env" ]]; then
    main_data_dir="$(sed -n 's/^NUDGE_DATA_DIR=//p' "$project_root/.env" | tail -n 1)"
    main_data_dir="${main_data_dir%%#*}"
    main_data_dir="${main_data_dir%"${main_data_dir##*[![:space:]]}"}"
    main_data_dir="${main_data_dir#\"}"
    main_data_dir="${main_data_dir%\"}"
  fi
  if [[ -z "$main_data_dir" ]]; then
    main_data_dir="${XDG_CONFIG_HOME:-$HOME/.config}/nudge"
  elif [[ "$main_data_dir" != /* ]]; then
    main_data_dir="$project_root/$main_data_dir"
  fi

  source_data="$main_data_dir"
  target_data="$worktree_root/.data"

  if [[ -d "$source_data" && ! -e "$target_data" ]]; then
    staging_root="$(mktemp -d "$worktree_root/.t3-setup.XXXXXX")"
    staging_data="$staging_root/.data"

    cleanup_staging_data() {
      if [[ -e "$staging_root" ]]; then
        rm -rf -- "$staging_root"
      fi
    }
    trap cleanup_staging_data EXIT

    NUDGE_SETUP_SOURCE_DATA="$source_data" \
      NUDGE_SETUP_STAGING_DATA="$staging_data" \
      node --input-type=module <<'NODE'
import { cp, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const source = resolve(process.env.NUDGE_SETUP_SOURCE_DATA);
const destination = resolve(process.env.NUDGE_SETUP_STAGING_DATA);
const sqliteFiles = new Set([
  "nudge.db",
  "nudge.db-journal",
  "nudge.db-shm",
  "nudge.db-wal",
  "console-auth.json",
]);

await cp(source, destination, {
  recursive: true,
  preserveTimestamps: true,
  filter(path) {
    const pathFromDataRoot = relative(source, path);
    return !sqliteFiles.has(pathFromDataRoot);
  },
});

const sourceDatabase = resolve(source, "nudge.db");
const targetDatabase = resolve(destination, "nudge.db");

try {
  const info = await stat(sourceDatabase);
  if (info.isFile()) {
    const database = new DatabaseSync(sourceDatabase, { readOnly: true });
    try {
      await backup(database, targetDatabase);
    } finally {
      database.close();
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
NODE

    mv "$staging_data" "$target_data"
    rmdir "$staging_root"
    trap - EXIT
    chmod -R go-rwx "$target_data"
    echo "Copied .data with a consistent SQLite snapshot."
  elif [[ -e "$target_data" ]]; then
    echo "Kept the worktree's existing .data directory."
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
elif command -v corepack >/dev/null 2>&1; then
  corepack pnpm install --frozen-lockfile
else
  echo "pnpm 10 is required. Install pnpm or enable Corepack, then rerun setup." >&2
  exit 1
fi
