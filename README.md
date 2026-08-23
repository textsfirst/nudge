# Nudge

Nudge is an open, highly opinionated personal agent that lives in iMessage. You run your own instance: the owner texts a Photon Cloud number; an LLM agent replies, remembers, searches its own history, maintains skills, and — through a markdown-defined schedule — texts first.

There is deliberately no command system. Threads roll over silently (at local midnight and after idle gaps) with an LLM-written carryover summary, long threads compact instead of truncating, and "start over" or "remind me every morning" are just things you say in conversation.

## Architecture

The pnpm workspace keeps the replaceable boundaries small:

- `apps/server` — configuration, HTTP lifecycle, SYSTEM.md loading, the scheduler, ledger-backed outbound delivery, Google account plumbing for the gws CLI, and the daily connection health check
- `apps/console` — the local web console (Elysia + React): threads manager, markdown/config editors, secrets, and all connection setup (Google accounts, ChatGPT and Grok sign-in)
- `packages/agent` — the tool-calling agent loop (Vercel AI SDK), prompt stack, thread lifecycle (rollover/compaction/carryover), the file workspace with per-path validators, and model providers
- `packages/photon` — the streaming inbound connection, owner filtering, burst debouncing, typing indicators, message chunking, and proactive sends via persisted space ids
- `packages/store` — SQLite (`node:sqlite`) persistence: threads, messages with FTS5 search, spaces, schedule state, memory, the outbound ledger, and inbound dedupe
- `packages/schedule` — the deterministic SCHEDULE.md parser and timing engine (croner)

### Files are the API

The agent's world is a real filesystem on a real box, deliberately. Models are RL-trained on exactly this loop — list, read, grep, edit, run — so a directory of plain files is the interface their competence transfers to, not a compromise. This is a hard boundary for the design: anything else the system needs (persistence, sync, backups) sits behind the filesystem, invisible to the model, and never replaces it as the agent's interface.

