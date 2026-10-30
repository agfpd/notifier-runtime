# 06 — Escalation

[Русский](ru/06-эскалация.md) · **English**

A scheduled message or a watcher alert is only useful if it actually arrives. A target peer may be asleep, slow to wake, or unreachable at the moment a signal fires. So delivery is not fire-and-forget: every signal is retried and escalated down a chain, and a signal that can't be delivered anywhere is preserved on disk rather than dropped.

An explicit refusal advances the delivery chain. Unknown native acceptance does not: replay could duplicate a task that already started. A native delivery receipt proves input acceptance, not task completion or exactly-once external effects.

## The chain

Each signal carries an ordered chain of recipients:

```
target  →  your fallback peer(s)  →  you (the trigger owner)  →  global backstop
```

The runtime tries each link in turn. On a link it makes **two attempts** (one immediate, one retry **30 seconds** later); if both fail, it moves to the next link. The first link that accepts the signal ends the chain — the signal is delivered and removed from the queue.

- **target** — where you addressed the signal.
- **fallback** — the peer(s) you declared in the trigger's `fallback` field. One name or a list; tried in order.
- **owner** — the peer that registered the trigger. Always in the chain, so a signal you scheduled comes back to you if its target can't be reached.
- **global backstop** — an optional final link the operator sets host-wide with `NOTIFIER_FALLBACK_TARGET` (for example a team-wide on-call peer). Empty by default, so on a fresh install the owner is the terminal link and no team-specific setup is needed.

Duplicate links are collapsed, so naming yourself as the fallback doesn't waste an attempt.

### Links that can never be delivered

Some links fail by construction, not by chance: a **human** peer (for example `arthur`) — iapeer delivers to a person only over a telegram face, and `timer`/`watcher` have none — and a **program peer with no model** (`intelligence: absent`, such as `timer` or `watcher` themselves). No retry fixes them.

- **At registration** such a `target` or `fallback` is **refused** with a reply that names the link, the reason, and telegram-faced agents to use as a relay instead. Nothing is written. A link missing from the peer registry is accepted with a ⚠ warning in the reply.
- **At runtime** (triggers registered before this check, hand-edited profiles) the link is **skipped** — recorded in the attempt history as `skipped: <reason>`, no send, no retry delay — and the owner gets **one** alert per trigger and link, naming the shortened chain, after each runtime start.

### Declaring a fallback

```
send_to_peer(timer, {
  "when": "@every 30m",
  "message": "still alive",
  "target": "ops",
  "fallback": "oncall"
})
```

If `ops` can't be reached after retries, the heartbeat goes to `oncall`, then back to you. `fallback` accepts `"self"` too, resolved to the owner like `target`.

## When the whole chain fails

If every link is exhausted, the signal becomes a loud `delivery-lost` and is written to a durable **dead-letter file**. It is not retried again automatically — but it stays on disk, and it is **surfaced**:

- **Lost-digest.** About a minute after start, and then every 10 minutes, the runtime gathers every dead-letter not yet reported and sends **one** digest — grouped by trigger, with counts, first/last time and the last error — to a **relay**: a telegram-faced agent asked to tell the human and the owners. Relays are `NOTIFIER_ALARM_RELAYS` if set, otherwise the global backstop followed by the telegram-faced agents in the registry; at most 3 are tried per pass, one attempt each.
- A dead-letter is marked `reportedAt` only once a relay accepted the digest. While no relay can be reached, every pass retries — an outage delays the digest, never drops it. The digest is sent directly, not through the escalation chain, so it can't feed the loop it reports on.

Worst case from a fire to the digest: chain exhaustion (minutes) plus one 10-minute interval.

## Storm protection

At-least-once must not turn a delivery failure into a signal *generator*. Two mechanisms keep a storm from feeding on itself:

