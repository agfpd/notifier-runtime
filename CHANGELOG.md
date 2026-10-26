# Changelog

All notable changes to **notifier-runtime** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.3] - 2026-10-26

### Fixed

- **Timer check preflight:** registration now rejects a `check` that cannot resolve to an executable regular file in timer's cwd/PATH. Rejected add/replace writes nothing and does not reload the engine; an existing trigger is preserved. This inspects filesystem metadata and execute permission, never runs the gate.
- **Explicit check contract:** one literal executable name, no arguments or shell syntax. Paths with spaces, symlinks, relative paths and resolvable bare names remain supported. Help, registry blurb and EN/RU docs explain wrapper scripts, timer's environment and the limits of preflight. Existing stored triggers and fail-closed execution semantics are unchanged.
- Tests cover the reported shell-expression failure, missing/non-executable/directory/dangling paths, literal spaces/metacharacters, PATH resolution, no registration-time side effects, rejected replacement preservation and post-registration disappearance.

## [0.5.2] - 2026-10-22

### Fixed

- **Watcher same-id replace was a silent no-op when the script text was
  unchanged** (walt-trader, 22.10.2026). `Supervisor.reload` skipped any key
  whose config was equal (`sameConfig`), so re-registering the same script
  after editing the code it runs left the old process running, while the reply
  claimed "old script stopped, new config streaming". A register now always
  restarts its own `owner:id` (`reload(..., { restart: [key] })`); reloads
  caused by other owners' registrations still leave unchanged watchers alone.
- **Replace could overlap old and new script.** The new script was spawned
  right after SIGTERM to the old one, and a script that ignored or delayed
  SIGTERM lived on next to it. Now, for each `owner:id`, the replacement starts
  only after the previous process exits. SIGTERM goes to the whole tree first,
  then after 3 s SIGKILL goes to the tree, including descendants already
  reparented to pid 1 (remembered from the SIGTERM snapshot). If even that exit
  is never observed within 2 s, the new script is started anyway and
  `watcher-stop-unconfirmed` is logged. Several replaces in a row while the old
  process is dying start exactly one new process, running the latest config.
  An unregister in that window starts none.
- Replace reply text now describes what actually happens.

## [0.5.1] - 2026-10-17

### Fixed

- **Watcher echo loop** (flood-stops 26.08, 29.09, 06.10, 16.10.2026). A
  watcher tailing the iapeer delivery log read back the log lines of its OWN
  deliveries (`caller=notifier-watcher to=<T> ok=…`) and forwarded them again;
  with an offline target every link of the escalation chain echoed, so per-target
  `grep -v` filters in the script did not close the class. New `EchoGuard`
  (`echoGuard.ts`) wraps every outbound transport of the process (escalation,
  lost-digest, registration replies) and records sends per recipient; a watcher
  line carrying both the own identity token and a recipient sent to now or
  ≤ 60 s ago is dropped before the flood counter (`echo-suppressed`), while still
  counting as a sign of life for health and heartbeat. Stand (tail -F | grep
  ok=false, all targets offline): before — 37 lines in 2.5 s and a flood-stop;
  after — seed + one line per chain link, one `delivery-lost`, no flood.
- **Orphaned pipeline stages on watcher kill.** `kill()` signalled only
  `/bin/sh -c`; `tail`/`grep` stages reparented to pid 1 and lived on, and the
  last stage kept stdout open, so the watcher's exit (and with it restart
  logic) never fired. `kill()` now snapshots the descendant tree (`ps`) before
  signalling and kills root then every descendant. Covers unregister, same-id
  replace, heartbeat restart, flood/crashloop trip and shutdown. No detached
  process group — launchd still reaps children if the notifier dies.

## [0.5.0] - 2026-10-17

Incident 26.08–17.10.2026: 2335 timer fires became dead-letters over seven
weeks and nobody noticed — a chain with a link that could never be delivered
(`fallback: arthur` from a sender without a telegram face) was accepted
silently, and status `lost` surfaced nowhere but a log line and a file.

### Added

- **Static reachability check of the chain** (`reachability.ts`). From the
  peer registry: a human peer while the sender has no telegram face, or a
  model-less program peer (`intelligence: absent`), can never be delivered.
  - Registration **refuses** such a `target`/`fallback` loudly (reply names the
    link, the reason and telegram-faced relays to use); nothing is written. A
    link missing from the registry is accepted with a ⚠ warning in the reply.
  - At runtime such a link is **skipped** (`link-skipped`, attempt recorded as
    `skipped: <reason>`, no send, no retry delay); on start/reload the owner of
    each affected trigger gets one `notifier-dead-link` alert per process.
