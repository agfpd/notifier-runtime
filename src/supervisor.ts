import {
  BACKOFF_CAP_MS,
  BACKOFF_START_MS,
  CRASHLOOP_THRESHOLD,
  CRASHLOOP_WINDOW_MS,
  HEALTHY_RUN_MS,
} from './constants.ts'
import type { EscalationJob } from './escalation.ts'
import type { ProcessHandle, ProcessSource } from './processSource.ts'
import type { EventTrigger } from './triggers.ts'

export interface SupervisorDeps {
  now: () => number
  // Escalating delivery (notifier-alert-escalation): forwarded lines AND owner
  // alerts go through the Escalator — retries/fallbacks/dead-letter happen
  // there, asynchronously. A send-failure is never terminal here (a
  // watcher-detected alarm once died as one send-error line).
  deliver: (job: EscalationJob) => void
  processSource: ProcessSource
  log: (evt: string, fields?: Record<string, unknown>) => void
  // Injectable timer for backoff + heartbeat. Returns a cancel fn. In production
  // this is setTimeout/clearTimeout; in tests a manual queue fires it
  // deterministically so backoff/heartbeat are verified WITHOUT real sleeps.
  setTimer: (ms: number, cb: () => void) => () => void
}

export interface SupervisorOpts {
  backoffStartMs?: number
  backoffCapMs?: number
  crashloopThreshold?: number
  crashloopWindowMs?: number
  healthyRunMs?: number
}

// Reload diff key: a watcher's identity within the running set is owner:id.
// Stable across reloads so a surviving watcher is matched (left running) rather
// than stopped+respawned. Different owners may reuse an id; the owner prefix
// disambiguates.
function watcherKey(trigger: EventTrigger): string {
  return `${trigger.owner}:${trigger.id}`
}

// Semantic-config equality for the reload diff: everything BUT the identity
// fields (owner/id — those are the key). A surviving key whose config differs is
// a same-id REPLACE (registration semantics) and must be applied to the LIVE
// watcher, not just the durable profile — otherwise the running child keeps the
// OLD script/target until a daemon restart (the trigger-replace-live-state
// defect).
function sameConfig(a: EventTrigger, b: EventTrigger): boolean {
  return (
    a.script === b.script &&
    a.target === b.target &&
    a.topic === b.topic &&
    a.heartbeatSec === b.heartbeatSec &&
    // Elements are NAME_RE-validated (no commas) → join is collision-free.
    (a.fallback ?? []).join(',') === (b.fallback ?? []).join(',')
  )
}

// Per-watcher runtime state. One Watcher per EventTrigger; it owns the spawn,
// the line-forward path, the restart/backoff/crashloop logic, and the optional
// heartbeat watchdog.
class Watcher {
  private handle?: ProcessHandle
  // Consecutive failed-restart count → drives exp backoff (n = count-1). Reset on
  // a healthy run.
  private restartCount = 0
  // Timestamps (ms) of recent failures within the crashloop window. A failure
  // pushes one; entries older than the window are dropped; length >= threshold
  // trips the breaker. Cleared on a healthy run.
  private failureTimes: number[] = []
  // Wall-clock of the current spawn → run duration on exit (healthy-run reset).
  private spawnedAt = 0
  // Did the current run forward at least one line? A line is the strongest
  // "healthy" signal (the script is doing its job), independent of duration.
  private emittedLine = false
  // Pending backoff timer cancel — cleared on stop() so a queued restart cannot
  // fire after shutdown.
  private cancelBackoff?: () => void
  // Heartbeat watchdog cancel — re-armed on each forwarded line, cancelled on
  // exit/stop.
  private cancelHeartbeat?: () => void
  // Set once stop() runs: an exit MUST NOT trigger a restart (no zombie respawn
  // after graceful shutdown), and the breaker is irrelevant.
  private stopped = false
  // Set once the breaker trips: we never restart again and never alert twice.
  private circuitOpen = false

  constructor(
    private readonly id: string,
    // Readable by the Supervisor's reload diff (same module) to detect a
    // same-key config change; never mutated after construction.
    readonly trigger: EventTrigger,
    private readonly deps: SupervisorDeps,
    private readonly cfg: Required<SupervisorOpts>,
    // Flood-guard SEAM — see Supervisor.floodObserve. Called once per forwarded line.
    private readonly floodObserve: (id: string) => void,
  ) {}

