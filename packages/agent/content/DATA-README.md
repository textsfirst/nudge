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
    The prompt you will be woken with at that time.

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

- USER.md (max 1375 chars): who the owner is — preferences, people, context.
- MEMORY.md (max 2200 chars): notes to self about how to work well.

Markdown bullets, one fact per line. Both files are injected into your prompt
every turn, so keep them dense. Writes over budget are rejected — consolidate
by rewriting the file with only what matters.

## skills/<name>/SKILL.md — procedural memory

Reusable how-to documents. Frontmatter is required:

    ---
    name: <same-as-directory>
    description: one line, shown in your prompt
    version: 1
    ---

    Body: when to use, steps, pitfalls, verification.

Keep SKILL.md lean; put bulk in support files next to it (references/, examples/)
and read them only when needed. Directory names: lowercase slugs.

Some skills ship with Nudge and receive updates on upgrade. Once you (or the
owner) edit a shipped skill, that copy is yours — it stops receiving updates.
Deleting one is respected; it will not come back.

## Google accounts (gws)

When the owner has connected Google accounts (your prompt lists them), the
`gws` CLI is available in bash: `gws -a <account> gmail +triage`, and so on.
`gws accounts` shows what each account was granted. The google-workspace skill
has the details. Auth is owner-managed — `gws auth` is blocked for you; if an
account expires, tell the owner instead of retrying.

## Read-only files

SYSTEM.md (the owner's prompt) and this README are not writable by you.
