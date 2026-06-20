# 07 — CLI

[Русский](ru/07-cli.md) · **English**

The `notifier-runtime` command has four subcommands. In normal operation you run none of them by hand — iapeer invokes `self-install`, `self-config`, and `run` for you, and `doctor` is the one you'll reach for. They're documented here so you know what the runtime does on your behalf.

```
notifier-runtime                 # self-install (the npx contract)
notifier-runtime self-install    # explicit self-install (idempotent)
notifier-runtime run             # always-on run-loop (launcher entrypoint)
notifier-runtime self-config     # per-peer config hook (foundation-invoked)
notifier-runtime doctor [--json]
```

## `self-install`

Places a self-contained launcher binary on your `PATH` and writes the runtime manifest. Running the bare command with no arguments does the same thing — that's the `npx -y @agfpd/notifier-runtime` contract, where iapeer invokes the package with no arguments.

The binary goes to `IAPEER_BIN_DIR`, or `~/.local/bin` if that isn't set. It's a compiled snapshot (`bun build --compile`), so it runs without a separate runtime on `PATH`. The manifest is written to `<IAPEER_ROOT>/runtimes/notifier/runtime.json` *after* the binary is in place. The whole operation is idempotent — run it again and you get a byte-identical manifest. See [09 — Architecture](09-architecture.md) for what the manifest contains.

## `run`

The always-on run-loop — the entrypoint iapeer's launcher starts under launchd. It dispatches on the resolved personality: `timer` runs the scheduler (TIME), `watcher` runs the supervisor (EVENT). The loop loads the peer's triggers, re-drains any signals stranded in the spool by a previous process, listens for registration messages on stdin, and fires triggers as they come due. It shuts down cleanly on SIGINT/SIGTERM.

You don't run this directly; iapeer launches it as `notifier-timer` and `notifier-watcher`.

## `self-config`

The per-peer hook the foundation invokes when it creates or onboards a notifier peer. It writes the role's registration self-documentation into the peer's local profile description, preserving the peer's identity (`intelligence: absent`). It reads which role it's configuring from `IAPEER_PEER_PERSONALITY`. Exit `0` means configured.

## `doctor`

The one command you'll run yourself. It validates the whole trigger projection — **both** roles, regardless of which peer you ask — so you can check everything from one place.

```sh
notifier-runtime doctor
```

```
notifier-runtime doctor (identity notifier-timer)
triggers: 3 (valid 3, invalid 0)
  [ok] (time) alice -> self    0 9 * * *    next=2026-06-18T09:00:00.000Z
  [ok] (time) ops -> oncall    @every 30m   next=2026-06-17T18:30:00.000Z
  [ok] (event) ops -> ops      monitor-disk    script-ok  heartbeat=60s
```

For each trigger it reports the role, owner, target, the schedule or script, whether it's valid, and — for timers — the next fire time. An invalid trigger shows the reason. Add `--json` for machine-readable output (the same data plus a summary count), useful for an external verifier.

```sh
notifier-runtime doctor --json
```