  start(): void {
    this.spawn()
  }

  // Graceful shutdown: cancel any pending backoff/heartbeat timers and kill the
  // live child. `stopped` guards onExit so the resulting exit does NOT respawn.
  stop(): void {
    this.stopped = true
    this.cancelBackoff?.()
    this.cancelBackoff = undefined
    this.clearHeartbeat()
    if (this.handle) {
      this.deps.log('watcher-stop', { id: this.id, pid: this.handle.pid })
      this.handle.kill('SIGTERM')
    }
  }

  private spawn(): void {
    if (this.stopped || this.circuitOpen) return

    this.spawnedAt = this.deps.now()
    this.emittedLine = false

    // The script is run through a shell so authors can use a full command line
    // ("tail -F log | grep ERROR"), matching the cron `check` ergonomics. stdin
    // is ignored by the source (stdio ['ignore','pipe','pipe']).
    const handle = this.deps.processSource.spawn('/bin/sh', ['-c', this.trigger.script])
    this.handle = handle
    this.deps.log('watcher-spawn', { id: this.id, pid: handle.pid, script: this.trigger.script })

    handle.onLine(line => this.onLine(line))
    handle.onStderr(chunk => this.onStderr(chunk))
    handle.onExit(info => this.onExit(info))

    // Arm the heartbeat watchdog for the fresh run (reset on restart per spec).
    this.armHeartbeat()
  }

  private onLine(line: string): void {
    // Blank-line skip happens HERE (forward layer), not in the source: a verbatim
    // empty stdout line is noise, never a signal.
    if (line.length === 0) return

    // A forwarded line is the clearest health signal → reset backoff/streak now,
    // not only on exit.
    this.emittedLine = true
    this.resetHealth()
    // Each forwarded line resets the hang watchdog.
    this.armHeartbeat()

    // Flood-guard SEAM: a future rate-limiter / auto-stop hook
    // observes every forwarded line. No throttling here — verbatim forward is the
    // author's responsibility for the EVENT role.
    this.floodObserve(this.id)

    // Hand off to the Escalator (async — the forward path never blocks on a
    // wake). Outcome logging lives there: `forwarded` (with len — the 0.1.3
    // attribution contract) on success, attempt/failure events per link,
    // `delivery-lost` + dead-letter after the chain is exhausted. The old
    // terminal `send-error` path is gone by design.
    this.deps.deliver({
      kind: 'forward',
      target: this.trigger.target,
      message: line,
      ...(this.trigger.topic ? { topic: this.trigger.topic } : {}),
      ...(this.trigger.fallback ? { fallbacks: this.trigger.fallback } : {}),
      owner: this.trigger.owner,
      meta: { id: this.id },
    })
  }

  private onStderr(chunk: string): void {
    // stderr is LOGGED only, NEVER forwarded as a signal.
    // Truncate so a chatty script does not flood the log line.
    const text = chunk.replace(/\s+$/, '')
    if (text.length === 0) return
    this.deps.log('watcher-stderr', {
      id: this.id,
      stderr: text.length > 500 ? `${text.slice(0, 500)}…` : text,
    })
  }

  private onExit(info: { code: number | null; signal: string | null }): void {
    this.clearHeartbeat()
    this.handle = undefined

    const ranMs = this.deps.now() - this.spawnedAt
    this.deps.log('watcher-exit', {
      id: this.id,
      code: info.code,
      signal: info.signal,
      ranMs,
    })

    // Graceful shutdown already killed it → do NOT restart (no zombie respawn).
    if (this.stopped) return

    // ANY exit of a long-lived watcher is a failure — even code 0. A monitor that
    // is supposed to run forever exiting cleanly is still "it stopped working".
    const healthy = this.emittedLine || ranMs >= this.cfg.healthyRunMs
    if (healthy) {
      // It did real work / survived → this exit starts a FRESH failure streak.
      this.resetHealth()
    }

    this.recordFailureAndRestart()
  }

