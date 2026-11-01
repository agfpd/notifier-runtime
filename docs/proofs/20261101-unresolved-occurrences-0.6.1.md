# Independent occurrences and operator custody closure — 0.6.1

Verified on 2026-11-01 with npm-installed notifier 0.6.1 and core 0.4.157.

## Defect and fix

0.6.0 indexed durable custody by the same content key used for storm coalescing. An unresolved timer signal therefore swallowed subsequent identical scheduled occurrences. Production `walt-trader-4h-review` signal `mvxjuvus-e44d8bc2` accumulated two coalesced occurrences. Mentor and PRL signals also retained their trigger content keys.

0.6.1 indexes custody by signal ID. Timer occurrences never coalesce; unsent watcher/alert storms still do, but pending/unresolved custody cannot absorb another occurrence. Operator resolution events close custody without replay or fallback, including manual `failed`; ordinary proven refusal retains fallback semantics. Durable terminal receipts survive an event-before-CLI-pending race.

## Deployment and provenance

- Product commit/tag: `3ba1759`, `v0.6.1`; Publish run `41326030893` succeeded.
- Registry tarball: `https://registry.npmjs.org/@agfpd/notifier-runtime/-/notifier-runtime-0.6.1.tgz`.
- npm SHA512: `cNCOpuBOIQQkysIpPAIYY82hSg2Q7nvVNdrJ85mJOTN43XlugkO9VKYBOjkoufm5flN6DCizkTNevAnvHjFOQA==`.
- Tarball propagation initially returned 404; subsequent Node fetches returned ECONNRESET. The published tarball was downloaded with curl, verified against registry integrity, added to npm cache, and installed with `npm_config_offline=true iapeer update-runtime notifier`. No repository-source self-install was used.
- Timer/watcher restarted on 0.6.1 at approximately 19:34:31 MSK.
- Installed notifier SHA256: `74f90ef673dba35d8945b1316d2ac2eb4dde34cbd4bbb38d48ecce204a7c0d49`; strict code-signature verification passed.
- Installed core 0.4.157 SHA256: `80cab68e02283110651c5f201111995533c1de64c8d81837496c874a710b0faf`.

## Production spool

Six old custody files were snapshotted before deployment. No task was replayed and no production spool file was manually rewritten. Core 0.4.157 emitted operator-dismissed events; notifier removed all six custody files at 19:45:34–36.886 MSK: walt, mentor, PRL and their three uncertainty notices. Old `lost`/`flooded` dead letters were left intact. Terminal event inbox receipts remain durable.

## Installed native proof

Both fixtures use real Codex native input records and isolated HOME/IAPEER_ROOT with a loopback provider. Each performs pending → notifier restart → unresolved → native receiver recovery → next occurrence with identical payload. The new occurrence reaches native input while the old signal remains unresolved; no `signal-coalesced` is emitted. Operator closure then removes old custody, leaving an empty spool and no original-task fallback.

| Fixture | Operator outcome | Old delivery ID | Result |
|---|---|---|---|
| timer | failed | `f2527b82-2b44-428e-a877-079733a77df2` | PASS |
| watcher | dismissed | `1ac3f83e-8b5b-4be6-b96d-269bc62d99a6` | PASS |

Raw artifacts: `~/.iapeer/state/notifier/proofs/0.6.1/{pass-timer-failed,pass-watcher-dismissed}/result.json`, including native records, notifier logs and core state. Installed binary hashes in both results match production. Fixture processes and temporary working directories are removed in `finally`.

Earlier `final-*` runs were rejected as harness timing failures: operator callbacks run on a 60-second core sweep, but the fixture allowed only 30 seconds. The final harness allows 90 seconds. The earlier `live-*` run used core 0.4.156 and is not evidence for the new operator callback.

412 unit tests and typecheck pass. All three operator outcomes and terminal-event-before-CLI-pending races are covered by tests. Production walt 23:10 MSK acceptance is a separate scheduled follow-up, not claimed by these isolated proofs.

Repeat from this repository with its sibling iapeer source checkout:

```sh
bun scripts/proof-installed-acceptance.ts --runtime codex --role timer \
  --scenario unresolved --next-occurrence --resolution-outcome failed \
  --artifacts /tmp/notifier-next-occurrence-proof
```
