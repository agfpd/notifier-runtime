#!/usr/bin/env bun
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { DEFAULT_FALLBACK_TARGET, RUNTIME } from './constants.ts'
import { runCheck } from './checkGate.ts'
import { Escalator, makeFileSpool } from './escalation.ts'
import { resolvePersonality } from './identity.ts'
import { resolveIapeerRoot } from './manifest.ts'
import { nodeProcessSource } from './processSource.ts'
import { Supervisor } from './supervisor.ts'
import { makeAsyncIapTransport, makeIapTransport } from './transport.ts'
import { Scheduler } from './scheduler.ts'
import { loadTriggers, type EventTrigger, type TimeTrigger } from './triggers.ts'
import { nextFire, parseWhen } from './when.ts'
import { extractIapEnvelopes, parseIapEnvelope } from './envelope.ts'
import { type Role } from './format.ts'
import { handleEnvelope } from './registration.ts'
import { PeerProfileStore } from './peerProfileStore.ts'
import { selfInstall } from './selfInstall.ts'
import { runSelfConfig } from './selfConfig.ts'

class NotifierRuntimeError extends Error {}

function usage(): string {
  return `Usage:
  notifier-runtime                 # self-install (npx contract): bin on PATH + manifest
  notifier-runtime self-install    # explicit self-install (idempotent)
  notifier-runtime run             # always-on run-loop (foundation launcher entrypoint)
  notifier-runtime self-config     # per-peer self-config hook (foundation-invoked)
  notifier-runtime doctor [--json]`
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Structured one-line JSON log to stderr (matches the telegram-runtime
// observability idiom — captured by launchd). undefined fields are dropped.
function log(evt: string, fields: Record<string, unknown> = {}): void {
  const payload: Record<string, unknown> = { ts: new Date().toISOString(), evt }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) payload[k] = v
  }
  process.stderr.write(`notifier-runtime ${JSON.stringify(payload)}\n`)
}

// Build the production Escalator for this run session (notifier-alert-
// escalation): async iap transport (spawn + hard timeout), durable file spool
// under <IAPEER_ROOT>/state/notifier/<personality>/escalation (per-personality —
// timer and watcher are separate processes and must not drain each other's
// spool), global backstop with NOTIFIER_FALLBACK_TARGET operator override.
// start() re-drains signals that were in flight when the previous process died.
function makeEscalator(personality: string): Escalator {
  const spoolDir = join(resolveIapeerRoot(process.env), 'state', RUNTIME, personality, 'escalation')
  const backstop = process.env.NOTIFIER_FALLBACK_TARGET?.trim() || DEFAULT_FALLBACK_TARGET
  const escalator = new Escalator(
    {
      transport: makeAsyncIapTransport({ cwd: process.cwd(), env: process.env }),
      spool: makeFileSpool(spoolDir, log),
      log,
      setTimer: (ms, cb) => {
        const t = setTimeout(cb, ms)
        return () => clearTimeout(t)
      },
      now: () => new Date(),
    },
    { backstop },
  )
  log('escalation-ready', { spool: spoolDir, backstop })
  return escalator
}

async function runCommand(): Promise<void> {
  // One session = one primitive: dispatch on the RESOLVED
  // personality. timer → Scheduler (TIME), watcher → Supervisor (EVENT).
  const personality = resolvePersonality()
  const { ok: triggers, errors } = loadTriggers()
  for (const error of errors) {
    log('trigger-load-error', { error })
  }

  if (personality === 'watcher') {
    await runWatcher(triggers.filter((t): t is EventTrigger => t.role === 'event'), errors.length)
    return
  }
  // Default / 'timer': behave as the timer/TIME role.
  await runTimer(triggers.filter((t): t is TimeTrigger => t.role === 'time'), personality, errors.length)
}

