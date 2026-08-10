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

  The `when:` grammar is parsed by code, never interpreted by the model at runtime: `every day at 7:30`, `weekdays at 7:30`, `weekends at 9:00`, `every monday at 18:00`, `every 2 hours`, `every 30 minutes`, `YYYY-MM-DD HH:MM once`, or `cron: 30 7 * * 1-5`. Times are `timezone` local. The agent edits this file itself when you ask for reminders; you can also hand-edit it — parse problems get texted to you rather than silently ignored.
- **MEMORY.md and USER.md** — the agent's bounded curated memory (2,200 / 1,375 character budgets): notes to self and facts about you. Injected into every prompt; over-budget writes are rejected so the agent consolidates instead of hoarding.
- **skills/** — the agent's procedural memory: `skills/<name>/SKILL.md` with agentskills.io-style frontmatter plus optional support files. The agent creates and improves these autonomously after solving hard problems; everything is plain markdown you can audit, edit, or delete.
- **README.md** — system-written manual documenting all of the above formats for the agent (and for you).

### Reliability

- Photon webhooks are deduplicated durably and delivered at-least-once; bursts of texts are debounced (~2.5 s) into one considered reply, with a typing indicator showing from the first text so the wait never reads as silence.
- A text arriving while a reply is still being generated steers it: the in-flight model call aborts, everything sent while busy folds into one follow-up turn (full history included), and no stale reply goes out. If the aborted turn had already run tools, a note recording those calls lands in history so the next turn doesn't redo them.
- Every outbound message is journaled in a ledger before sending. On restart, sends that never started go out as-is; ones interrupted mid-send are retried with a visible "♻️ Recovered reply" marker, bounded to 3 attempts within 24 hours.
- Scheduled entries claim crash-safely and never back-fill occurrences from before they existed; a one-shot that came due while the server was down fires late, once.

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

   Settings live in `nudge.config.yaml`; `.env` holds only secrets. There is no example file to copy — the first start of the server (or console) writes `nudge.config.yaml` with defaults and doc comments, and later versions append any new settings to it in place.

2. Put the credentials from the [Photon dashboard](https://app.photon.codes) in `.env`:

   ```dotenv
   SPECTRUM_PROJECT_ID=...
   SPECTRUM_PROJECT_SECRET=...
   SPECTRUM_WEBHOOK_SECRET=...
   ```

   and your handle in `nudge.config.yaml` (run `pnpm dev` once to create the file):

   ```yaml
   owner_handle: "+15551234567"
   ```

   `owner_handle` must exactly match Photon's `message.sender.id`.

3. For the default ChatGPT subscription provider, authorize once from the console: `pnpm console`, open the **Connections** page, and click Connect — a device-code sign-in you can complete from any browser.

   To use only an API key instead: `provider.selected: openai-api` in `nudge.config.yaml` plus `OPENAI_API_KEY` in `.env`. With the subscription provider, a configured `OPENAI_API_KEY` + `provider.openai.fallback_enabled: true` is used only when subscription auth fails — ordinary model or network errors never silently spend API credits.

4. Optionally create `.data/SYSTEM.md` (personality/rules) and `.data/SCHEDULE.md` (proactive messages). Both work from the first boot without them.

5. Start the server and expose port 3000 via your HTTPS host or tunnel:

   ```bash
   pnpm dev
   ```

   Register `POST https://your-host.example/webhooks/photon` in Photon. Health check: `GET /healthz`.

Note: Nudge can only text you proactively after you have texted it at least once — it needs one inbound message to learn the conversation's space id.

## The console

A local web app for everything you'd otherwise SSH in for:

- **Threads** — browse every conversation, read messages (tool calls included), search all history, end the active thread, delete threads or single messages
- **Files** — edit SYSTEM.md, SCHEDULE.md (with a live parse preview and next-run times), memory files (with budget meters), and skills, all validated by the same rules the agent's writes go through
- **Connections** — all sign-in flows: ChatGPT subscription (device code) and Google accounts for the gws CLI (see below); live token status per account
- **Config** — edit `nudge.config.yaml` with live schema validation
- **Secrets** — manage `.env` write-only; values are never sent to the browser

```bash
pnpm console                          # dev: API on :3100, UI on :5174
pnpm --filter @nudge/console build    # build the UI
pnpm console:start                    # serve API + built UI on :3100
```

Google sign-in redirects back to the exact console address in your browser, so register that address (e.g. `http://localhost:3100/api/connections/google/callback` — and the `:5174` variant if you use the dev server) in your OAuth client; the wizard shows the exact string to copy.

The console binds to `127.0.0.1` and has no auth of its own — it edits your secrets and prompt, so reach it remotely only through a tunnel you trust (Tailscale, `ssh -L`). `CONSOLE_PORT` and `CONSOLE_HOST` override the defaults. It reads the same SQLite file as the server (WAL + busy timeout make the two processes safe together).

## Google accounts (gws)

Nudge can work the owner's Gmail, Calendar, Drive, Docs, Sheets, Contacts, and Tasks through the [Google Workspace CLI (`gws`)](https://github.com/googleworkspace/cli), driven over the existing bash tool — no extra tool schemas. Multiple accounts are first-class: each connected account (label like `personal` or `work`) gets its own credential store, and the agent picks one per command with `gws -a work gmail +triage`. A `google-workspace` skill is seeded on first connect; the prompt lists connected accounts.

Setup lives entirely on the console's **Connections** page:

1. **One-time Google Cloud app** — the wizard walks through creating a (free, private) Cloud project, publishing the OAuth consent screen to production (testing mode expires sign-ins after 7 days), enabling the APIs for the services you pick, and creating a **Web application** OAuth client with the redirect URI the wizard displays. Paste the client JSON and you never see this step again.
2. **Per account** — pick services and access (read-only or full per service), name the account, and sign in with Google. Consent runs in your browser wherever it is — the redirect returns to the console's own origin, so it works over Tailscale or `ssh -L` against a fully headless server (no browser or OS keyring needed there; this is also why Nudge drives the OAuth flow itself instead of `gws auth login`).

The `gws` binary itself must be installed on the machine running Nudge (`brew install googleworkspace-cli` or `npm i -g @googleworkspace/cli`; `google.gws_path` for custom locations). Nudge's shim fronts it for the agent: it injects the chosen account's credentials per exec, refuses `gws auth` (connections are owner-managed), adds `gws accounts` for status, and turns auth failures into "tell the owner to reconnect" guidance.

A daily health check probes every connection (Google accounts and ChatGPT auth) and texts you once when one breaks — so an expired token doesn't surface as a silently failing morning briefing.

## Photon transport note

Photon's inbound delivery is a signed HTTP webhook; the supported cloud send path is `space.send(...)` from `spectrum-ts`. Nudge verifies raw-body signatures via `app.webhook(...)`, replies through the webhook's rehydrated space, and sends proactively by persisting each space id and rehydrating it later with `space.get(id)`. All Photon-specific code stays behind the transport interface in `packages/photon`.

## Configuration

Settings live in `nudge.config.yaml`; secrets live in `.env`. Both are gitignored. The settings file is seeded from the schema defaults on first start, and starting a newer version appends any settings the file is missing — your values and comments are never rewritten.

`nudge.config.yaml`:

| Key | Default | Purpose |
| --- | --- | --- |
| `owner_handle` | required | The one handle allowed to talk to Nudge |
| `timezone` | machine timezone | IANA zone for schedules and midnight rollover |
| `provider.selected` | `chatgpt-subscription` | `chatgpt-subscription` or `openai-api` |
| `provider.chatgpt.model` | `gpt-5.4-mini` | Model slug for the subscription endpoint |
| `provider.chatgpt.auth_file` | `.data/chatgpt-auth.json` | OAuth credential file |
| `provider.openai.model` | `gpt-5-mini` | Standard API model |
| `provider.openai.fallback_enabled` | `true` | API-key fallback for subscription auth failures |
| `model.reasoning_effort` | model default | `none` … `max` reasoning level |
| `model.fast_mode` | `false` | Priority service tier for faster output |
| `tools.bash_enabled` | `true` | Set `false` to remove the bash tool |
| `tools.firecrawl_url` | Firecrawl cloud | Self-hosted Firecrawl endpoint (enables the web tools without a key) |
| `google.default_account` | sole account | Account label `gws` uses when the agent omits `-a` |
| `google.gws_path` | PATH lookup | Explicit path to the `gws` binary |
| `data_dir` | `.data` | SQLite DB, SYSTEM.md, SCHEDULE.md, skills/ |
| `threads.idle_hours` | `6` | Idle gap before a thread rolls over |
| `threads.debounce_ms` | `2500` | Burst window before replying |
| `agent.max_tool_steps` | `64` | Runaway-loop backstop per turn (the agent winds down gracefully near it) |
| `agent.max_history_messages` | `40` | Thread length before compaction |
| `server.port` | `3000` | HTTP port (a `PORT` env var overrides it, e.g. Conductor's per-workspace ports) |
| `server.log_level` | `info` | `debug`, `info`, `warn`, or `error` |

`.env`:

| Variable | Purpose |
| --- | --- |
| `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` / `SPECTRUM_WEBHOOK_SECRET` | Photon credentials (required) |
| `OPENAI_API_KEY` | Optional API provider / subscription fallback |
| `FIRECRAWL_API_KEY` | Enables `web_search` / `web_extract`; tools are hidden when unset |

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
- OAuth tokens, API keys, and Photon secrets are never logged. `.env`, `nudge.config.yaml`, and `.data` are gitignored.
- The console binds to localhost only, returns secret names but never values, and applies the same per-file validation and traversal guards as the agent's file tools.

The ChatGPT subscription endpoint and its OAuth contract are not part of the standard public OpenAI API. The implementation follows the current first-party OAuth and account-header behavior in [openai/codex](https://github.com/openai/codex) and is isolated so upstream changes are contained.

## Commands

```bash
pnpm dev              # watch the server
pnpm console          # watch the web console (API :3100, UI :5174)
pnpm console:start    # serve the built console on :3100
pnpm build            # compile all packages
pnpm typecheck        # build, then type-check all packages
pnpm test             # run unit tests
pnpm check            # type-check, test, and build
```
