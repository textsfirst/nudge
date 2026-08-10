# Nudge

Nudge is an open, highly opinionated personal agent that lives in iMessage. You run your own instance: the owner texts a Photon Cloud number; an LLM agent replies, remembers, searches its own history, maintains skills, and — through a markdown-defined schedule — texts first.

There is deliberately no command system. Threads roll over silently (at local midnight and after idle gaps) with an LLM-written carryover summary, long threads compact instead of truncating, and "start over" or "remind me every morning" are just things you say in conversation.

## Architecture

The pnpm workspace keeps the replaceable boundaries small:

- `apps/server` — configuration, HTTP lifecycle, SYSTEM.md loading, the scheduler, ledger-backed outbound delivery, Google account plumbing for the gws CLI, and the daily connection health check
- `apps/console` — the local web console (Elysia + React): threads manager, markdown/config editors, secrets, and all connection setup (Google accounts, ChatGPT sign-in)
- `packages/agent` — the tool-calling agent loop (Vercel AI SDK), prompt stack, thread lifecycle (rollover/compaction/carryover), the file workspace with per-path validators, and model providers
- `packages/photon` — signed webhook handling, owner filtering, burst debouncing, typing indicators, message chunking, and proactive sends via persisted space ids
- `packages/store` — SQLite (`node:sqlite`) persistence: threads, messages with FTS5 search, spaces, schedule state, memory, the outbound ledger, and webhook dedupe
- `packages/schedule` — the deterministic SCHEDULE.md parser and timing engine (croner)

### Files are the API

The agent's world is a real filesystem on a real box, deliberately. Models are RL-trained on exactly this loop — list, read, grep, edit, run — so a directory of plain files is the interface their competence transfers to, not a compromise. This is a hard boundary for the design: anything else the system needs (persistence, sync, backups) sits behind the filesystem, invisible to the model, and never replaces it as the agent's interface.

