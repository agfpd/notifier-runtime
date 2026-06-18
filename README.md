# notifier-runtime

**Scheduled messages and event signals for a team of AI agents — the time component of [iapeer](https://github.com/agfpd/iapeer).**

[![CI](https://github.com/agfpd/notifier-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/agfpd/notifier-runtime/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agfpd/notifier-runtime)](https://www.npmjs.com/package/@agfpd/notifier-runtime)
[![license](https://img.shields.io/npm/l/@agfpd/notifier-runtime)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#quick-start)

notifier-runtime is what fires in an [iapeer](https://github.com/agfpd/iapeer) team when nobody asked — a daily message at 9:00, a heartbeat every 30 minutes, an alert the moment a log line matches. It carries two peers: `timer` sends a message on a schedule, `watcher` turns a long-lived script's output into signals. A peer registers a trigger with one IAP message; the runtime fires it, retries delivery, and escalates a signal it can't deliver rather than dropping it.

> **Built for iapeer.** It isn't a standalone scheduler — it runs only inside [iapeer](https://github.com/agfpd/iapeer), alongside `iapeer-memory`. It's a plug-in runtime, the same kind as `telegram-runtime`, that iapeer provisions and launches and whose signals travel over iapeer's own messaging.

## How it works

```text
   a peer registers a trigger            the trigger fires
   send_to_peer(timer, {…})              on schedule / on a script line
        │                                     │
        ▼                                     ▼
   ┌──────────────────────────────────────────────────┐
   │  notifier  ──  timer (cron / @every + check)      │
   │            └─  watcher (script → signal per line) │
   └──────────────────────────────────────────────────┘
        │
        ▼
   deliver with retry + escalation
   target → fallback → owner → backstop      (never silently dropped)
```

## Quick start

You need an iapeer host (run `iapeer onboard` first if needed).

```sh
npx -y @agfpd/notifier-runtime    # self-install: launcher on PATH + manifest
iapeer install-runtime notifier   # iapeer provisions the timer + watcher peers
```

Register a trigger from any peer:

```
send_to_peer(timer, {"when": "0 9 * * *", "message": "Daily standup", "target": "self"})
send_to_peer(watcher, {"script": "tail -F /var/log/app.log | grep ERROR", "target": "self"})
```

Check what's registered:

```sh
notifier-runtime doctor
```

## What makes it different

- **Two primitives, one runtime.** `timer` for time (cron and intervals, with a check-gate), `watcher` for events (a script's output, with hang detection) — both provisioned and launched by iapeer.
- **Registration is a message.** A peer schedules itself by sending one JSON body; the trigger is picked up live, with no restart, and stored in that peer's own profile.
- **Owned and isolated.** A trigger belongs to the peer that registered it. A peer can only list, edit, and remove its own — a security boundary, not a convention.
- **Nothing is dropped silently.** An undelivered signal is retried and escalated down a chain — fallback, owner, backstop — and a signal that can't reach anyone is written to a durable dead-letter file, not lost.
- **Crash-safe.** Signals are written to a write-ahead spool before delivery, so a restart mid-chain re-drains them instead of stranding them.
- **Self-correcting input.** A malformed registration replies with the exact problem plus the format and worked examples, so the sender fixes it from the reply alone.

## Documentation

[`docs/`](docs/README.md) — what it is and how to use it (English; Russian in [`docs/ru/`](docs/ru/README.md)). This repository is the implementation.

## License

Apache-2.0. Platform: macOS. notifier-runtime is the time-primitive runtime for the [iapeer](https://github.com/agfpd/iapeer) ecosystem — a component of iapeer, not a standalone system.