async function runTimer(triggers: TimeTrigger[], personality: string, errorCount: number): Promise<void> {
  const controller = new AbortController()
  let shuttingDown = false
  const shutdown = (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log('shutdown', { signal: sig })
    controller.abort()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const escalator = makeEscalator(personality)
  const scheduler = new Scheduler(triggers, {
    now: () => new Date(),
    deliver: job => {
      void escalator.deliver(job)
    },
    runCheck: (check: string | undefined) => runCheck(check),
    log,
  })

  // Live-reload: a registration message re-projects the TIME triggers and
  // diffs them into the running scheduler (surviving slots keep their grid).
  installEnvelopeReader('timer', () => {
    const { ok, errors } = loadTriggers()
    for (const error of errors) log('trigger-load-error', { error })
    scheduler.reload(ok.filter((t): t is TimeTrigger => t.role === 'time'))
  })

  log('start', {
    identity: `${RUNTIME}-${personality}`,
    primitive: 'time',
    triggers: triggers.length,
    errors: errorCount,
  })

  // Re-drain signals stranded by the previous process (write-ahead spool) —
  // after 'start' so the redrain log lines are attributable to this session.
  escalator.start()

  await scheduler.run(controller.signal)
  log('stopped', {})
}

async function runWatcher(triggers: EventTrigger[], errorCount: number): Promise<void> {
  const escalator = makeEscalator('watcher')
  const supervisor = new Supervisor(triggers, {
    now: () => Date.now(),
    deliver: job => {
      void escalator.deliver(job)
    },
    processSource: nodeProcessSource(),
    log,
    // Real timer for backoff + heartbeat; cancel clears it.
    setTimer: (ms, cb) => {
      const t = setTimeout(cb, ms)
      return () => clearTimeout(t)
    },
  })

  // Live-reload: a registration message re-projects the EVENT triggers and
  // diffs them into the running supervisor (surviving watchers keep running).
  installEnvelopeReader('watcher', () => {
    const { ok, errors } = loadTriggers()
    for (const error of errors) log('trigger-load-error', { error })
    supervisor.reload(ok.filter((t): t is EventTrigger => t.role === 'event'))
  })

  log('start', {
    identity: `${RUNTIME}-watcher`,
    primitive: 'event',
    triggers: triggers.length,
    errors: errorCount,
  })

  // Re-drain stranded signals BEFORE the watchers start streaming new ones.
  escalator.start()

  supervisor.start()

  // Wait for SIGINT/SIGTERM, then graceful stop (kill all children, no respawn).
  await new Promise<void>(resolve => {
    let shuttingDown = false
    const shutdown = (sig: string) => {
      if (shuttingDown) return
      shuttingDown = true
      log('shutdown', { signal: sig })
      supervisor.stop()
      resolve()
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  })
  log('stopped', {})
}

// Install the raw-mode stdin envelope reader (PORTED from telegram-runtime's
// installStdinEnvelopeReader). The notifier's run-pane receives `iap send`
// envelopes delivered onto its pane input (the pty supervisor in production); we
// read the raw byte stream, slice on
// <iap>…</iap> markers (extractIapEnvelopes), parse each (parseIapEnvelope), and
// dispatch to the registration handler. Raw mode disables the pty canonical
// line-discipline (which caps a line at ~1024B on macOS and silently drops the
// overflow), so long single-line envelopes are not truncated; the reader buffers
// and re-slices, so raw mode is safe. Installed in BOTH the timer and watcher
// run paths — the only difference is the session `role` and the reloadCb.
//
// `reloadCb` re-runs loadTriggers and diffs the fresh projection into the
// running engine (Scheduler.reload / Supervisor.reload) — that is the live
// pick-up of a just-registered trigger with no restart.
function installEnvelopeReader(role: Role, reloadCb: () => void): void {
  const store = new PeerProfileStore()
  const transport = makeIapTransport({ cwd: process.cwd(), env: process.env })
  let buffer = ''
  // setRawMode throws on a non-tty stdin (piped input / launchd) — guard on
  // isTTY. The reader works either way (it just buffers raw chunks).
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += String(chunk)
    const extracted = extractIapEnvelopes(buffer)
    buffer = extracted.rest
    for (const raw of extracted.envelopes) {
      try {
        const env = parseIapEnvelope(raw)
        handleEnvelope(env, role, { store, transport, reloadCb, log })
      } catch (err) {
        // A malformed envelope is logged and dropped — never crashes the reader
        // (the next valid envelope still processes).
        log('envelope-error', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
  process.stdin.resume()
}

// `notifier-runtime` (bare) / `self-install`: the npx self-deploy contract. Place the
// launcher bin on PATH (a self-contained compiled snapshot) + write the runtime
// manifest at <IAPEER_ROOT>/runtimes/notifier/runtime.json. IDEMPOTENT. This is the
// npx↔foundation seam — after it, `iapeer install-runtime notifier` reads the manifest
// and provisions timer+watcher.
async function selfInstallCommand(): Promise<void> {
  const r = selfInstall({ env: process.env, sourceEntry: import.meta.path })
  process.stdout.write('notifier-runtime self-install (idempotent)\n')
  process.stdout.write(`  bin:      ${r.binPath}  (${r.binMode})\n`)
  process.stdout.write(`  manifest: ${r.manifestPath}\n`)
  process.stdout.write(`  root:     ${r.root}\n`)
  // FU6 on-host docs: best-effort, so surface BOTH outcomes (copied / skipped)
  // without ever having failed the install.
  process.stdout.write(
    r.docs.copied ? `  docs:     ${r.docs.dest}\n` : `  docs:     skipped (${r.docs.reason})\n`,
  )
  log('self-install', {
    bin: r.binPath,
    manifest: r.manifestPath,
    binMode: r.binMode,
    root: r.root,
    docsCopied: r.docs.copied,
    docsDest: r.docs.dest,
    ...(r.docs.reason ? { docsReason: r.docs.reason } : {}),
  })
}

// `notifier-runtime self-config`: the PER-PEER self-config hook the foundation invokes
// inside createPeer→initPeer (cwd = peer cwd, IAPEER_PEER_* in env). Writes the role's
// registration self-doc into the local peer profile (rich runtime state), PRESERVING
// the foundation-provisioned identity (intelligence=absent). exit 0 = configured.
// `prepare` is a back-compat alias.
async function selfConfigCommand(): Promise<void> {
  const r = runSelfConfig({ env: process.env, cwd: process.cwd() })
  process.stdout.write(`${r.profilePath}\n`)
  process.stdout.write(`notifier-runtime self-config: configured peer "${r.personality}" (role ${r.role})\n`)
  log('self-config', { personality: r.personality, role: r.role, profile: r.profilePath })
}

interface DoctorEntry {
  role: 'time' | 'event'
  // The trigger's stable id (owner-scoped) — the unregister handle and the
  // machine-readable key an external verifier (e.g. a runtime's verify --repair)
  // matches on. Same id discipline as triggers.ts / registration.ts.
  id: string
  owner: string
  target: string
  // time: the cron/interval `when`; event: the watcher `script`.
  spec: string
  valid: boolean
  next?: string // time only
  heartbeatSec?: number // event only
  error?: string
}

// Validate an event watcher's script for doctor. The script is shell-invoked, so
// a full command line ("tail -F x | grep y") is legal — we only hard-validate
// the leading token WHEN it looks like a filesystem path (contains "/"): it must
// exist and be executable. A bare command name (resolved via PATH at runtime) is
// reported valid here — doctor cannot reliably resolve PATH the way the shell will.
function validateScript(script: string): { valid: boolean; error?: string } {
  const firstToken = script.trim().split(/\s+/)[0] ?? ''
  if (firstToken.length === 0) return { valid: false, error: 'empty script' }
  if (!firstToken.includes('/')) {
    return { valid: true } // bare command, resolved via PATH at runtime
  }
  if (!existsSync(firstToken)) {
    return { valid: false, error: `script not found: ${firstToken}` }
  }
  try {
    const st = statSync(firstToken)
    if (!st.isFile()) return { valid: false, error: `script is not a file: ${firstToken}` }
    // Any execute bit (owner/group/other) — we run it via /bin/sh -c, so an
    // executable file is required.
    if ((st.mode & 0o111) === 0) {
      return { valid: false, error: `script not executable: ${firstToken}` }
    }
  } catch (err) {
    return { valid: false, error: formatError(err) }
  }
  return { valid: true }
}

async function doctorCommand(argv: string[]): Promise<void> {
  const json = argv.includes('--json')
  const personality = resolvePersonality()
  const { ok: triggers, errors } = loadTriggers()
  const now = new Date()
  const entries: DoctorEntry[] = []

  // doctor reports BOTH roles regardless of the running personality, so an
  // operator can validate the whole projection from one place.
  for (const trigger of triggers) {
    if (trigger.role === 'time') {
      const base = { role: 'time' as const, id: trigger.id, owner: trigger.owner, target: trigger.target, spec: trigger.when }
      try {
        const parsed = parseWhen(trigger.when)
        const next = nextFire(parsed, now, now)
        entries.push({ ...base, valid: true, next: next.toISOString() })
      } catch (err) {
        entries.push({ ...base, valid: false, error: formatError(err) })
      }
    } else {
      const base = {
        role: 'event' as const,
        id: trigger.id,
        owner: trigger.owner,
        target: trigger.target,
        spec: trigger.script,
        ...(trigger.heartbeatSec !== undefined ? { heartbeatSec: trigger.heartbeatSec } : {}),
      }
      const v = validateScript(trigger.script)
      entries.push({ ...base, valid: v.valid, ...(v.error ? { error: v.error } : {}) })
    }
  }

  const validCount = entries.filter(e => e.valid).length
  const invalidCount = entries.length - validCount

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          runtime: RUNTIME,
          personality,
          identity: `${RUNTIME}-${personality}`,
          triggers: entries,
          loadErrors: errors,
          summary: { total: entries.length, valid: validCount, invalid: invalidCount },
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  process.stdout.write(`notifier-runtime doctor (identity ${RUNTIME}-${personality})\n`)
  process.stdout.write(`triggers: ${entries.length} (valid ${validCount}, invalid ${invalidCount})\n`)
  for (const entry of entries) {
    const hb = entry.heartbeatSec !== undefined ? `  heartbeat=${entry.heartbeatSec}s` : ''
    if (entry.valid) {
      const tail = entry.role === 'time' ? `next=${entry.next}` : `script-ok${hb}`
      process.stdout.write(
        `  [ok] (${entry.role}) ${entry.owner} -> ${entry.target}  ${entry.spec}  ${tail}\n`,
      )
    } else {
      process.stdout.write(
        `  [INVALID] (${entry.role}) ${entry.owner} -> ${entry.target}  ${entry.spec}  ${entry.error}\n`,
      )
    }
  }
  for (const error of errors) {
    process.stdout.write(`  [load-error] ${error}\n`)
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (!cmd) {
    // Bare invocation = the npx self-install contract (the foundation's
    // defaultNpxRunner runs `npx -y <package>` with NO args).
    await selfInstallCommand()
    return
  }
  switch (cmd) {
    case 'self-install':
    case 'install': // back-compat alias
      await selfInstallCommand()
      return
    case 'self-config':
    case 'prepare': // back-compat alias
      await selfConfigCommand()
      return
    case 'run':
      await runCommand()
      return
    case 'doctor':
      await doctorCommand(rest)
      return
    default:
      throw new NotifierRuntimeError(usage())
  }
}

if (import.meta.main) {
  main().catch(err => {
    process.stderr.write(`notifier-runtime: ${formatError(err)}\n`)
    process.exit(1)
  })
}