The core tools are file operations scoped to `data_dir`: `list_files`, `read_file` (paged — long files return a `Use offset=N to continue` footer), `edit_file` (exact-match in-place edits), and `write_file` (whole-file replace) — the latter two share per-file validation. Genuine computation comes from `search_history` (FTS5), `bash` (runs with `data_dir` as its working directory — a default, not a sandbox; disable with `tools.bash_enabled: false`), and optional `web_search`/`web_extract` (Firecrawl). Everything else — schedule, memory, skills — is a markdown file convention documented in a system-written `data_dir/README.md` that the agent reads on demand. New capabilities cost a convention, not a tool schema in every prompt. Control signals are in-band tokens: `[SILENT]` (don't reply) and `[NEW_THREAD]` (reset the thread).

Writes are validated per path and rejected with diagnostics the model can act on: SCHEDULE.md must parse, MEMORY.md/USER.md have hard character budgets, `skills/*/SKILL.md` needs frontmatter, and SYSTEM.md plus the README are read-only to the agent. Secrets (`chatgpt-auth.json`) and runtime state (`nudge.db`) are invisible to it.

### The prompt stack

Every turn's system prompt is assembled from five slots, stable content first so prompt-prefix caching survives: **SYSTEM.md** (yours) → generated tool guidance → memory snapshot → skills list → current local time. It is frozen per thread and re-read only at rollover.

### Files you own (in `data_dir`, default `.data/`)

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

- Photon webhooks are deduplicated durably and delivered at-least-once; bursts of texts are debounced (~2.5 s) into one considered reply, with a typing indicator showing from the first text so the wait never reads as silence.
- A text arriving while a reply is still being generated steers it: the in-flight model call aborts, everything sent while busy folds into one follow-up turn (full history included), and no stale reply goes out. If the aborted turn had already run tools, a note recording those calls lands in history so the next turn doesn't redo them.
- Every outbound message is journaled in a ledger before sending. On restart, sends that never started go out as-is; ones interrupted mid-send are retried with a visible "♻️ Recovered reply" marker, bounded to 3 attempts within 24 hours.
- Scheduled entries claim crash-safely and never back-fill occurrences from before they existed; a one-shot that came due while the server was down fires late, once.
- SQLite upgrades run as ordered transactional migrations, including a one-time FTS rebuild for pre-versioned databases. Webhook dedupe and terminal delivery records are pruned on a bounded schedule; conversation history remains owner-controlled in the console.

## Requirements

- Node.js 22.5+ (Nudge uses the built-in `node:sqlite`)
- pnpm 10
- A Photon Cloud project and iMessage line
- Either a ChatGPT subscription (authorized from the console's Connections page), or an OpenAI API key
- Optional: the [`gws` CLI](https://github.com/googleworkspace/cli) plus a Google Cloud OAuth client for Google account access (see "Google accounts")
- A public HTTPS URL for the webhook

## Setup

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
   SPECTRUM_WEBHOOK_SECRET=...
   ```

   and set your handle on the console's **Settings** page (`pnpm console`, then Settings → Owner handle). It must exactly match Photon's `message.sender.id`; the server refuses to start until it is set.

3. For the default ChatGPT subscription provider, authorize once from the console: `pnpm console`, open the **Connections** page, and click Connect — a device-code sign-in you can complete from any browser.

   To use only an API key instead: set Provider to `openai-api` in console Settings plus `OPENAI_API_KEY` in `.env`. API fallback is off by default. With the subscription provider, a configured `OPENAI_API_KEY` + the API-credit fallback toggle is used only when subscription auth fails; startup and logs call out when it can spend API credits.

   To use any other OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, LM Studio, a proxy): set Provider to `custom` in console Settings, fill in the custom base URL and model id, and — if the endpoint needs one — set `CUSTOM_API_KEY` in `.env`. Most compatible servers implement the Chat Completions API (the default); switch the API flavor to `responses` only when the endpoint supports it. For model ids the context-window registry does not recognize, set `agent.context_window_tokens` explicitly.

4. Optionally create `.data/SYSTEM.md` (personality/rules) and `.data/SCHEDULE.md` (proactive messages). Both work from the first boot without them.

5. Start everything and expose port 3000 via your HTTPS host or tunnel:

   ```bash
   pnpm dev
   ```

   This runs the agent server (`:3000`) and the web console (API `:3100`, UI `:5174`) together, each with a labeled, color-coded output prefix; Ctrl+C stops all of them. Use `pnpm dev:agent` or `pnpm console` to run just one side.

   Register `POST https://your-host.example/webhooks/photon` in Photon. Health check: `GET /healthz`.

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
pnpm --filter @nudge/console build    # build the UI
pnpm console:start                    # rebuild, then serve API + UI on :3100
```

Google sign-in redirects back to the exact console address in your browser, so register that address (e.g. `http://localhost:3100/api/connections/google/callback` — and the `:5174` variant if you use the dev server) in your OAuth client; the wizard shows the exact string to copy.

The console binds to `127.0.0.1` and has no auth of its own — it edits your secrets and prompt, so reach it remotely only through a tunnel you trust (Tailscale, `ssh -L`). `CONSOLE_PORT` and `CONSOLE_HOST` override the defaults. It reads the same SQLite file as the server (WAL + busy timeout make the two processes safe together).

## Google accounts (gws)

Nudge can work the owner's Gmail, Calendar, Drive, Docs, Sheets, Contacts, and Tasks through the [Google Workspace CLI (`gws`)](https://github.com/googleworkspace/cli), driven over the existing bash tool — no extra tool schemas. Multiple accounts are first-class: each connected account (label like `personal` or `work`) gets its own credential store, and the agent picks one per command with `gws -a work gmail +triage`. A `google-workspace` skill is seeded on first connect; the prompt lists connected accounts.

Setup lives entirely on the console's **Connections** page:

1. **One-time Google Cloud app** — the wizard walks through creating a (free, private) Cloud project, publishing the OAuth consent screen to production (testing mode expires sign-ins after 7 days), enabling the APIs for the services you pick, and creating a **Web application** OAuth client with the redirect URI the wizard displays. Paste the client JSON and you never see this step again.
2. **Per account** — pick services and access (read-only or full per service), name the account, and sign in with Google. Consent runs in your browser wherever it is — the redirect returns to the console's own origin, so it works over Tailscale or `ssh -L` against a fully headless server (no browser or OS keyring needed there; this is also why Nudge drives the OAuth flow itself instead of `gws auth login`).

The `gws` binary itself must be installed on the machine running Nudge (`brew install googleworkspace-cli` or `npm i -g @googleworkspace/cli`; the gws binary setting for custom locations). Nudge's shim fronts it for the agent: it injects the chosen account's credentials per exec, refuses `gws auth` (connections are owner-managed), adds `gws accounts` for status, and turns auth failures into "tell the owner to reconnect" guidance.

A daily health check probes every connection (Google accounts and ChatGPT auth) and texts you once when one breaks — so an expired token doesn't surface as a silently failing morning briefing.

## Photon transport note

Photon's inbound delivery is a signed HTTP webhook; the supported cloud send path is `space.send(...)` from `spectrum-ts`. Nudge verifies raw-body signatures via `app.webhook(...)`, replies through the webhook's rehydrated space, and sends proactively by persisting each space id and rehydrating it later with `space.get(id)`. All Photon-specific code stays behind the transport interface in `packages/photon`.

## Configuration

Settings live in the SQLite database (`settings` table) and are edited on the console's **Settings** page; secrets live in `.env` (gitignored). Only values you change are stored — everything else follows the schema defaults, so new settings appear automatically after an upgrade. Settings are read at boot; restart the server to apply changes.

Settings (console → Settings):

| Key | Default | Purpose |
| --- | --- | --- |
| `owner_handle` | required | The one handle allowed to talk to Nudge |
| `timezone` | machine timezone | IANA zone for schedules and midnight rollover |
| `provider.selected` | `chatgpt-subscription` | `chatgpt-subscription`, `openai-api`, or `custom` |
| `provider.chatgpt.model` | `gpt-5.4-mini` | Model slug for the subscription endpoint |
| `provider.chatgpt.auth_file` | `.data/chatgpt-auth.json` | OAuth credential file |
| `provider.openai.model` | `gpt-5-mini` | Standard API model |
| `provider.openai.fallback_enabled` | `false` | API-key fallback for subscription auth failures |
| `provider.custom.base_url` | unset | Base URL of an OpenAI-compatible endpoint (e.g. `http://localhost:11434/v1`) |
| `provider.custom.model` | unset | Model id the custom endpoint expects |
| `provider.custom.api` | `chat-completions` | API flavor the endpoint implements: `chat-completions` or `responses` |
| `model.reasoning_effort` | model default | `none` … `max` reasoning level |
| `model.fast_mode` | `false` | Priority service tier for faster output |
| `tools.bash_enabled` | `true` | Set `false` to remove the bash tool |
| `tools.firecrawl_url` | Firecrawl cloud | Self-hosted Firecrawl endpoint (enables the web tools without a key) |
| `google.default_account` | sole account | Account label `gws` uses when the agent omits `-a` |
| `google.gws_path` | PATH lookup | Explicit path to the `gws` binary |
| `threads.idle_hours` | `6` | Idle gap before a thread rolls over |
| `threads.debounce_ms` | `2500` | Burst window before replying |
| `agent.max_tool_steps` | `256` | Runaway-loop backstop per turn (the agent winds down gracefully near it) |
| `agent.context_window_tokens` | `0` (auto) | Context window for compaction budgeting; `0` auto-detects from the model id |
| `agent.compact_at_percent` | `80` | Older turns fold into the thread summary at this share of the usable window |
| `agent.keep_recent_tokens` | `20000` | Recent conversation kept verbatim when older turns are compacted |

`.env`:

| Variable | Purpose |
| --- | --- |
| `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` / `SPECTRUM_WEBHOOK_SECRET` | Photon credentials (required) |
| `OPENAI_API_KEY` | Optional API provider / subscription fallback |
| `CUSTOM_API_KEY` | Optional key for the custom provider endpoint (omit for keyless local servers) |
| `FIRECRAWL_API_KEY` | Enables `web_search` / `web_extract`; tools are hidden when unset |
| `NUDGE_DATA_DIR` | Bootstrap: data directory holding the SQLite DB, SYSTEM.md, SCHEDULE.md, skills/ (default `.data`) |
| `PORT` | Bootstrap: HTTP port (default `3000`, e.g. Conductor's per-workspace ports) |
| `LOG_LEVEL` | Bootstrap: `debug`, `info`, `warn`, or `error` (default `info`) |

Unknown senders, non-iMessage deliveries, non-text content, and duplicate webhook deliveries are ignored.

## Run a production build

```bash
pnpm check
pnpm start
```

Use a single server process: the scheduler's claims, webhook dedupe, and debouncing assume one process over one SQLite file.

## Security boundaries

- Photon HMAC verification runs on the exact raw request bytes, including the replay-window check.
- Only the exact configured owner handle reaches the model; proactive sends go only to spaces the owner already messaged from.
- The agent's file access is confined to `data_dir` with path-traversal guards; OAuth tokens (including everything under `google/`) and the database are excluded from both reads and writes. SYSTEM.md and README.md are read-only to the agent. Skills, SCHEDULE.md, and the memory files are agent-writable by design and live as plain markdown you can audit.
- Google access runs through the gws shim: per-account credentials are injected per exec (never exported into the agent's environment), `gws auth` is refused, and disconnecting an account revokes its token with Google. With bash enabled the shim is a guardrail, not a sandbox — the hard boundary remains `tools.bash_enabled`.
- OAuth tokens, API keys, and Photon secrets are never logged. `.env` and `.data` are gitignored.
- The console binds to localhost only, returns secret names but never values, and applies the same per-file validation and traversal guards as the agent's file tools.

The ChatGPT subscription endpoint and its OAuth contract are not part of the standard public OpenAI API. The implementation follows the current first-party OAuth and account-header behavior in [openai/codex](https://github.com/openai/codex) and is isolated so upstream changes are contained.

## Commands

```bash
pnpm dev              # watch the agent server and the web console together
pnpm dev:agent        # watch only the agent server
pnpm start            # rebuild the server and dependencies, then run it
pnpm console          # watch only the web console (API :3100, UI :5174)
pnpm console:start    # rebuild the console and dependencies, then serve it on :3100
pnpm build            # compile all packages
pnpm typecheck        # build, then type-check all packages
pnpm test             # run unit tests
pnpm check            # type-check, test, and build
```