- **Lost-digest** (`lostReport.ts`): 60 s after start and every 10 min, all
  unreported dead-letters are folded into ONE digest grouped by trigger and sent
  to a telegram-faced relay agent asked to tell the human and the owners
  (`NOTIFIER_ALARM_RELAYS`, default backstop + telegram-faced agents, ≤3 per
  pass). Entries are marked `reportedAt` only after a relay accepted; until
  then every pass retries. Sent directly, not through the escalator.
- Timer fire `meta` now carries the trigger `id` (log attribution + digest
  grouping; coalescing key becomes per-trigger).

## [0.4.1] - 2026-10-06

### Fixed

- macOS self-install now strictly verifies the staged executable with
  `/usr/bin/codesign --verify --deep --strict` before replacing the installed
  binary or writing its manifest, on both compile and copy-self paths. A valid
  signature is preserved; invalid/unsigned code is repaired with
  `--force --sign -` and must pass a second strict verification. Failed repair,
  verification, or command execution aborts with the old binary and manifest
  untouched. Temporary output is removed instead of renamed to `.dead`.
- Signature commands are bounded to 30 seconds and use the absolute system
  codesign path. Install output reports `valid`, `repaired`, or `skipped`.

### Added

- Sandbox tests for real compile/execute and compiled CLI copy-self, strict
  signature preservation, post-sign corruption rejection, and mock failure/order
  cases (including timeout, signal, launch error, and unsuccessful reverify).

## [0.4.0] - 2026-07-17

Storm-proof escalation. Live incident 2026-07-17 17:40–17:45Z: a watcher
tailing the iapeer delivery log for failure lines, targeting a peer that was
itself undeliverable (stopped), looped on its own failed deliveries — every
failed attempt wrote a new failure line into the tailed log (gain 2), the
per-target lane saturated at ~9 signals/s, the spool accumulated 460+ entries
in ~2 minutes, and the fallback recipient was hammered with ~400 near-identical
escalations. The 0.2.0 per-signal retry delay (30s) could not help: it spaces
the attempts of ONE signal, while a storm is many signals back-to-back.

### Added

- **Per-watcher flood breaker** (content-agnostic — storm lines usually differ
  in timestamps, so only the line RATE identifies a feedback loop): reaching
  30 forwarded lines inside a sliding 10s window trips the breaker — the
  watcher is stopped like a crashloop trip (child killed, no restart until
  re-register or daemon restart), its queued undelivered forwards are cancelled
  in the spool, and ONE escalating owner alert reports both counts. The tripping
  line itself is not forwarded (it is storm, not signal).
- **In-flight coalescing**: a signal byte-identical to one still in flight
  (same kind/owner/trigger/target/topic/message) starts no second chain — it
  bumps the in-flight entry's `coalesced` counter behind a `signal-coalesced`
  log line. Success logs and fallback wrappers carry the counter, so the
  recipient/operator sees the storm size. Once the chain settles, the same body
  is a fresh legitimate signal again.
- **Re-drain merge**: byte-identical pending duplicates in the spool are merged
  at start() (first runs, the rest fold into its counter and leave the spool) —
  a restart right after a storm no longer re-detonates it from disk.
- Spool status `"flooded"`: breaker-cancelled signals become durable
  dead-letters — never re-drained, never silently dropped (loud
  `escalation-cancelled` log + the file stays for the operator).

### Changed

- The `floodObserve` no-op seam in the Supervisor is replaced by the real flood
  breaker (the spec change the seam was reserved for). `SupervisorDeps` gains
  `cancelForwards(watcherId)` — the breaker's cancel seam into the Escalator's
  new `cancelPending(predicate)`.

## [0.3.6] - 2026-07-14

### Fixed

- Envelope parser synced with the iapeer core codec (0.4.86 canon), fixing
  inherited bug classes the core had long fixed (В37/В38 lineage):
  - The streaming extractor located `</iap>` with a naive `indexOf` — an
    envelope whose CDATA body quotes `</iap>` (e.g. a timer message or watcher
    script citing an envelope example) was silently truncated, leaving a
    garbage tail in the buffer. The close tag is now located CDATA-aware.
  - Tag content used a lazy regex — a quoted `</message>` inside the CDATA body
    truncated the message, and a quoted `<attachments>…</attachments>` minted
    phantom attachments. Now a CDATA-aware scan of both the open and close tag,
    concatenating CDATA sections (which also reconstructs a literal `]]>`).
  - Attribute lookup was unanchored — `runtime="` matched the tail of
    `from-runtime="…"` (coincidentally correct, structurally a mine). Lookups
    are now name-anchored (`(?:^|\s)`).
  - A false `<iap ` start in prose (В38) no longer swallows a following real
    envelope or parks the buffer forever: the open tag is validated first
    (bounded at 1 KiB), and an undecodable candidate resyncs one char forward.

