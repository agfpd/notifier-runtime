# 04 — Watcher

[Русский](ru/04-watcher.md) · **English**

The `watcher` peer runs a long-lived script and turns its output into signals. Every non-empty line the script prints to stdout becomes one message to the target — the line *is* the payload. A peer agent registers it with a `send_to_peer` call carrying a `script` and a `target`.

```
send_to_peer(watcher, {"script": "tail -F /var/log/app.log | grep ERROR", "target": "self"})
```

Each matching line arrives at `self` as its own signal. A watcher is the right tool when "something happened" can't wait for a poll — a log match, a file appearing, a threshold crossed.

## How output becomes signals

The script is shell-invoked, so a full pipeline (`tail -F x | grep y`) is legal. The watcher reads stdout line by line:

- **Each non-empty line is forwarded verbatim** as a separate signal to the target. Trailing newlines and `\r` (CRLF) are stripped; blank lines are dropped.
- **Partial lines are buffered** until the script prints the rest. A final line without a trailing newline is flushed when the script exits.
- **stderr is logged, never forwarded.** Diagnostics on stderr stay in the runtime log and don't reach the target as signals.

So a script that wants to raise N alerts prints N lines; one that wants to stay quiet prints nothing.

## Restarts

A long-lived monitor is not supposed to exit. The watcher treats **any** exit as a failure — even a clean exit code `0` — and restarts the script, with exponential backoff so a script that dies instantly doesn't hammer the host:

```
1s → 2s → 4s → 8s → … capped at 60s
```

A run that lasts at least one second, or that prints at least one line, counts as healthy and resets the backoff. Backoff only accumulates for genuinely rapid death — sub-second respawns.

A spawn failure (the command doesn't exist, isn't executable) is handled like any other failure: it backs off and retries, and feeds the crash-loop breaker below.

## Crash-loop breaker

A hard-broken script — a typo on line one that exits instantly — would otherwise respawn forever. The breaker stops that: **5 failures within 60 seconds** trips it. When it trips, the watcher stops restarting, sends an alert to **you** (the trigger's owner), and logs loudly. The alert tells you which watcher gave up and why, so a broken monitor surfaces instead of churning in the background.

## Hang detection: `heartbeatSec`

Set `heartbeatSec` to catch a watcher that's alive but stuck — the process is up but has stopped producing output:

```
send_to_peer(watcher, {
  "script": "monitor-disk",
  "target": "ops",
  "heartbeatSec": 60
})
```

If the script goes silent longer than `heartbeatSec`, the watcher assumes a hang: it kills the process (SIGKILL), alerts the owner, and restarts it. The heartbeat timer is re-armed on every forwarded line, so a script that keeps producing output never trips it. Without `heartbeatSec`, silence is allowed indefinitely — correct for a watcher that's supposed to be quiet until something happens.

## Fields

| Field | Required | Meaning |
|-------|----------|---------|
| `script` | yes | a long-lived command; each non-empty stdout line is forwarded |
| `target` | yes | the peer to signal, or `"self"` for the registering peer |
| `heartbeatSec` | no | max silence before restart + alert (positive number) |
| `id` | no | a stable name; omit and one is derived from the content |
| `topic` | no | a short label carried on every signal (≤200 chars) |
| `fallback` | no | escalation peer(s) if the target can't be reached — see [06 — Escalation](06-escalation.md) |

Like timer messages, a watcher signal lands in a **new session** at the target. Keep each line self-contained — it should make sense on its own, since it arrives without the surrounding context.

## Editing and removing

Re-register with the same `id` to replace a watcher in place; the runtime restarts the script only if the `script`, `target`, `heartbeatSec`, `topic`, or `fallback` actually changed. Unchanged watchers keep running across a reload. List and remove:

```
send_to_peer(watcher, {"cmd": "list"})
send_to_peer(watcher, {"cmd": "unregister", "id": "error-watch"})
```

On shutdown, the runtime kills all watcher processes cleanly and does not respawn them. See [05 — Registering triggers](05-registering-triggers.md) for the full message format.