  // Push a failure timestamp, trim to the crashloop window, and either trip the
  // breaker or schedule a backed-off restart.
  private recordFailureAndRestart(): void {
    const now = this.deps.now()
    this.failureTimes.push(now)
    const windowStart = now - this.cfg.crashloopWindowMs
    this.failureTimes = this.failureTimes.filter(t => t >= windowStart)

    if (this.failureTimes.length >= this.cfg.crashloopThreshold) {
      this.openCircuit()
      return
    }

    const n = this.restartCount // 0-based exponent: 1st backoff = start*2^0
    const delay = Math.min(this.cfg.backoffStartMs * 2 ** n, this.cfg.backoffCapMs)
    this.restartCount++
    this.deps.log('watcher-restart-scheduled', {
      id: this.id,
      attempt: this.restartCount,
      delayMs: delay,
    })
    this.cancelBackoff = this.deps.setTimer(delay, () => {
      this.cancelBackoff = undefined
      this.spawn()
    })
  }

  // Crashloop tripped: STOP restarting, alert the OWNER (script author) via the
  // Escalator, and log loudly. We never restart or alert
  // again after this. The alert escalates like any signal (owner is the primary
  // target; declared fallbacks + backstop follow) — an owner alert dying in an
  // `alert-error` line was exactly the incident class this design removes.
  private openCircuit(): void {
    this.circuitOpen = true
    this.clearHeartbeat()
    this.deps.log('watcher-crashloop', {
      id: this.id,
      failures: this.failureTimes.length,
      windowMs: this.cfg.crashloopWindowMs,
      owner: this.trigger.owner,
    })
    this.deps.deliver({
      kind: 'alert',
      target: this.trigger.owner,
      message:
        `notifier-watcher: watcher "${this.id}" (script: ${this.trigger.script}) is crashlooping ` +
        `(${this.failureTimes.length} failures within ${Math.round(this.cfg.crashloopWindowMs / 1000)}s) ` +
        `— restarts STOPPED. Fix the script and restart the watcher.`,
      ...(this.trigger.fallback ? { fallbacks: this.trigger.fallback } : {}),
      owner: this.trigger.owner,
      meta: { id: this.id },
    })
  }

  // --- heartbeat watchdog --------------------------------------------------

  // (Re)arm the per-watcher hang watchdog if heartbeatSec is declared. Firing
  // means no line was forwarded within the window → the script is hung-but-alive
  // (process death is caught separately by onExit). Kill it, alert the owner,
  // and let onExit drive the restart.
  private armHeartbeat(): void {
    if (this.trigger.heartbeatSec === undefined) return
    this.clearHeartbeat()
    const ms = this.trigger.heartbeatSec * 1000
    this.cancelHeartbeat = this.deps.setTimer(ms, () => {
      this.cancelHeartbeat = undefined
      this.onHeartbeatTimeout()
    })
  }

  private clearHeartbeat(): void {
    this.cancelHeartbeat?.()
    this.cancelHeartbeat = undefined
  }

  private onHeartbeatTimeout(): void {
    if (this.stopped || this.circuitOpen || !this.handle) return
    this.deps.log('watcher-heartbeat-timeout', {
      id: this.id,
      heartbeatSec: this.trigger.heartbeatSec,
      owner: this.trigger.owner,
    })
    // Escalating owner alert — same path as openCircuit (see comment there).
    this.deps.deliver({
      kind: 'alert',
      target: this.trigger.owner,
      message:
        `notifier-watcher: watcher "${this.id}" (script: ${this.trigger.script}) produced no output for ` +
        `${this.trigger.heartbeatSec}s (declared heartbeat) — killing and restarting (suspected hang).`,
      ...(this.trigger.fallback ? { fallbacks: this.trigger.fallback } : {}),
      owner: this.trigger.owner,
      meta: { id: this.id },
    })
    // Kill the hung child. onExit then runs the restart/backoff path (a hang is a
    // failure like any other), and onExit re-arms the heartbeat on the next spawn.
    this.handle.kill('SIGKILL')
  }

  // Reset the health bookkeeping: clears the backoff exponent and failure streak.
  private resetHealth(): void {
    this.restartCount = 0
    this.failureTimes = []
  }
}

// Supervisor: spawn + supervise + forward + restart + crashloop + heartbeat for
// every EventTrigger. Pure-injected deps (now/transport/processSource/setTimer)
// make every timing path deterministically testable.
export class Supervisor {
  // Keyed by owner:id (the reload diff key). A watcher's key is stable
  // across reloads so a surviving watcher is left running (not restarted).
  private watchers = new Map<string, Watcher>()
  private deps: SupervisorDeps
  private cfg: Required<SupervisorOpts>
  private started = false

