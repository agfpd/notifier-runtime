# 02 — Quick start

[Русский](ru/02-быстрый-старт.md) · **English**

This walks you from an installed iapeer host to a live trigger that fires. You need iapeer already set up (run `iapeer onboard` first if not).

## 1. Install the runtime

Install the package and let iapeer provision its peers:

```sh
npx -y @agfpd/notifier-runtime    # self-install: bin on PATH + runtime manifest
iapeer install-runtime notifier   # iapeer reads the manifest, provisions timer + watcher
```

The first command places a self-contained launcher on your `PATH` and writes the runtime manifest. The second hands the manifest to iapeer, which provisions the `timer` and `watcher` peers, writes their launchd jobs, and starts them. You now have two new peers in the registry.

## 2. Register a trigger

Registration is a tool call a peer agent makes — `send_to_peer` with a JSON body. A person in a chat sends only text; a structured call like this is something an agent does on its own behalf. From a peer:

```
send_to_peer(timer, {"when": "@every 1m", "message": "tick", "target": "self"})
```

The peer gets a reply confirming the trigger and listing its active ones. `target: "self"` routes the signal back to the peer that registered it — so a minute from now, that peer receives a `tick` message in a fresh session.

Schedule a daily message instead:

```
send_to_peer(timer, {"when": "0 9 * * *", "message": "Time for the daily standup", "target": "self"})
```

Or have a `watcher` forward a log match:

```
send_to_peer(watcher, {"script": "tail -F /var/log/app.log | grep ERROR", "target": "self"})
```

Every line the script prints to stdout arrives at `self` as its own signal.

## 3. Check what's registered

Ask a peer for its triggers at any time:

```
send_to_peer(timer, {"cmd": "list"})
```

Or validate the whole projection from the shell, across both peers:

```sh
notifier-runtime doctor          # human-readable
notifier-runtime doctor --json   # machine-readable
```

`doctor` shows every trigger, whether it parses, and — for timers — the next fire time.

## 4. Remove a trigger

```
send_to_peer(timer, {"cmd": "unregister", "id": "<id>"})
```

The `id` is the one in the registration reply (or the `id` you chose). Re-registering the same `id` *replaces* the trigger; you don't need to unregister first to edit it.

## What's next

- The message lands in a **new session** — write it to stand on its own, with no reference to context the receiving peer won't have.
- A trigger belongs to the peer that registered it. A peer can only list, edit, and remove its own. See [05 — Registering triggers](05-registering-triggers.md).
- Tune the schedule in [03 — Timer](03-timer.md); tune the watcher in [04 — Watcher](04-watcher.md).
