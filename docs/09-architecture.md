# 09 — Architecture

[Русский](ru/09-архитектура.md) · **English**

This page explains how notifier-runtime plugs into iapeer: how it installs, how iapeer provisions and launches its peers, and how identity and the manifest tie it together. You don't need any of it to register triggers — read it when you're deploying or debugging the runtime.

## One runtime, two personalities

The package is one runtime, named `notifier`, that carries two peers. The same binary runs as either; it dispatches on the resolved personality at startup:

- `timer` → the scheduler (TIME primitive) → identity `notifier-timer`
- `watcher` → the supervisor (EVENT primitive) → identity `notifier-watcher`

A peer's personality is resolved from `PEER_PERSONALITY`, then from the local peer profile, then defaulting to `timer`. The scheduling and parsing logic is name-agnostic — only the displayed identity uses the names.

This mirrors `telegram-runtime`: a plug-in runtime that iapeer provisions and launches, separate from iapeer's own core.

## The install seam

Installation is a handshake between the package (which owns its own deployment) and iapeer's foundation (which owns provisioning).

```text
  npx -y @agfpd/notifier-runtime          iapeer install-runtime notifier
            │                                        │
            ▼                                        ▼
   self-install:                          reads the manifest, then for
   • launcher binary on PATH              each declared peer:
   • manifest written to                  • runs the self-config hook
     <IAPEER_ROOT>/runtimes/              • writes a launchd job
       notifier/runtime.json              • bootstraps the session
```

The package never touches the peer registry or launchd directly — that's iapeer's domain. It only declares what it is, in the manifest, and lets iapeer act on it.

## The manifest

`self-install` writes `<IAPEER_ROOT>/runtimes/notifier/runtime.json`. It declares the runtime to iapeer:

- **`runtime`** — `"notifier"`.
- **`version`** — stamped from the package version.
- **`selfConfig`** — how to invoke the per-peer config hook: `{command: <absolute bin path>, args: ["self-config"]}`. The absolute path means the hook resolves with no PATH dependency.
- **`peers`** — the declared set: `timer` and `watcher`, both `intelligence: "absent"` (they're programmatic — no model, no human behind them), each with a short description for the registry.

The manifest is written atomically and is byte-identical on a repeat install. iapeer reads it during `install-runtime` to know which peers to provision and how to configure them.

## Provisioning and launch

When you run `iapeer install-runtime notifier`, iapeer:

1. Reads the manifest.
2. For `timer` and `watcher`, runs the `self-config` hook (which writes each peer's registration self-doc into its local profile, preserving the foundation-set identity).
3. Writes a launchd job per peer (`com.iapeer.timer.plist`, `com.iapeer.watcher.plist`), pinning the launcher path into the job so it resolves independently of `PATH`.
4. Bootstraps the sessions.

From then on launchd keeps the two peers running. Each runs `notifier-runtime run` under its own identity, which iapeer brings up with `iapeer run-infra <peer> notifier`.

## State on disk

| Path | Contents |
|------|----------|
| `<IAPEER_ROOT>/runtimes/notifier/runtime.json` | the runtime manifest (iapeer reads this) |
| `<peer-cwd>/.iapeer/peer-profile.json` | each peer's profile, including its `notifier.triggers[]` |
| `~/.iapeer/peers-profiles.json` | the iapeer registry the runtime reads to locate peer profiles |
| `<IAPEER_ROOT>/state/notifier/<personality>/escalation/` | the per-peer write-ahead spool for in-flight signals |

## What belongs to whom

- **The package owns:** self-install, the manifest, the `self-config` hook, trigger parsing and storage, scheduling, supervision, and escalation.
- **iapeer owns:** the peer registry, the launchd jobs, the boot sequence, identity provisioning, and the `iapeer send` transport the runtime delivers through.

The runtime is not a standalone scheduler. It requires iapeer to provision it, launch it, and carry its signals.
