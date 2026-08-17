# Product gaps: Poke, Orchid, Hermes

Nudge sits in a clear slot: **Orchid’s product** (one executive assistant in iMessage, approval-first, voice is the product) on **Hermes’s architecture** (self-hosted, files are the API, `MEMORY.md` / `USER.md`, skills the agent writes). Poke is the hosted, multi-channel, marketplace version of the same category.

This report lists gaps against those three, then drops anything that fights Nudge’s philosophy. The remaining items are jobs the other products already sell, that Nudge claims in `SYSTEM.md`, and that the current surface does not yet make inevitable.

Compared against:

- [Poke](https://poke.com) — Interaction Company. Hosted assistant on Apple Messages, WhatsApp, Telegram, RCS. Recipes, integrations, real-time automations.
- [Orchid](https://orchid.ai) — YC. Hosted EA in iMessage/SMS. Inbox, calendar, travel, habits. You approve, it handles the rest.
- [Hermes Agent](https://github.com/nousresearch/hermes-agent) — Nous Research. Self-hosted agent runtime. Skills loop, multi-platform gateway, 80+ tools.

Date: 2026-08-14.

---

## The filter

Nudge’s own rules, taken from the README, `SYSTEM.md`, and the bundled skills:

- You run your own instance. Files on a real box are the API.
- One owner, one iMessage number. The owner never sees the machinery.
- There is deliberately no command system. Everything is natural conversation.
- New capability costs a **convention**, not a tool schema in every prompt.
- Executive assistant, not a chatbot: do the work, bring only the decisions.
- Approval-first: draft until they tap. Never spend, send, or promise without a go-ahead.
- Attention is scarce. Earn every interruption. Silence is a feature.
- Memory is bounded and owner-auditable. Consolidate, don’t hoard.
- The console is an SSH replacement, not the daily product.
- Voice is the product.

Anything that needs a marketplace, a second channel, a slash command, a visible multi-agent roster, or Nudge-as-merchant is out.

---

## What Nudge already has

So the gaps below are not “build an assistant.” They are the last mile of jobs already claimed.

| Surface | Status |
|---|---|
| iMessage via Photon (typing, read receipts, chunking, delivery ledger) | shipped |
| No command system; threads roll over and compact | shipped |
| `SCHEDULE.md` — cron, one-shots, standing agents, check-gated watchers | shipped |
| Bounded `MEMORY.md` / `USER.md` | shipped |
| Skills (agentskills.io + `skills` CLI from skills.sh) | shipped |
| FTS5 history search | shipped |
| Tapbacks in both directions — outbound reactions, inbound tapback-as-approval; inbound voice + images (transcribe, vision) | shipped |
| `send_file` (images, PDF, text) — never voice | shipped |
| Google Workspace via `gws` (Gmail, Calendar, Drive, Docs, Sheets, Contacts, Tasks) | shipped |
| iCloud Calendar via CalDAV skill | shipped |
| MCP via `mcp` CLI in bash | shipped |
| Dispatch + standing agents, hidden from the owner | shipped |
| Approval-first, proactive-rhythm, texting-voice, watchers skills | shipped |
| Connection health check; crash-safe schedule claims | shipped |

Nudge is already ahead of all three on crash-safe delivery, watchers that do not cost a turn, no command system, files you can audit, and a voice that treats silence as a feature.

---

## Gaps that survive the filter

### 1. Inbox as a standing job, not a CLI the model might remember

**Who has it.** Orchid’s core loop. Poke’s original product.

**What they do.** Triage what arrived, draft replies in the owner’s voice, surface only the two things that need a human. Orchid keeps drafts as drafts until the owner sends. Poke can wake on important mail in real time, not just in a morning batch.

**What Nudge has.** `gws gmail +triage` / `+send` / `+reply`, a seeded `google-workspace` skill that lists those commands, and watchers that can poll unread mail.

**The gap.** Mechanics without the job.

- No standing `email` agent with its own history. Each morning is a cold `gws` call.
- No watcher that wakes on *new mail that matters*, only a hash of the unread pile if the agent happens to write one.
- `gws gmail +send` will send the moment the model decides it was approved. Drafts are not forced to stay drafts in Gmail until the owner taps.
- The rundown line “2 need you: … (reply drafted)” is something the owner has to invent, not the default once Google is connected.

Without this, Nudge is a very good texter that *can* open Gmail. Orchid is an EA whose job *is* the inbox.

**Shape that fits.** A convention + a standing agent, not a new tool schema. Seed an `email` agent and a check-gated `SCHEDULE.md` entry on first Google connect. Hard rule: outbound mail is a Gmail draft until approval. The interaction agent curates; the owner hears only what needs them.

### 2. A tapback is supposed to be the commit — **shipped 2026-08-17**

**Who has it.** Poke treats iMessage reactions as input. Now Nudge does too.

**What shipped.** Photon's inbound path now projects an owner tapback into the turn as `[tapback 👍 on your message: "…"]`, quoting the exact bubble it landed on (spectrum only surfaces reaction *additions*, so removing a tapback never triggers anything). The prompt and the approval skill read 👍 on a pending ask as a typed yes, 👎 as cancel, ❓ as “sharpen the ask” — they do not send.

### 3. Open loops cannot live in a 2,200-character file

**Who has it.** Orchid: “the starred email, the deadline, your mom’s birthday.” Poke: “alert me when this lands.” Hermes: durable facts in files, procedure in skills.

**What Nudge has.** The proactive-rhythm skill tells the agent to keep a ledger of open loops **in `MEMORY.md`**. That file is capped at 2,200 characters on purpose.

**The gap.** A real EA ledger (awaiting reply, promised deliverable, expiring hold, price watch) will blow the budget in a week. The consolidator will then delete the loops.

**Shape that fits.** A file convention, not a bigger memory. Something like `LOOPS.md` the agent edits; each loop has a scheduled check-in (already the rule); `MEMORY.md` keeps only “how to work,” not the queue. Same shape as `SCHEDULE.md`: a format code can validate, the owner can audit, the agent can grep.

### 4. People cannot live in a 1,375-character file

**Who has it.** Orchid’s “tartine, last march” moment is people + preference + a texture fact. That line is already in Nudge’s memory skill.

**What Nudge has.** `USER.md` (1,375 chars). `gws` Contacts. iCloud CardDAV on the same credentials as calendar.

**The gap.** `USER.md` cannot hold a real people file. Recall either gets stuffed into the budget or forgotten.

**Shape that fits.** A people convention the agent maintains (name, how the owner talks about them, how to reach them, open threads with them) and reads on demand. Bounded memory stays bounded. Progressive disclosure, the same idea Hermes uses for skills.

### 5. Day-one rhythm should exist the moment a calendar or inbox is connected

**Who has it.** Poke and Orchid text a rundown the first morning. Hermes users hand-write cron.

**What Nudge has.** “Remind me every morning is just something you say” — correct for *changes*, wrong for *zero state*. An owner who connected Google and never said “brief me weekdays at 7:30” gets silence.

**The gap.** The interruption budget still applies: one seeded `SCHEDULE.md` entry (morning rundown, `[SILENT]` if empty) is earned. A marketplace of recipes is not.

### 6. The last mile of booking is a form, not a search

**Who has it.** Orchid’s demo is villa + flights + “tap here to pay.” Poke does flight check-in and restaurant booking. Hermes has a real browser.

**What Nudge has.** `web_search` / `web_extract`. Firecrawl dies on JavaScript. The watchers skill already admits this.

**The gap.** The EA jobs the category is sold on fail here: OpenTable, airline check-in, visa slots, a vendor invoice portal.

**Shape that fits.** Not a `browser` tool schema. Not Nudge-as-merchant-of-record.

- A headless browser available to `bash` (Playwright or similar), same as `gws`.
- The agent prepares the booking to the last screen.
- The owner approves the exact amount and terms.
- Then it submits.

“Tap here to pay on Expedia” is Orchid’s hosted checkout. That does not fit a self-hosted instance. “I filled the form, $840 nonrefundable, 👍 to submit” does.

### 7. Meeting booking is still “I can see the calendar”

**Who has it.** Orchid holds time, proposes slots, preps you before the call. Poke schedules.

**What Nudge has.** `gws calendar +agenda` / `+insert`, plus the iCloud CalDAV skill.

**The gap.** No loop:

- find free/busy across the owner’s calendars
- propose two or three times in the owner’s voice
- on approval, write the hold **and** send the invite or email
- a schedule entry the morning of (or an hour before) that is meeting prep, not a generic reminder

This is the same approval-first loop as email. It should be a skill + a standing `calendar` agent, not six new tools.

### 8. Memory and skills do not improve unless the turn remembers to write them

**Who has it.** Hermes’s actual advantage: after a hard task it writes a skill; a background review persists facts. `/learn` is just a prompt (the slash command is the part to drop).

**What Nudge has.** The prompt *asks* the model to save skills and memory during the turn. Mid-text, competing with “reply in three lines,” that write often does not happen. There is no after-thread pass.

**The gap.** A silent post-rollover (or post-compaction) pass that:

- proposes `USER.md` / `MEMORY.md` edits against the budget
- drafts a skill only when the thread actually taught a procedure
- never texts the owner unless something needs a decision

Fits files-as-API, bounded memory, and “the owner never sees the machinery.” It is the Hermes loop without Hermes’s command surface.

### 9. First-text setup should happen in the thread

**Who has it.** Poke: text the number. Orchid: text the number. Hermes: `hermes setup`, then a gateway wizard.

**What Nudge has.** Photon, `.env`, console, Google Cloud OAuth wizard, iCloud app password, `pip install caldav`.

**The gap.** Self-hosted setup will never be “no download.” After the first inbound, Nudge should already know what it cannot do and say so in-voice — “i don’t have your calendar yet. one thing to do: …” — instead of failing open with “give me a min, i’ll find out” and then discovering CalDAV isn’t installed.

The console stays the place secrets get pasted. The thread becomes the coach. Still one entity, no command system.

---

## Worth doing, lower urgency

| Gap | Who has it | Why it still fits |
|---|---|---|
| Photos with recs by default | Orchid (villa, tartine) | `send_file` exists; the habit does not. A rec without a picture feels like a search result. |
| Calendar-triggered meeting prep | Orchid, Poke | A `check:` on today’s events, or a one-shot created when an event is inserted. No new tool. |
| Important-mail-now, not just the rundown | Poke (push / real-time recipes) | Urgent + important is already allowed to interrupt. Gmail watch or a tight watcher. |
| Location / weather for the morning | Poke (“jacket or not”) | A watcher or a line in the briefing skill. Not a weather product. |
| Outlook | Poke (shipped), Orchid (promised) | Only if the owner’s work inbox is Microsoft. Shape it like `gws`: a CLI or MCP, no new tool schema. |
| Inline reply to a specific bubble | Poke (2026-07) | Makes “good to send?” threads less ambiguous once tapback-approval exists. |

---

## Dropped — they do not fit

### From Poke

- WhatsApp, Telegram, RCS, SMS as product surfaces. Nudge lives in iMessage.
- Hosted “text this number, no install.”
- Recipe directory, creator payouts, share-with-friends automations.
- Photo editing, emoji generation, smart-home and fitness as first-class product lines. Bash or MCP can grow those if an owner cares; they are not the EA.
- Personalized pricing, the bouncer, Messages for Business as a growth channel.
- Group chats, couples, “text my partner too.” One owner handle is a hard boundary.

### From Orchid

- Messaging both people in a relationship and passing information between them.
- In-thread checkout where Nudge is the merchant.
- “A hundred tools, one assistant” as a catalog. MCP + `gws` is the integration story; a connector marketplace is not.
- Unbounded “never forgets.” Budgets exist so the agent consolidates.
- Enterprise / contact-sales motion.

### From Hermes

- Slash commands (`/learn`, `/skills`, `/plan`, bundles). Explicitly rejected.
- CLI/TUI as the product, 15–22-platform gateway, named profiles, multiplexed tenants.
- 80+ built-in tools, computer-use, image/video/TTS tools, Home Assistant tools. Competence transfers through files + bash + search, not a tool schema per verb.
- Visible multi-agent specialists. Standing agents already exist and must stay plumbing.
- Skills Hub / plugin marketplace as a surface the owner lives in. `skills add` from the thread, after asking, is enough.
- Honcho and the eight memory providers. They fight bounded, owner-auditable files.
- Dashboard as daily admin. The console is an SSH replacement.
- RL / trajectory export. That is a research harness, not an EA.

---

## How to read this

If you only do three things, do **inbox as a job**, **inbound tapback = approve**, and **a loops file so follow-ups survive the memory budget**. Those are the Orchid jobs Nudge already claims in `SYSTEM.md` and does not yet make inevitable.

Mine Hermes for **loops** (after-thread consolidation, last-mile browser via bash), not for **surfaces** (commands, gateways, tool counts). Mine Poke for **day-one rhythm and real-time “this email matters now”**, not for recipes, channels, or a consumer marketplace.
