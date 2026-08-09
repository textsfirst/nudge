---
name: icloud-calendar
description: Read and write iCloud Calendar via CalDAV (bash + python caldav)
version: 1
---

# iCloud Calendar (CalDAV)

Access the owner's iCloud calendars via Apple's CalDAV endpoint, using the bash
tool to run python. Works from any platform - no macOS required.

Requires: the bash tool, `python3` with the `caldav` package installed, and the
env vars `ICLOUD_APPLE_ID` / `ICLOUD_APP_PASSWORD` (they are inherited by your
bash commands when configured). If any of these are missing, tell the owner
what's needed (see Setup) instead of guessing.

## When to Use

- Reading today's/this week's events for briefings or scheduling.
- Creating, moving, or deleting events on an iCloud calendar.
- Checking free/busy before proposing times.

## Setup (one-time, done by the owner)

1. Generate an **app-specific password**: account.apple.com → Sign-In and
   Security → App-Specific Passwords (requires 2FA on the Apple ID). Normal
   Apple ID passwords will NOT work.
2. Add to nudge's `.env` file and restart:
   ```
   ICLOUD_APPLE_ID=you@icloud.com
   ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   ```
3. Install the client library once: `pip install caldav` (pulls
   icalendar/vobject).

## Procedure

Use the Python `caldav` library - it handles Apple's principal/home-set
discovery automatically from the root endpoint `https://caldav.icloud.com/`.
Run scripts via bash heredocs: `python3 - <<'EOF' ... EOF`.

List calendars:

```python
import os, caldav
client = caldav.DAVClient(
    url="https://caldav.icloud.com/",
    username=os.environ["ICLOUD_APPLE_ID"],
    password=os.environ["ICLOUD_APP_PASSWORD"],
)
principal = client.principal()
for cal in principal.calendars():
    print(cal.name, cal.url)
```

Read events in a range:

```python
from datetime import datetime, timedelta
cal = next(c for c in principal.calendars() if c.name == "Work")
events = cal.search(start=datetime.now(), end=datetime.now() + timedelta(days=7), event=True, expand=True)
for ev in events:
    comp = ev.icalendar_component
    print(comp.get("summary"), comp.get("dtstart").dt, comp.get("dtend").dt)
```

Create an event:

```python
cal.save_event(
    dtstart=datetime(2026, 8, 12, 14, 0),
    dtend=datetime(2026, 8, 12, 15, 0),
    summary="Coffee with Alex",
    location="Tartine",
)
```

Edit/delete: fetch the event via `search` or `event_by_url`, mutate
`ev.icalendar_component` and `ev.save()`, or `ev.delete()`.

## Pitfalls

- **401 Unauthorized**: the owner pasted their real Apple ID password. Only
  app-specific passwords work.
- **Recurring events**: always pass `expand=True` when searching a range,
  otherwise you get the master VEVENT, not the instances.
- **Timezones**: iCloud stores TZ-aware events; always compare with tz-aware
  datetimes to avoid off-by-hours briefings.
- **Read-only subscribed calendars** (holidays, sports) reject writes - check
  before saving.
- **Reminders are NOT here**: Apple removed Reminders from CalDAV. Use your own
  SCHEDULE.md for reminders instead.
- Contacts live on the sibling endpoint `https://contacts.icloud.com/`
  (CardDAV), same credentials.

## Verification

`principal.calendars()` returns a non-empty list, and a freshly created test
event appears in the owner's Calendar app within seconds (then delete it).

## Approval rule

Reading is free. Creating, moving, or deleting events follows the
approval-first-execution loop: show the exact event (title, time, calendar) and
get a go-ahead before writing.
