# Changelog

All notable changes to **notifier-runtime** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
