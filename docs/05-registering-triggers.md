# 05 — Registering triggers

[Русский](ru/05-регистрация-триггеров.md) · **English**

A peer agent registers, lists, and removes triggers by sending the `timer` or `watcher` peer one IAP message — a `send_to_peer` tool call with a JSON body. These are programmatic calls an agent makes on its own behalf; a person in a chat sends only text and can't make a structured tool call. The message body is JSON. This page is the full contract behind [03 — Timer](03-timer.md) and [04 — Watcher](04-watcher.md).

## The four commands

The body's `cmd` field picks the command. Omit `cmd` and the body *is* a trigger config — `register` is the default.

| Body | Command |
|------|---------|
| a trigger config, or `{"cmd": "register", …}` | register (add or replace) |
| `{"cmd": "list"}` | list your triggers |
| `{"cmd": "unregister", "id": "<id>"}` | remove one of your triggers |
| `{"cmd": "help"}`, or a bare `help` / `?` | show the format and your active triggers |

Every command replies. Register confirms the trigger and lists the active ones; list and help show them with a removal hint; unregister confirms or tells you nothing matched.

In practice an agent rarely needs this page: send the peer `help`, `?`, or anything it can't parse, and it replies with this same format, the examples below, and the asker's active triggers — the peer documents itself. The short form of that self-doc also rides into every agent's system prompt through the registry, so an agent knows the call without asking at all (see [01 — Overview](01-overview.md)).

## Register

A register body carries the trigger config — timer fields (see [03](03-timer.md)) or watcher fields (see [04](04-watcher.md)) depending on which peer you send to. Examples:

```
send_to_peer(timer, {"id": "daily-standup", "when": "0 9 * * *", "message": "Daily standup", "target": "self"})

send_to_peer(timer, {"id": "heartbeat", "when": "@every 30m", "message": "still alive", "target": "ops", "fallback": "oncall", "topic": "health"})

send_to_peer(watcher, {"id": "disk-watch", "script": "monitor-disk", "target": "ops", "heartbeatSec": 60, "topic": "infra"})
```

### `id` and replace

`id` is the trigger's stable handle — the name you use to edit or remove it. Choose one, or omit it and the runtime derives a stable id from the trigger's content (prefixed `time-` or `event-`). Re-registering with an existing `id` **replaces** that trigger in place; you don't unregister first to edit.

### `target` and `self`

`target` is the peer the signal goes to. The literal `"self"` resolves to the peer that registered the trigger — convenient for a peer scheduling its own reminders or watching on its own behalf.

## Ownership and isolation

The owner of a trigger is the peer that sent the registration — its `from-personality`. This is a security boundary, not a convenience:

- A trigger is written **only into the owner's own profile**. A peer cannot register a trigger into another peer's profile.
- `list` and `unregister` see **only the requester's own** triggers. A peer can't enumerate or remove another peer's triggers.
- Commands are scoped to the peer's role: `timer` sees only TIME triggers, `watcher` sees only EVENT triggers — even if an id collides across roles.

The requester must already be in the iapeer peer registry. If it isn't, the reply tells you to run IAP from that peer's working directory once so it registers, then retry.

## Teaching replies

A malformed body never fails silently. The reply states what's wrong, then includes the full format and worked examples — enough to fix it from the reply alone:

```
notifier-timer: missing "when" (cron or @every <duration>)

notifier-timer — schedule-based trigger registration (TIME).
…
Examples:
  {"id":"daily-standup","when":"0 9 * * *","message":"Daily standup","target":"self"}
  …
```

Validation is format-only: the JSON must parse, required fields must be present, a timer's `when` must parse, a watcher's `script` path (when it looks like a path) must exist and be executable, `target` must be `"self"` or a valid peer name. The runtime never runs your script or your schedule to validate it.

## Live reload — no restart

A registration takes effect immediately. The runtime re-reads the trigger set and diffs it into the running engine, keyed on owner + id:

- A new trigger is armed at once.
- A removed trigger is dropped.
- A surviving trigger keeps its state — a timer with an unchanged `when` keeps its place in the schedule; a watcher with unchanged config keeps running. Only what actually changed is re-armed or restarted.

You never restart the runtime to pick up a trigger change.

## Where triggers live

A trigger is stored in the owner's peer profile at `<peer-cwd>/.iapeer/peer-profile.json`, under `notifier.triggers[]`. The runtime finds peer profiles through the iapeer registry (`~/.iapeer/peers-profiles.json`). Writes are atomic (write-to-temp, rename) and preserve any other fields in the profile. You can read these files, but you don't need to edit them by hand — registration is the supported path.

## Message envelope

Registrations ride the standard IAP envelope — the same `<iap from-personality="…" …><message>…</message></iap>` wrapper every peer message uses. The sending agent doesn't construct it; `send_to_peer` does. The runtime parses the envelope, reads the JSON body, and dispatches the command. A malformed envelope is logged and dropped without disturbing the next one.
