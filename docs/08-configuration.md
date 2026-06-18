# 08 — Configuration

[Русский](ru/08-конфигурация.md) · **English**

notifier-runtime needs almost no configuration. One environment variable is meant for you to set; the rest are wired by iapeer's launcher or are fixed policy compiled into the runtime. This page lists all of them so nothing is a mystery.

## What you set

### `NOTIFIER_FALLBACK_TARGET`

The global escalation backstop — a final recipient appended to every signal's chain, after the trigger owner. Set it to a peer that should catch any signal the owner couldn't be reached for, for example a team-wide on-call peer.

- **Default:** empty. With no backstop, the owner is the terminal link, and a fresh install needs no team-specific setup.
- See [06 — Escalation](06-escalation.md).

## What iapeer sets

These come from the launch environment iapeer provides; you don't set them by hand, and changing them by hand is usually a mistake.

| Variable | Default | Meaning |
|----------|---------|---------|
| `IAPEER_ROOT` | `$HOME/.iapeer` | the iapeer state root — locates the runtime manifest and the escalation spool |
| `IAPEER_BIN_DIR` | `~/.local/bin` | where `self-install` places the launcher binary |
| `IAP_BIN` | `iapeer` | the command used to deliver signals (`<IAP_BIN> send …`) |
| `NOTIFIER_RUNTIME_BIN` | — | absolute path to the launcher, pinned by iapeer into the launchd job so the runtime resolves PATH-independently |
| `IAPEER_PEER_PERSONALITY` | — | the peer role being configured, read by `self-config` |
| `PEER_PERSONALITY` | `timer` | the personality the run-loop adopts; falls back to the local peer profile, then to `timer` |

`IAPEER_ROOT` overrides the state root everywhere — the manifest path (`<IAPEER_ROOT>/runtimes/notifier/runtime.json`) and the spool (`<IAPEER_ROOT>/state/notifier/<personality>/escalation/`) both derive from it.

## Fixed policy

These values are compiled into the runtime, not configurable. They're listed here so you know the behavior, not because you can change it.

### Timer

| Value | Setting |
|-------|---------|
| Check-gate timeout | 30 seconds — a hung check is skipped, fail-safe |
| Run-loop sleep cap | 60 seconds — periodic re-evaluation that picks up reloads and survives a clock jump |
| Cron search horizon | 4 years — an expression with no fire within it (e.g. Feb 30) is rejected as impossible |

### Watcher

| Value | Setting |
|-------|---------|
| Restart backoff | starts at 1 second, doubles, capped at 60 seconds |
| Healthy-run floor | 1 second — a run at least this long resets the backoff/failure streak |
| Crash-loop breaker | 5 failures within 60 seconds trips it; restarts stop, owner is alerted |

### Escalation

| Value | Setting |
|-------|---------|
| Attempts per chain link | 2 (one try + one retry) |
| Delay between attempts on a link | 30 seconds |
| Hard timeout per delivery attempt | 120 seconds |
| Topic length limit | 200 characters |

See [03 — Timer](03-timer.md), [04 — Watcher](04-watcher.md), and [06 — Escalation](06-escalation.md) for what these values do in context.
