# Changelog

All notable changes to notifier-runtime are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.4] — 2026-06-20

### Changed

- Envelope `from-intelligence` parsing migrated to the current IAP vocabulary
  (`natural` / `artificial` / `absent`). The legacy values `human` / `scripted`
  are no longer accepted — the foundation normalizes any legacy value upstream,
  so only the current vocabulary reaches the runtime.

## [0.3.3] — 2026-06-20

### Removed

- The `prepare` and `install` CLI aliases — use `self-config` and `self-install`.
- The `msg` field alias in trigger registration — use `message`.

## [0.3.2] — 2026-06-20

### Removed

- The bare-CR `\r`-fold in the envelope parser, retired with the fleet-wide
  pty-only delivery migration. No behavior change on pty (LF) input.

## [0.3.1] — 2026-06-20

### Changed

- Internal cleanup: removed proven-dead code, demoted over-exported internals to
  file-local, and applied behavior-preserving refactors. The package description
  now names both primitives, and a `self-config` npm script was added.

## [0.3.0] — 2026-06-18

### Added

- On-host documentation: each install copies the package docs to a stable,
  version-matched per-host path so they are readable offline (FU6).
- A continuous-integration workflow and a unified badge row (FU10).

### Changed

- Clearer `timer` / `watcher` registry descriptions (FU8).

### Fixed

- Exclude `.DS_Store` from the on-host docs copy.

## [0.2.2] — 2026-06-18

### Fixed

- Suppress the registration reply to ephemeral (FaaS) registrants — for such a
  peer every delivered message spawns a fresh worker session, so a reply would
  spawn a spurious one. The registration still writes state and reloads live;
  only the wire ack is dropped.

## [0.2.1] — 2026-06-18

### Fixed

- Ship `docs/` in the npm tarball.

## [0.2.0] — 2026-06-18

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

## 0.1.0 – 0.1.4 — pre-public-release

Pre-public iterations on npm during initial development: the `timer` scheduler
and `watcher` supervisor primitives, registration-by-message, live same-id
replace (0.1.2), outgoing-delivery log attribution (0.1.3), and the manifest
version stamp that drives the foundation's update gate (0.1.4). Consolidated into
the first public release, 0.2.0.

[0.3.4]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.4
[0.3.3]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.3
[0.3.2]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.2
[0.3.1]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.1
[0.3.0]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.3.0
[0.2.2]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/@agfpd/notifier-runtime/v/0.2.0
