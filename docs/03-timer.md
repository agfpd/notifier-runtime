# 03 — Timer

[Русский](ru/03-timer.md) · **English**

The `timer` peer sends a message on a schedule. A peer agent registers it with a `send_to_peer` call carrying a `when` (the schedule), a `message`, and a `target`. Optionally it adds a `check` to gate the message behind a condition.

```
send_to_peer(timer, {"when": "0 9 * * *", "message": "Daily standup", "target": "self"})
```

## Schedules: `when`

`when` is either a 5-field cron expression or an `@every` interval.

### Cron

Five fields, separated by spaces, in local system time, at minute granularity:

```
┌─ minute       0–59
│ ┌─ hour       0–23
│ │ ┌─ day of month   1–31
│ │ │ ┌─ month         1–12
│ │ │ │ ┌─ day of week 0–7 (0 and 7 are both Sunday)
│ │ │ │ │
0 9 * * *
```

Each field accepts:

| Form | Meaning | Example |
|------|---------|---------|
| `*` | every value | `* * * * *` — every minute |
| `a` | one value | `0 9 * * *` — 09:00 daily |
| `a-b` | a range | `0 9-17 * * *` — top of every hour, 09:00–17:00 |
| `*/n` | every n across the field | `*/15 * * * *` — every 15 minutes |
| `a-b/n` | every n within a range | `0 9-17/2 * * *` — 09:00, 11:00, … 17:00 |
| `a,b,c` | a list | `0 9,13,18 * * *` — at 09:00, 13:00, 18:00 |

Day-of-month and day-of-week follow the standard Vixie-cron OR rule: when **both** fields are restricted (neither is `*`), the day matches if **either** matches. `0 9 13 * 5` fires at 09:00 on the 13th of the month *and* on every Friday — not only Fridays that fall on the 13th.

The schedule runs in the host's local time. There is no special daylight-saving handling; on a host without DST (for example UTC+3) this never matters.

### Intervals

`@every <duration>` fires on a fixed period:

```
@every 30m      every 30 minutes
@every 1h30m    every 90 minutes (units compose)
@every 45s      every 45 seconds
@every 2d       every 2 days
```

Units are `s`, `m`, `h`, `d`, and they add up when combined. The minimum interval is one second. An interval is anchored when the trigger starts (or re-arms on edit) and counts forward from there — not from the top of the clock.

### Missed fires collapse

If the runtime was down across one or more scheduled times — a host reboot, a laptop asleep — it does **not** replay them on startup. Each schedule advances to its next future fire. Five missed daily standups become one upcoming standup, not five at once.

## Gating: `check`

A `check` is a command run just before the message would be sent. The message goes out only if the check exits `0`; any non-zero exit skips this fire silently. The convention is the shell's: `0` means "condition holds, send", like `test` or `grep -q`.

```
send_to_peer(timer, {
  "when": "*/10 * * * *",
  "check": "/usr/local/bin/queue-nonempty",
  "message": "The work queue has items waiting",
  "target": "ops"
})
```

The check is fail-safe: if the command can't be found, isn't executable, times out, or is killed by a signal, the fire is **skipped**, never sent, and the failure is logged loudly. A broken gate never produces a false alarm. The check has a 30-second timeout so a hung gate can't wedge the schedule.

## Fields

| Field | Required | Meaning |
|-------|----------|---------|
| `when` | yes | cron expression or `@every` interval |
| `message` | yes | the text delivered to the target (`msg` is accepted as an alias) |
| `target` | yes | the peer to message, or `"self"` for the registering peer |
| `check` | no | a command; fire only if it exits `0` |
| `id` | no | a stable name for the trigger; omit and one is derived from the content |
| `topic` | no | a short label carried on the signal (≤200 chars) |
| `fallback` | no | escalation peer(s) if the target can't be reached — see [06 — Escalation](06-escalation.md) |

The `message` is delivered into a **new session** at the target. Write it to stand on its own — the receiving peer won't have the context you had when you registered the trigger.

## Editing and removing

Re-register with the same `id` to replace a trigger in place. A timer whose `when` is unchanged keeps its place in the schedule; change the `when` and it re-arms from now. List and remove:

```
send_to_peer(timer, {"cmd": "list"})
send_to_peer(timer, {"cmd": "unregister", "id": "daily-standup"})
```

See [05 — Registering triggers](05-registering-triggers.md) for the full message format and ownership rules.