The core tools are file operations scoped to `data_dir`: `list_files`, `read_file` (paged — long files return a `Use offset=N to continue` footer), `edit_file` (exact-match in-place edits), and `write_file` (whole-file replace) — the latter two share per-file validation. Genuine computation comes from `search_history` (FTS5), `bash` (runs with `data_dir` as its working directory — a default, not a sandbox; disable with `tools.bash_enabled: false`), and optional `web_search`/`web_extract` (Firecrawl). Everything else — schedule, memory, skills — is a markdown file convention documented in a system-written `data_dir/README.md` that the agent reads on demand. New capabilities cost a convention, not a tool schema in every prompt. Control signals are in-band tokens: `[SILENT]` (don't reply) and `[NEW_THREAD]` (reset the thread).

Writes are validated per path and rejected with diagnostics the model can act on: SCHEDULE.md must parse, MEMORY.md/USER.md have hard character budgets, `skills/*/SKILL.md` needs frontmatter, and SYSTEM.md plus the README are read-only to the agent. Secrets (`chatgpt-auth.json`, `grok-auth.json`) and runtime state (`nudge.db`) are invisible to it.

### The prompt stack

Every turn's system prompt is assembled from five slots, stable content first so prompt-prefix caching survives: **SYSTEM.md** (yours) → generated tool guidance → memory snapshot → skills list → current local time. It is frozen per thread and re-read only at rollover.

### Files you own (in `data_dir`, default `$XDG_CONFIG_HOME/nudge` or `~/.config/nudge`)

- **SYSTEM.md** — the entire base system prompt: who Nudge is, voice, rules. The agent reads it and never writes it. Missing file → a built-in default.
- **SCHEDULE.md** — every proactive message, one `##` section per entry:

  ```markdown
  ## Morning briefing
  when: weekdays at 7:30
  Summarize anything I asked you to track. Keep it short.

  ## Passport
  when: 2026-09-01 09:00 once
  Remind me to renew my passport.
  ```

  The `when:` grammar is parsed by code, never interpreted by the model at runtime: `every day at 7:30`, `weekdays at 7:30`, `weekends at 9:00`, `every monday at 18:00`, `every 2 hours`, `every 30 minutes`, `YYYY-MM-DD HH:MM once`, or `cron: 30 7 * * 1-5`. Times are `timezone` local. Entry names are unique persistent identities, so editing a completed one-shot does not re-arm it; rename it to create a new entry. The agent edits this file itself when you ask for reminders; you can also hand-edit it — parse problems get texted to you rather than silently ignored.
- **MEMORY.md and USER.md** — the agent's bounded curated memory (2,200 / 1,375 character budgets): notes to self and facts about you. Injected into every prompt; over-budget writes are rejected so the agent consolidates instead of hoarding.
- **skills/** — the agent's procedural memory: `skills/<name>/SKILL.md` with agentskills.io-style frontmatter plus optional support files. The agent creates and improves these autonomously after solving hard problems; everything is plain markdown you can audit, edit, or delete.
- **README.md** — system-written manual documenting all of the above formats for the agent (and for you).

### Reliability

- Inbound texts arrive over a persistent streaming connection that reconnects forever with backoff and replays events missed during a disconnect; deliveries are at-least-once and deduplicated durably. Near-simultaneous texts are coalesced (~250 ms), while later texts steer the active reply. A typing indicator shows from the first text. One caveat: the replay cursor lives in memory, so a text sent while the server process itself is down is not recovered on startup — the sender sees no read receipt or reply and can re-send.
- A text arriving while a reply is still being generated steers it: the in-flight model call aborts, everything sent while busy folds into one follow-up turn (full history included), and no stale reply goes out. If the aborted turn had already run tools, a note recording those calls lands in history so the next turn doesn't redo them.
- Every outbound message is journaled in a ledger before sending, with per-bubble delivery progress. On restart, sends that never started go out as-is; ones interrupted mid-send resume from the first unconfirmed bubble behind a conversational notice ("not sure that went through, so again:" / "got cut off mid-text - here's the rest:"), bounded to 3 attempts within 24 hours.
- Scheduled entries claim crash-safely and never back-fill occurrences from before they existed; a one-shot that came due while the server was down fires late, once.
- SQLite upgrades run as ordered transactional migrations, including a one-time FTS rebuild for pre-versioned databases. Inbound dedupe and terminal delivery records are pruned on a bounded schedule; conversation history remains owner-controlled in the console.

## Requirements

- A Photon Cloud project and iMessage line
- Either a ChatGPT or Grok subscription (authorized from the console's Connections page), or an OpenAI API key
- Optional: the [`gws` CLI](https://github.com/googleworkspace/cli) plus a Google Cloud OAuth client for Google account access (see "Google accounts")
- Source installs also need Node.js 22.5+ and pnpm 10. Edge archives include a pinned Node runtime.

No public URL or tunnel is needed: inbound messages arrive over an outbound streaming connection to Photon Cloud.

## Edge release

Every push to `main` replaces the rolling [Edge release](https://github.com/textsfirst/nudge/releases/tag/edge). It contains compiled server code, the production console, production dependencies, and a pinned Node runtime. Archives are published for Linux x64, Linux arm64, and macOS arm64. Edge builds are versioned `<base>-edge.<N>` (for example `0.1.0-edge.42`, where `N` is the CI run number); each archive's `BUILD.json` records the version and its exact source commit.

Download and extract the archive for your machine, then create the configuration directory:

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/nudge"
cd "${XDG_CONFIG_HOME:-$HOME/.config}/nudge"
cp /path/to/extracted-nudge/.env.example .env
$EDITOR .env
/path/to/extracted-nudge/bin/nudge console
```

Open `http://localhost:3100` and finish setup. Run the agent server separately from the same directory:

```bash
cd "${XDG_CONFIG_HOME:-$HOME/.config}/nudge"
/path/to/extracted-nudge/bin/nudge run
```

To update, run `/path/to/extracted-nudge/bin/nudge update`: it downloads the latest Edge archive, verifies its checksum, and swaps the release directory in place. `bin/nudge update --check` reports whether a newer build exists without downloading anything. (Extracting the new archive yourself and pointing your service at its `bin/nudge` still works too.) The archive never contains runtime state, so updating does not touch your configuration or history.

## Setup

These steps install Nudge from source. Edge users can use the shorter process above.

1. Install dependencies and create local configuration:

   ```bash
   pnpm install
   cp .env.example .env
   ```

   Settings live in the SQLite database and are edited on the console's **Settings** page; `.env` holds only secrets plus the bootstrap values needed before the database can be opened (`NUDGE_DATA_DIR`, `PORT`, `LOG_LEVEL` — all optional, defaults shown in `.env.example`).

2. Put the credentials from the [Photon dashboard](https://app.photon.codes) in `.env`:

   ```dotenv
   SPECTRUM_PROJECT_ID=...
   SPECTRUM_PROJECT_SECRET=...
   ```

   and set your handle on the console's **Settings** page (`pnpm console`, then Settings → Owner handle). It must exactly match Photon's `message.sender.id`; the server refuses to start until it is set.

3. Start the console with `pnpm console`. On first run it prints a high-entropy access code; open `http://localhost:5174` and paste the code into the login page. For a subscription provider — the default `chatgpt-subscription`, or `grok-subscription` (SuperGrok, SuperGrok Heavy, or X Premium+) — open **Connections** and click Connect. There is deliberately no API-key fallback: when subscription auth breaks, Nudge tells you to reconnect instead of silently spending API credits.

   The access code is stored in `data_dir/console-auth.json` with owner-only permissions. Run `pnpm console:auth` to show it or `pnpm console:auth rotate` to replace it; restart a running console after rotation.

   To use an API key instead: set Provider to `openai-api` in console Settings plus `OPENAI_API_KEY` in `.env`.

   To use any other OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, LM Studio, a proxy): set Provider to `custom` in console Settings, fill in the custom base URL and model id, and — if the endpoint needs one — set `CUSTOM_API_KEY` in `.env`. Most compatible servers implement the Chat Completions API (the default); switch the API flavor to `responses` only when the endpoint supports it. For model ids the context-window registry does not recognize, set `agent.context_window_tokens` explicitly.

4. Optionally create `SYSTEM.md` and `SCHEDULE.md` in `data_dir`. Both work from the first boot without them.

5. Start everything:

   ```bash
   pnpm dev
   ```

   This runs the agent server (`:3000`) and the web console (API `:3100`, UI `:5174`) together, each with a labeled, color-coded output prefix; Ctrl+C stops all of them. Use `pnpm dev:agent` or `pnpm console` to run just one side.

   Inbound messages connect on their own — nothing to register or expose. Health check: `GET /healthz`.

Note: Nudge can only text you proactively after you have texted it at least once — it needs one inbound message to learn the conversation's space id.

## The console

A local web app for everything you'd otherwise SSH in for:

- **Threads** — browse every conversation, read messages (tool calls included), search all history, end the active thread, delete threads or single messages
- **Files** — edit SYSTEM.md, SCHEDULE.md (with a live parse preview and next-run times), memory files (with budget meters), and skills, all validated by the same rules the agent's writes go through
- **Connections** — all sign-in flows: ChatGPT subscription (device code) and Google accounts for the gws CLI (see below); live token status per account
- **Settings** — typed forms for every setting, validated by the same schema the server boots with
- **Secrets** — manage `.env` write-only; values are never sent to the browser

```bash
pnpm console                          # dev: API on :3100, UI on :5174
pnpm console:auth                     # show the access code
pnpm --filter @nudge/console build    # build the UI
pnpm console:start                    # rebuild, then serve API + UI on :3100
```

Google sign-in redirects back to the exact console address in your browser, so register that address (e.g. `http://localhost:3100/api/connections/google/callback` — and the `:5174` variant if you use the dev server) in your OAuth client; the wizard shows the exact string to copy.

The console binds to `127.0.0.1` by default and requires the generated access code. Mutations require CSRF proof and JSON request bodies. `CONSOLE_PORT` and a loopback `CONSOLE_HOST` override the local defaults. SSH port forwarding stays in local mode. Direct non-loopback exposure requires `CONSOLE_REMOTE=1` and should sit behind a TLS proxy. The console reads the same SQLite file as the server (WAL + busy timeout make the two processes safe together).

## Google accounts (gws)

Nudge can work the owner's Gmail, Calendar, Drive, Docs, Sheets, Contacts, and Tasks through the [Google Workspace CLI (`gws`)](https://github.com/googleworkspace/cli), driven over the existing bash tool — no extra tool schemas. Multiple accounts are first-class: each connected account (label like `personal` or `work`) gets its own credential store, and the agent picks one per command with `gws -a work gmail +triage`. A `google-workspace` skill is seeded on first connect; the prompt lists connected accounts.

Setup lives entirely on the console's **Connections** page:

1. **One-time Google Cloud app** — the wizard walks through creating a (free, private) Cloud project, publishing the OAuth consent screen to production (testing mode expires sign-ins after 7 days), enabling the APIs for the services you pick, and creating a **Web application** OAuth client with the redirect URI the wizard displays. Paste the client JSON and you never see this step again.
2. **Per account** — pick services and access (read-only or full per service), name the account, and sign in with Google. Consent runs in your browser wherever it is — the redirect returns to the console address, so it works through `ssh -L` or an HTTPS Tailscale/remote setup against a fully headless server (no browser or OS keyring needed there; this is also why Nudge drives the OAuth flow itself instead of `gws auth login`).

The `gws` binary itself must be installed on the machine running Nudge (`brew install googleworkspace-cli` or `npm i -g @googleworkspace/cli`; the gws binary setting for custom locations). Nudge's shim fronts it for the agent: it injects the chosen account's credentials per exec, refuses `gws auth` (connections are owner-managed), adds `gws accounts` for status, and turns auth failures into "tell the owner to reconnect" guidance.

A daily health check probes every connection (Google accounts and ChatGPT or Grok auth) and texts you once when one breaks — so an expired token doesn't surface as a silently failing morning briefing.

## Photon transport note

Inbound delivery is `spectrum.messages` from `spectrum-ts`: an outbound gRPC streaming connection to Photon Cloud that reconnects forever with jittered backoff and, after a disconnect, replays missed events from a sequence cursor before resuming live. The cursor is held in memory, so replay covers connection drops but not full process downtime. The supported cloud send path is `space.send(...)`; Nudge replies through the stream's rehydrated space and sends proactively by persisting each space id and rehydrating it later with `space.get(id)`. All Photon-specific code stays behind the transport interface in `packages/photon`.

## Configuration

Settings live in the SQLite database (`settings` table) and are edited on the console's **Settings** page; secrets live in `.env` (gitignored). Only values you change are stored — everything else follows the schema defaults, so new settings appear automatically after an upgrade. Settings are read at boot; restart the server to apply changes.

Settings (console → Settings):

| Key | Default | Purpose |
| --- | --- | --- |
| `owner_handle` | required | The one handle allowed to talk to Nudge |
| `timezone` | machine timezone | IANA zone for schedules and midnight rollover |
| `provider.selected` | `chatgpt-subscription` | `chatgpt-subscription`, `grok-subscription`, `openai-api`, or `custom` |
| `provider.chatgpt.model` | `gpt-5.6-sol` | Model slug for the ChatGPT subscription endpoint |
| `provider.chatgpt.auth_file` | `chatgpt-auth.json` | ChatGPT OAuth credential file, relative to `data_dir` |
| `provider.grok.model` | `grok-4.6` | Model slug for the Grok subscription (xAI's CLI proxy maps it to its `-build` variant) |
| `provider.grok.auth_file` | `grok-auth.json` | Grok OAuth credential file, relative to `data_dir` |
| `provider.grok.client_version` | built-in | CLI version header for xAI's proxy; set only when requests fail with HTTP 426 |
| `provider.openai.model` | `gpt-5.6-sol` | Standard API model |
| `provider.custom.base_url` | unset | Base URL of an OpenAI-compatible endpoint (e.g. `http://localhost:11434/v1`) |
| `provider.custom.model` | unset | Model id the custom endpoint expects |
| `provider.custom.api` | `chat-completions` | API flavor the endpoint implements: `chat-completions` or `responses` |
| `model.reasoning_effort` | `high` | `none` … `max` reasoning level |
| `model.fast_mode` | `false` | Priority service tier for faster output (openai-api only) |
| `tools.bash_enabled` | `true` | Set `false` to remove the bash tool |
| `tools.firecrawl_url` | Firecrawl cloud | Self-hosted Firecrawl endpoint (enables the web tools without a key) |
| `google.default_account` | sole account | Account label `gws` uses when the agent omits `-a` |
| `google.gws_path` | PATH lookup | Explicit path to the `gws` binary |
| `threads.idle_hours` | `6` | Idle gap before a thread rolls over |
| `threads.debounce_ms` | `250` | Near-simultaneous delivery coalescing window before replying; `0` starts immediately |
| `texting.read_receipts` | `true` | Mark the owner's texts read a jittered moment after they arrive |
| `texting.typing_delay_ms` | `1100` | Jittered pause before the typing indicator appears; `0` shows it instantly |
| `texting.chunk_delay_ms` | `500` | Base pause between reply bubbles, growing with the next bubble's length; `0` disables pacing |
| `agent.max_tool_steps` | `256` | Runaway-loop backstop per turn (the agent winds down gracefully near it) |
| `agent.context_window_tokens` | `0` (auto) | Context window for compaction budgeting; `0` auto-detects from the model id |
| `agent.compact_at_percent` | `80` | Older turns fold into the thread summary at this share of the usable window |
| `agent.keep_recent_tokens` | `20000` | Recent conversation kept verbatim when older turns are compacted |
| `agent.compaction_model` | provider default | Model that writes compaction/carryover summaries (same provider and auth as replies); empty picks `gpt-5.6-luna` on chatgpt-subscription and openai-api, `grok-4.6` on grok-subscription, the reply model on custom |
| `agent.compaction_reasoning_effort` | `high` | Reasoning level for summary calls |
| `agent.compaction_fast_mode` | `true` | Run summary calls on the priority service tier (openai-api only) |

`.env`:

| Variable | Purpose |
| --- | --- |
| `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` | Photon credentials (required) |
| `OPENAI_API_KEY` | Optional key for the `openai-api` provider (transcription falls back to it too) |
| `CUSTOM_API_KEY` | Optional key for the custom provider endpoint (omit for keyless local servers) |
| `FIRECRAWL_API_KEY` | Enables `web_search` / `web_extract`; tools are hidden when unset |
| `NUDGE_DATA_DIR` | Bootstrap: data directory holding the SQLite DB, SYSTEM.md, SCHEDULE.md, and skills. Defaults to `$XDG_CONFIG_HOME/nudge` or `~/.config/nudge`. |
| `PORT` | Bootstrap: HTTP port (default `3000`, e.g. Paseo's per-worktree ports) |
| `LOG_LEVEL` | Bootstrap: `debug`, `info`, `warn`, or `error` (default `info`) |

Unknown senders, non-iMessage deliveries, non-text content, and duplicate deliveries are ignored.

## Run a production build

```bash
pnpm check
pnpm start
```

Use a single server process: the scheduler's claims, inbound dedupe, and debouncing assume one process over one SQLite file.

## Updating

### Moving an existing `.data` directory

The default data directory changed from the checkout's `.data` directory to `$XDG_CONFIG_HOME/nudge`, or `~/.config/nudge` when `XDG_CONFIG_HOME` is unset. This is a hard cut. Stop the server and console, then move the old directory before starting the updated version:

```bash
nudge_config_root="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$nudge_config_root"
test ! -e "$nudge_config_root/nudge"
mv .data "$nudge_config_root/nudge"
```

Run those commands from the checkout that contains `.data`. If `.env` explicitly sets `NUDGE_DATA_DIR=.data`, remove that line after the move. If you saved a custom provider auth path beginning with `.data/`, change it to the bare filename on the Settings page. Installations that already set `NUDGE_DATA_DIR` can keep their current directory and do not need to move anything.

If the updated server already started once before you did the move, it created a fresh data directory at the new location, and the `test ! -e` line above fails. Look inside `$nudge_config_root/nudge` first: a directory the server just created holds only a new `nudge.db` and the seeded `README.md`, with none of your memory files or skills. If that is all it contains, delete it and run the move again. If you used the agent or changed settings after that accidental start, that new state is in the new directory — merge the two by hand, starting from the old `.data` and copying over anything you did after the switch.

### Updating a source install

Coming from a version that kept its data in the checkout's `.data` directory? Do the move above **before** restarting — otherwise the updated server starts a fresh, empty database at the new default location while your history, memory, and provider tokens stay behind in `.data`.

```bash
git pull
pnpm install
pnpm check
pnpm start   # or restart your process manager / pnpm dev
```

No manual steps beyond the restart: database migrations run automatically as ordered transactions on boot, and settings added by the update appear on the console's Settings page with their defaults (only values you have changed are stored). Interrupted outbound sends recover on startup via the ledger, and a one-shot schedule entry that came due during the downtime fires late, once. Your `.env` and everything in `data_dir` (SYSTEM.md, SCHEDULE.md, memory, skills, the database) are untouched by updates.

## Security boundaries

- Inbound messages arrive only over the authenticated outbound connection to Photon Cloud; the server accepts no inbound HTTP beyond `GET /healthz`.
- Only the exact configured owner handle reaches the model; proactive sends go only to spaces the owner already messaged from.
- The agent's file access is confined to `data_dir` with path-traversal guards; OAuth tokens (including everything under `google/`) and the database are excluded from both reads and writes. SYSTEM.md and README.md are read-only to the agent. Skills, SCHEDULE.md, and the memory files are agent-writable by design and live as plain markdown you can audit.
- Google access runs through the gws shim: per-account credentials are injected per exec (never exported into the agent's environment), `gws auth` is refused, and disconnecting an account revokes its token with Google. With bash enabled the shim is a guardrail, not a sandbox — the hard boundary remains `tools.bash_enabled`.
- OAuth tokens, API keys, and Photon secrets are never logged. `.env` and the legacy `.data` directory are gitignored.
- The console binds to localhost by default and requires its generated access code. Login exchanges the code for a signed, expiring `HttpOnly`, `SameSite=Lax` session cookie; mutations also require an in-memory CSRF token and JSON request body. Browser security headers remain enabled. Secret values never leave the server.
- Non-loopback console binding requires `CONSOLE_REMOTE=1`. Put remote mode behind TLS; SSH port forwarding can continue to use local mode.

The ChatGPT subscription endpoint and its OAuth contract are not part of the standard public OpenAI API. The implementation follows the current first-party OAuth and account-header behavior in [openai/codex](https://github.com/openai/codex) and is isolated so upstream changes are contained.

## Commands

```bash
pnpm dev              # watch Nudge and the console together
pnpm dev:nudge        # watch only Nudge (dev:agent remains an alias)
pnpm dev:console      # watch only the console (console remains an alias)
pnpm start            # build Nudge and its dependencies, then run it
pnpm console:start    # build the console and its dependencies, then serve it on :3100
pnpm console:auth     # show the local console access code
pnpm console:auth rotate # rotate the code; restart a running console afterward
pnpm release:pack edge release # build an edge archive for the current platform
pnpm build            # compile all packages
pnpm typecheck        # build, then type-check all packages
pnpm test             # run unit tests
pnpm check            # type-check, test, and build
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development checks and the required DCO sign-off.

## License

Copyright 2026 the Nudge contributors.

Nudge is licensed under the [Apache License 2.0](LICENSE). Third-party dependencies and material retain their respective licenses and attribution requirements.
