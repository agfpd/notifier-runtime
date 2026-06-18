# 06 — Escalation

[Русский](ru/06-эскалация.md) · **English**

A scheduled message or a watcher alert is only useful if it actually arrives. A target peer may be asleep, slow to wake, or unreachable at the moment a signal fires. So delivery is not fire-and-forget: every signal is retried and escalated down a chain, and a signal that can't be delivered anywhere is preserved on disk rather than dropped.

The contract is *at-least-once*, and "delivered to someone alive" beats "delivered exactly to the target". A duplicate alert is better than a lost one.

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

If every link is exhausted, the signal becomes a loud `delivery-lost` and is written to a durable **dead-letter file**. It is not retried again automatically — but it stays on disk for an operator to find. Nothing is dropped silently.

## Surviving a restart: the write-ahead spool

A signal is written to a durable spool *before* delivery is attempted, so a crash or a restart mid-chain can't strand it. Each peer has its own spool directory:

```
<IAPEER_ROOT>/state/notifier/<personality>/escalation/
```

`timer` and `watcher` are separate processes with separate spools, so neither drains the other's queue. Each pending signal is one file recording its chain and every attempt so far. When the runtime starts, it re-drains the spool: any signal that was in flight when the previous process died is picked up and its chain continued from where it left off.

## Delivery transport

A single delivery is one `iapeer send` to the recipient, with the message piped in. Each attempt has a hard **120-second** timeout — generous, because a cold wake-on-miss legitimately takes tens of seconds — after which the attempt is killed and counts as a failure. Deliveries to the same recipient are serialized (one in flight at a time); different recipients proceed in parallel.

## The fixed numbers

| Value | Setting |
|-------|---------|
| Attempts per link | 2 (one try + one retry) |
| Delay between attempts on a link | 30 seconds |
| Hard timeout per delivery attempt | 120 seconds |
| Global backstop | `NOTIFIER_FALLBACK_TARGET` (empty by default) |

Only the backstop is configurable; the attempt and timeout values are fixed policy. See [08 — Configuration](08-configuration.md).