### Added

- Read-both envelope decode (envelope-compaction F): the compact presentation
  names (`from` / `runtime` / `intelligence`, `<msg>`) are accepted alongside
  the legacy wire names, short names winning when both are present, and the
  additive `ts` attribute decodes to `sentAt`. A future wire flip to the short
  names costs the notifier nothing.

## [0.3.5] - 2026-07-10

### Fixed

- Registry description truncated mid-word. The self-config hook wrote the
  multi-line `describeFormat` (~1 KB) into the local profile's `description`
  field — the exact field the foundation projects into the shared registry,
  clamped to 450 chars. The clamp cut the timer blurb mid-sentence
  (`… • message arrives `) and silently dropped the tail of the watcher blurb
  (target / heartbeatSec / fallback / examples). The hook now writes the ≤450
  single-line `PEER_BLURB` — the same string the manifest declares — so the
  projected registry entry is always complete. The rich multi-line format doc
  stays the live `help` / teaching reply (unchanged); the blurb points to it.

## [0.3.4] - 2026-06-20

### Changed

- Envelope `from-intelligence` parsing migrated to the current IAP vocabulary
  (`natural` / `artificial` / `absent`). The legacy values `human` / `scripted`
  are no longer accepted — the foundation normalizes any legacy value upstream,
  so only the current vocabulary reaches the runtime.

## [0.3.3] - 2026-06-20

### Removed

- The `prepare` and `install` CLI aliases — use `self-config` and `self-install`.
- The `msg` field alias in trigger registration — use `message`.

## [0.3.2] - 2026-06-20

### Removed

- The bare-CR `\r`-fold in the envelope parser, retired with the fleet-wide
  pty-only delivery migration. No behavior change on pty (LF) input.

## [0.3.1] - 2026-06-20

### Changed

- Internal cleanup: removed proven-dead code, demoted over-exported internals to
  file-local, and applied behavior-preserving refactors. The package description
  now names both primitives, and a `self-config` npm script was added.

## [0.3.0] - 2026-06-18

### Added

- On-host documentation: each install copies the package docs to a stable,
  version-matched per-host path so they are readable offline (FU6).
- A continuous-integration workflow and a unified badge row (FU10).

### Changed

- Clearer `timer` / `watcher` registry descriptions (FU8).

### Fixed

- Exclude `.DS_Store` from the on-host docs copy.

## [0.2.2] - 2026-06-18

### Fixed

- Suppress the registration reply to ephemeral (FaaS) registrants — for such a
  peer every delivered message spawns a fresh worker session, so a reply would
  spawn a spurious one. The registration still writes state and reloads live;
  only the wire ack is dropped.

## [0.2.1] - 2026-06-18

### Fixed

- Ship `docs/` in the npm tarball.

## [0.2.0] - 2026-06-18

First public release — the time component of iapeer. Two peers on one runtime:
`timer` (cron and `@every` schedules with an optional check-gate) and `watcher`
(a long-lived script whose output becomes signals, with hang detection).

### Added

- Registration-by-message: a peer schedules itself with a single IAP body; the
  trigger is picked up live (no restart) and stored in that peer's own profile,
  which it alone can list, edit, and remove.
- Delivery escalation: an undelivered signal is retried and escalated down a
  chain (target → fallback → owner → backstop), persisted to a write-ahead spool
  and written to a durable dead-letter if it reaches no one — never silently
  dropped.
- npx self-install and a per-peer self-config hook (the package side of the
  iapeer runtime contract).

## 0.1.0 – 0.1.4 - pre-public-release

Pre-public iterations on npm during initial development: the `timer` scheduler
and `watcher` supervisor primitives, registration-by-message, live same-id
replace (0.1.2), outgoing-delivery log attribution (0.1.3), and the manifest
version stamp that drives the foundation's update gate (0.1.4). Consolidated into
the first public release, 0.2.0.

[0.3.5]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.5
[0.3.4]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.4
[0.3.3]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.3
[0.3.2]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.2
[0.3.1]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.0
[0.2.2]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.2.0
