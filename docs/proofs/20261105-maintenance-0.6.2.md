# Maintenance candidate — 0.6.2

Verified on macOS 27.0.1 with Bun 1.3.13, in isolated HOME/IAPEER_ROOT/bin directories.
No production install, trigger mutation or infrastructure restart is part of this proof.

## Reproduce from the release archive

```sh
tar -xzf agfpd-notifier-runtime-0.6.2.tgz
bun package/scripts/proof-maintenance.ts --receipt /tmp/notifier-maintenance.json
```

The harness compiles and strictly verifies a real executable, starts its actual
timer and watcher loops, submits IAP envelopes through stdin, and runs real scripts.
Its outbound CLI records payloads locally and returns `delivered to probe`.
This proves the runtime/CLI boundary, **not** native/core acceptance or host deployment.

Covered assertions:

- Fresh signed compile executes; copy-self preserves signed bytes.
- Real ENOTDIR leaves the installed binary inode and manifest unchanged.
- Late EISDIR publication failure restores the previous signed binary inode.
- A truncated Mach-O is rejected without replacing the previous pair.
- Cron registration previews the next year and warns that cron is not one-shot.
- Impossible cron and overflowing interval replacements preserve the profile.
- A nonexecutable check rejects both add and replace without writing or executing.
- An executable path containing spaces is validated without execution; its
  TERM-ignoring process times out at 30 seconds, sends no gated signal, and the
  timer continues to deliver a subsequent ungated occurrence.
- Watcher starts a real script and forwards its stdout line verbatim.
- Unregister removes every fixture trigger; fixture processes and files are cleaned.

The original harness waited for startup on stdout, but structured runtime logs are
on stderr. Its first repaired run also exposed concurrent timer/watcher profile
read-modify-write loss during teardown. This proof serializes unregister operations;
it does not claim cross-process profile locking. That separate product limitation
must not be confused with a passing concurrent-write test.

Local raw receipts: `.iapeer/receipts/0.6.2/{source-proof,package-proof}.json`.
The source run passed all ten checks. The release package is independently extracted
and run with the same harness before handoff. Unit/typecheck gate: 431 tests, zero failures.