- **Coalescing.** A signal byte-identical to one still in flight (same kind, trigger, target, topic, and message) does not start a second chain — it folds onto the in-flight signal as a counter. The delivered message and the logs carry the count, so the recipient sees "this arrived, plus N identical copies while it was queued" instead of N separate messages. Once the chain settles, the same body counts as a fresh signal again. The same merge runs over the spool at startup, so a restart right after a storm doesn't re-detonate it from disk.
- **Watcher flood breaker.** A watcher forwarding **30 lines within 10 seconds** is a feedback loop or a broken source, not an alarm feed. The breaker stops the watcher (like a crashloop trip — no restart until it's re-registered or the daemon restarts), cancels its queued undelivered forwards, and sends the owner **one** escalating alert with both counts. Cancelled signals become dead-letter files with status `flooded` — preserved on disk, never re-sent. The breaker is deliberately rate-based, not content-based: storm lines usually differ (timestamps), so only the rate identifies them.

## Surviving a restart: the write-ahead spool

A signal is written to a durable spool *before* delivery is attempted, so a crash or a restart mid-chain can't strand it. Each peer has its own spool directory:

```
<IAPEER_ROOT>/state/notifier/<personality>/escalation/
```

`timer` and `watcher` are separate processes with separate spools, so neither drains the other's queue. Each pending signal is one file recording its chain and every attempt so far. When the runtime starts, it re-drains the spool: any signal that was in flight when the previous process died is picked up and its chain continued from where it left off.

### Pending native acceptance

Before launching a send, the spool records `submitting` plus the chain cursor. A CLI `pending acceptance <deliveryId>` acknowledgement changes that to `pending`, retaining trigger owner/id, payload and chain. It is custody, not success: there are no retries or task fallbacks while acceptance is unknown.

Only `core/iapeer-system` events on topic `delivery-acceptance` resolve custody. The event inbox is written under `<IAPEER_ROOT>/state/notifier/<personality>/acceptance-events/` before consumption, so an event arriving before the CLI response or a notifier restart is retained. Correlation uses the exact deliveryId and recipient, not the current trigger configuration (which may already have changed).

- `delivered`: remove the signal without another send.
- `failed`: a proven pre-paste refusal; advance once to the next link of the stored trigger chain.
- `unresolved`: retain custody and send a separate `notifier-unresolved` informational alert to the trigger owner, with trigger id, signal id and deliveryId. It does not contain or delegate the original task. The informational alert uses owner → backstop if needed; the original task never enters its fallback chain. Late delivered evidence still resolves custody.

The same uncertainty rule covers a killed CLI, an unfamiliar acknowledgement, or restart during `submitting` before the deliveryId was received. Without that id automatic correlation is unavailable; the owner gets the signal id for investigation, and the task is not replayed. A pending record lacking a final event for 180 seconds also becomes visibly unresolved, without taking ownership of core resolution. Core event receipts and the notification checkpoint survive notifier restart. Terminal event receipts are retained to reject duplicate/stale events.

## Delivery transport

A single delivery is one `iapeer send` to the recipient, with the message piped in. Each attempt has a hard **120-second** timeout — generous, because a cold wake-on-miss legitimately takes tens of seconds — after which the CLI is killed and acceptance is treated as unknown, not a proven refusal. Deliveries to the same recipient are serialized (one in flight at a time); different recipients proceed in parallel. A flood breaker cancels only forwards not yet on the wire: it cannot erase native custody.

## The fixed numbers

| Value | Setting |
|-------|---------|
| Attempts per link | 2 (one try + one retry) |
| Delay between attempts on a link | 30 seconds |
| Hard timeout per delivery attempt | 120 seconds |
| Global backstop | `NOTIFIER_FALLBACK_TARGET` (empty by default) |
| Lost-digest | first pass 60 s after start, then every 10 minutes; ≤ 3 relays per pass |
| Lost-digest relays | `NOTIFIER_ALARM_RELAYS` (default: backstop + telegram-faced agents) |

Only the backstop and the relays are configurable; the attempt and timeout values are fixed policy. See [08 — Configuration](08-configuration.md).
