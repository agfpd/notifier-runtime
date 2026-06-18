# 01 — Overview

[Русский](ru/01-обзор.md) · **English**

notifier-runtime is the part of an [iapeer](https://github.com/agfpd/iapeer) team that knows about time and events. Agents talk to each other on demand; the notifier is what fires when nobody asked — a daily message at 9:00, a heartbeat every 30 minutes, an alert the moment a log line matches. It runs as an always-on background runtime and carries two peers.

## The two peers

**`timer`** — the TIME primitive. It sends a message on a schedule: a 5-field cron expression (`0 9 * * *`) or an interval (`@every 30m`). Optionally it gates the message behind a check command, so the message goes out only when a condition holds.

**`watcher`** — the EVENT primitive. It runs a long-lived script and forwards each non-empty line the script prints as a signal to a peer. The line *is* the payload. If the script goes silent past a heartbeat you declared, the watcher kills and restarts it and alerts you — a hung monitor doesn't stay quietly dead.

Both peers run on one runtime named `notifier`, giving them the IAP identities `notifier-timer` and `notifier-watcher`. You never start them by hand: iapeer provisions them and launchd keeps them running.

## How you use it

You don't configure the notifier through files you edit. Instead, a peer *agent* registers a trigger with a tool call — `send_to_peer` with a structured body:

```
send_to_peer(timer, {"when": "0 9 * * *", "message": "Collect statuses", "target": "self"})
```

This is a programmatic tool call an agent makes, not text a person types in a chat — only an agent peer can call a tool with structured arguments. The runtime stores the trigger in the requesting peer's own profile, picks it up live (no restart), and from then on fires it on schedule. The signal arrives at the target peer as a normal message — and because it lands in a fresh session, the registering agent writes it to stand on its own. See [02 — Quick start](02-quickstart.md).

## Agents already know the API

`timer` and `watcher` are ordinary peers in the iapeer registry — not special machinery bolted on the side. Like every peer, each carries a description, and that description rides into every agent's system prompt: what the peer is, how to call it, the JSON fields, an example. So an agent knows how to register a trigger out of the box — it doesn't read these docs first.

And when it needs more, an agent just asks the peer. Send `help` (or `?`, or anything the peer can't parse) and it replies with its full format and the asker's active triggers; send `{"cmd": "list"}` and it lists them. The peer documents itself: the registry teaches the call, the peer fills in the detail on request. Nobody memorizes an API — the service that owns it explains itself. (This is why the actor is an agent: the agent already carries the call in its prompt; a person in a chat does not.)

A scheduled message or a watcher alert is worth little if it vanishes when the target peer happens to be asleep or slow to wake. So delivery is not fire-and-forget. Every signal is retried, and if the target stays unreachable it escalates down a chain — to your declared fallback peer, then to you (the trigger's owner), then to a global backstop if the operator set one. A signal is dropped only after the whole chain is exhausted, and even then it's written to a durable dead-letter file, not silently lost. See [06 — Escalation](06-escalation.md).

## Where it sits in iapeer

notifier-runtime is a *runtime-router* package — the same kind of plug-in runtime as `telegram-runtime`, but for time and events instead of a chat surface. iapeer owns provisioning (the peer registry, the launchd jobs, the boot sequence); the package owns its own install, its peer declarations, and the trigger logic. When you run `iapeer install-runtime notifier`, iapeer reads the package's manifest and provisions `timer` and `watcher` for you.

The runtime requires iapeer — it isn't a standalone scheduler. It reaches peers through iapeer's messaging (`iapeer send`) and is launched by iapeer's foundation. See [09 — Architecture](09-architecture.md).

## Next

- [02 — Quick start](02-quickstart.md) — install and register a first trigger.
- [03 — Timer](03-timer.md) and [04 — Watcher](04-watcher.md) — the two peers in full.
