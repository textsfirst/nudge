# Nudge data directory

System-maintained file. Formats for the files you (the agent) work with.

## Tools over this directory

read_file pages long files — follow the offset hint in its footer. edit_file
makes exact-match in-place edits; write_file replaces a whole file. Both are
validated per file (schedule grammar, memory budgets, skill frontmatter).
When available, bash runs with this directory as its working directory.

## SCHEDULE.md — every proactive message

One entry per "##" section:

    ## Entry name
    when: <timing>
    agent: <standing agent name>     (optional)
    check: <bash command>            (optional; requires agent:)
    The prompt you will be woken with at that time.

With an "agent:" line, the entry fires through that standing background agent
instead of waking you cold: it runs with its own memory of every earlier
firing, and its report comes to you to curate before the owner hears anything.
Use it for recurring duties that build on their own history (inbox sweeps,
follow-up ledgers); leave it off for simple self-contained reminders. Name an
existing standing agent, or a new name to create one on first fire.

A "check:" line turns the entry into a watcher: the command runs at each
firing and the agent is woken only when its output changes or the command
fails — tight polling costs a subprocess, not a turn. The command runs in
this directory with gws and mcp available; its first run records a baseline
silently. Normalize the output (sort, jq, grep) so only meaningful changes
wake anyone — the watchers skill has recipes.

Timing grammar (exact — nothing else parses; times are the owner's local time):

    every day at 7:30
    weekdays at 7:30
    weekends at 9:00
    every monday at 18:00        (any weekday name)
    every 2 hours
    every 30 minutes
    2026-09-01 09:00 once        (one-shot; delete it after it fires)
    cron: 30 7 * * 1-5

Resolve relative times ("tomorrow morning") yourself before writing; the file
only takes concrete times. Entry names are unique persistent identities: edit
an entry in place to preserve its run state, or rename it when intentionally
creating a new one. Invalid writes are rejected with diagnostics.

## MEMORY.md and USER.md — curated memory

- USER.md (max 1375 chars): who the owner is — preferences, context, and a
  one-line index of who matters. People detail lives in people/<name>.md.
- MEMORY.md (max 2200 chars): notes to self about how to work well.

Markdown bullets, one fact per line. Both files are injected into your prompt
every turn, so keep them dense. Writes over budget are rejected — consolidate
by rewriting the file with only what matters.

## LOOPS.md — open loops

One `## ` section per loop. Include what's owed, by whom, the next check
date, and the name of its SCHEDULE.md check-in entry. Every loop must have
a check-in so it can't rot. When a loop closes, delete both the section and
the schedule entry.

Capped at 4000 chars — closed loops are deleted, not archived. MEMORY.md no
longer holds the ledger.

## people/<name>.md — people files

One file per person who matters. Texture: how the owner talks about them,
preferences, birthdays, running jokes. Open threads are referenced by loop
name only — never restate the loop here.

Not an address book. Reach info belongs in Google Contacts / CardDAV. Each
file is capped at 1500 chars. USER.md keeps only the one-line index of who
matters.

## skills/<name>/SKILL.md — procedural memory

Reusable how-to documents in the Agent Skills format (agentskills.io / the
skills.sh ecosystem). Frontmatter is required:

    ---
    name: <same-as-directory>
    description: what it does and when to use it, shown in your prompt
    metadata:
      version: "1"
    ---

    Body: when to use, steps, pitfalls, verification.

Names are 1-64 lowercase letters/digits with single hyphens and must match the
directory. Optional frontmatter: license, compatibility, metadata (string map).
Keep SKILL.md lean; put bulk in support files next to it (scripts/, references/,
assets/) and read them only when needed.

The `skills` CLI in bash manages installs from the skills.sh ecosystem:
`skills ls`, `skills add <owner/repo[/name]>` (public GitHub repos),
`skills check`, `skills update <name>`, `skills restore <name>` (shipped
skills), `skills rm <name>`. Ask the owner before installing anything new —
a skill's instructions become part of your behavior. skills-lock.json is the
CLI's provenance record; never edit it by hand.

Some skills ship with Nudge and receive updates on upgrade. Once you (or the
owner) edit a shipped skill, that copy is yours — it stops receiving updates.
Deleting one is respected; it will not come back.

## Google accounts (gws)

When the owner has connected Google accounts (your prompt lists them), the
`gws` CLI is available in bash: `gws -a <account> gmail +triage`, and so on.
`gws accounts` shows what each account was granted. The google-workspace skill
has the details. Auth is owner-managed — `gws auth` is blocked for you; if an
account expires, tell the owner instead of retrying.

Outbound email is drafts-first: sending only works in the assistant's own
conversation, after the owner approved the exact message; background agents and
scheduled runs prepare Gmail drafts and report them. Connecting a Gmail-scoped
account also seeds an `Inbox watch (<label>)` watcher and a `Morning rundown`
entry into SCHEDULE.md. They are the owner's to keep or delete — a deleted
seeded entry is never re-created.

## MCP servers (mcp/servers.json)

Owner-connected MCP servers, used through the `mcp` CLI in bash: `mcp ls`,
`mcp tools <server>`, `mcp schema <server> <tool>`, then
`mcp call <server> <tool> '<json>'`. The registry:

    {
      "version": 1,
      "servers": {
        "github": {
          "transport": "http",
          "url": "https://api.githubcopilot.com/mcp/",
          "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" }
        },
        "memory": {
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-memory"]
        }
      }
    }

Names are short lowercase slugs; `"enabled": false` disables an entry. Secrets
never go in this file — `${VAR}` references are resolved from the owner's .env
when a server is contacted, and a missing variable is reported by name so the
owner knows what to add. Invalid writes are rejected with diagnostics. The mcp
skill covers usage and failure handling.

## Read-only files

SYSTEM.md (the owner's prompt) and this README are not writable by you.
