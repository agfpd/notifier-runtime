# notifier-runtime

[Русский](ru/README.md) · **English**

notifier-runtime is the time presence of an [iapeer](https://github.com/agfpd/iapeer) agent team. It carries two peers — `timer`, which sends a message on a schedule, and `watcher`, which turns a long-lived script's output into signals. Any peer registers a trigger by sending it one IAP message; the runtime fires it, retries delivery, and escalates a signal that can't be delivered rather than dropping it.

This is the package documentation: what the runtime is, how to register triggers, and how it runs inside iapeer.

## Start here

- [01 — Overview](01-overview.md) — the two peers, where the runtime sits in iapeer.
- [02 — Quick start](02-quickstart.md) — install the runtime and register your first trigger.

## The two peers

- [03 — Timer](03-timer.md) — schedule a message with cron or an interval, gate it with a check.
- [04 — Watcher](04-watcher.md) — run a script and forward each output line as a signal, with hang detection.

## Reference

- [05 — Registering triggers](05-registering-triggers.md) — the message format, `list`/`unregister`, ownership, live reload.
- [06 — Escalation](06-escalation.md) — what happens when a signal can't be delivered.
- [07 — CLI](07-cli.md) — `self-install`, `run`, `self-config`, `doctor`.
- [08 — Configuration](08-configuration.md) — environment variables and the fixed policy values.
- [09 — Architecture](09-architecture.md) — identity, the manifest, and how iapeer provisions and launches the runtime.

## License

Apache-2.0. Platform: macOS. notifier-runtime is the time-primitive runtime for the [iapeer](https://github.com/agfpd/iapeer) ecosystem — a component of iapeer, not a standalone system.