  constructor(triggers: EventTrigger[], deps: SupervisorDeps, opts: SupervisorOpts = {}) {
    this.deps = deps
    this.cfg = {
      backoffStartMs: opts.backoffStartMs ?? BACKOFF_START_MS,
      backoffCapMs: opts.backoffCapMs ?? BACKOFF_CAP_MS,
      crashloopThreshold: opts.crashloopThreshold ?? CRASHLOOP_THRESHOLD,
      crashloopWindowMs: opts.crashloopWindowMs ?? CRASHLOOP_WINDOW_MS,
      healthyRunMs: opts.healthyRunMs ?? HEALTHY_RUN_MS,
    }
    for (const trigger of triggers) {
      const key = watcherKey(trigger)
      // De-dupe a duplicate owner:id in the initial set (last wins) so the map
      // never holds two watchers for the same key.
      this.watchers.set(key, new Watcher(key, trigger, this.deps, this.cfg, wid => this.floodObserve(wid)))
    }
  }

  // Spawn every watcher. Idempotent — a second start() is a no-op.
  start(): void {
    if (this.started) return
    this.started = true
    for (const w of this.watchers.values()) w.start()
  }

  // Live reload: apply a fresh projection WITHOUT a
  // restart. Key watchers by owner:id:
  //   • a key present in both old and new with the SAME config → leave the
  //     existing watcher running UNTOUCHED (do not stop/respawn — its child,
  //     backoff streak and heartbeat all keep going).
  //   • a surviving key with a CHANGED config (same-id replace: new script/
  //     target/topic/heartbeatSec) → REPLACE live: stop the old watcher (SIGTERM
  //     the child, suppress respawn) and start a fresh one with the new config.
  //     Watcher scripts are restart-tolerant by model (ANY exit → respawn), so a
  //     replace-respawn is within the contract. Without this the live child kept
  //     the OLD config until a daemon restart while the durable profile already
  //     held the new one (trigger-replace-live-state defect).
  //   • a new key → create + (if already started) start the watcher now.
  //   • a gone key → stop the watcher (SIGTERM the child, cancel timers, suppress
  //     respawn) and drop it from the map.
  // A reload before start() just adjusts the set; start() later spawns whatever
  // is present.
  reload(triggers: EventTrigger[]): void {
    const next = new Map<string, EventTrigger>()
    for (const trigger of triggers) next.set(watcherKey(trigger), trigger) // last wins on dup key

    let added = 0
    let removed = 0
    let replaced = 0
    // Remove watchers whose key disappeared.
    for (const [key, watcher] of [...this.watchers]) {
      if (!next.has(key)) {
        watcher.stop()
        this.watchers.delete(key)
        removed++
      }
    }
    // Add watchers for new keys; replace changed ones; leave identical ones untouched.
    for (const [key, trigger] of next) {
      const existing = this.watchers.get(key)
      if (existing) {
        if (sameConfig(existing.trigger, trigger)) continue
        // Same-id replace → apply to the LIVE state: stop old, run new. The old
        // child's eventual exit hits the stop latch (no zombie respawn); the
        // fresh Watcher starts with a clean backoff/heartbeat state.
        existing.stop()
        replaced++
      }
      const watcher = new Watcher(key, trigger, this.deps, this.cfg, wid => this.floodObserve(wid))
      this.watchers.set(key, watcher)
      // If the supervisor is already running, a freshly-added/replaced watcher
      // starts immediately (a sleeping requester's just-registered watcher fires
      // without a restart). Before start() it waits for start().
      if (this.started) watcher.start()
      if (!existing) added++
    }
    this.deps.log('reload', { added, removed, replaced, total: this.watchers.size })
  }

  // Graceful stop: kill every child and suppress all restarts (no zombie
  // respawn). After stop() a subsequent child exit must NOT respawn — each
  // Watcher latches `stopped` so onExit returns early.
  stop(): void {
    for (const w of this.watchers.values()) w.stop()
  }

  // Flood-guard SEAM. Future work (per Claude Code Monitor's
  // auto-stop) will track per-watcher line rate here and STOP a watcher that
  // floods (>N lines/sec). Intentionally a NO-OP for now: verbatim forward is the
  // author's responsibility now. DO NOT add throttling here without a spec
  // change — this is only the extension point.
  private floodObserve(_id: string): void {
    /* no-op extension point — see comment above */
  }
}
