import { describe, expect, test } from 'bun:test'
import { FakeProcessSource } from '../src/processSource.ts'
import { Supervisor, type SupervisorDeps, type SupervisorOpts } from '../src/supervisor.ts'
import type { EscalationJob } from '../src/escalation.ts'
import type { EventTrigger } from '../src/triggers.ts'

// Records every EscalationJob the supervisor hands off. `sent` projects the
// signal shape ({target, message, topic?}) so pre-escalation assertions keep
// reading naturally; `alerts` filters the owner-alert jobs. Delivery semantics
// (retries/fallback/dead-letter) live in escalation.test.ts.
class DeliverRecorder {
  jobs: EscalationJob[] = []
  get sent(): Array<{ target: string; message: string; topic?: string }> {
    return this.jobs.map(j => ({
      target: j.target,
      message: j.message,
      ...(j.topic ? { topic: j.topic } : {}),
    }))
  }
  get alerts(): EscalationJob[] {
    return this.jobs.filter(j => j.kind === 'alert')
  }
}

// Deterministic fake timer + clock. Timers are scheduled against absolute fire
// instants (now + ms). advance(ms) moves the clock forward and fires every timer
// whose instant is now due, in chronological order — this models real
// setTimeout/clearTimeout closely enough to drive backoff + heartbeat WITHOUT any
// real sleeps. Cancelling removes a pending timer.
class FakeClock {
  private t = 0
  private seq = 0
  private timers = new Map<number, { at: number; cb: () => void }>()

  now = (): number => this.t

  setTimer = (ms: number, cb: () => void): (() => void) => {
    const id = this.seq++
    this.timers.set(id, { at: this.t + ms, cb })
    return () => {
      this.timers.delete(id)
    }
  }

  // Advance the clock by `ms`, firing all timers that come due, earliest-first.
  // Timers scheduled during a callback are honored if they fall within the same
  // advance window (mirrors real timer re-arming).
  advance(ms: number): void {
    const target = this.t + ms
    // Loop until no timer is due at or before `target`.
    for (;;) {
      let next: { id: number; at: number; cb: () => void } | undefined
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (next === undefined || timer.at < next.at)) {
          next = { id, at: timer.at, cb: timer.cb }
        }
      }
      if (!next) break
      this.timers.delete(next.id)
      this.t = next.at
      next.cb()
    }
    this.t = target
  }

  get pendingCount(): number {
    return this.timers.size
  }
}

interface Harness {
  supervisor: Supervisor
  source: FakeProcessSource
  transport: DeliverRecorder
  clock: FakeClock
  logs: Array<{ evt: string; fields?: Record<string, unknown> }>
}

function harness(triggers: EventTrigger[], opts: SupervisorOpts = {}): Harness {
  const source = new FakeProcessSource()
  const transport = new DeliverRecorder()
  const clock = new FakeClock()
  const logs: Harness['logs'] = []
  const deps: SupervisorDeps = {
    now: clock.now,
    deliver: job => transport.jobs.push(job),
    processSource: source,
    log: (evt, fields) => logs.push({ evt, fields }),
    setTimer: clock.setTimer,
  }
  const supervisor = new Supervisor(triggers, deps, opts)
  return { supervisor, source, transport, clock, logs }
}

function evt(over: Partial<EventTrigger> = {}): EventTrigger {
  return {
    role: 'event',
    id: over.id ?? `w-${over.target ?? 'boris'}-${over.script ?? 'tail'}`,
    script: 'tail -F /tmp/log',
    target: 'boris',
    owner: 'arthur',
    ...over,
  }
}

describe('Supervisor — forwarding', () => {
  test('forwards non-empty stdout lines verbatim with topic, skips blanks', () => {
    const h = harness([evt({ target: 'boris', topic: 'prod-alerts' })])
    h.supervisor.start()
    const proc = h.source.current!
    proc.emitStdout('ERROR db down\n')
    proc.emitStdout('\n') // blank → skipped
    proc.emitStdout('   \n') // whitespace-only is NOT blank → forwarded verbatim
    proc.emitStdout('recovered\n')

    expect(h.transport.sent).toEqual([
      { target: 'boris', message: 'ERROR db down', topic: 'prod-alerts' },
      { target: 'boris', message: '   ', topic: 'prod-alerts' },
      { target: 'boris', message: 'recovered', topic: 'prod-alerts' },
    ])
  })

  test('no topic → no topic field in the signal', () => {
    const h = harness([evt({ topic: undefined })])
    h.supervisor.start()
    h.source.current!.emitStdout('line\n')
    expect(h.transport.sent).toEqual([{ target: 'boris', message: 'line' }])
  })

  test('stderr is logged only, never forwarded', () => {
    const h = harness([evt()])
    h.supervisor.start()
    h.source.current!.emitStderr('some diagnostic noise\n')
    expect(h.transport.sent.length).toBe(0)
    expect(h.logs.some(l => l.evt === 'watcher-stderr')).toBe(true)
  })

  test('flood-seam is invoked once per forwarded line (no throttling)', () => {
    // The seam is private + a no-op here; we assert it does not interfere —
    // every non-blank line is forwarded (the seam never drops one) and blanks are
    // never forwarded (the seam is not even reached for them).
    const h = harness([evt()])
    h.supervisor.start()
    const proc = h.source.current!
    for (let i = 0; i < 10; i++) proc.emitStdout(`line${i}\n`)
    proc.emitStdout('\n')
    expect(h.transport.sent.length).toBe(10)
  })
})

describe('Supervisor — restart + exponential backoff', () => {
  test('ANY exit (even code 0) of an idle watcher → restart with exp backoff 1s,2s,4s…cap', () => {
    const h = harness([evt()], { backoffStartMs: 1000, backoffCapMs: 60000 })
    h.supervisor.start()
    expect(h.source.spawned.length).toBe(1)

    // 1st failure: instant exit 0 (no lines, ranMs 0 → unhealthy). Backoff 1s.
    h.source.current!.emitExit(0)
    expect(h.source.spawned.length).toBe(1) // not respawned yet
    h.clock.advance(999)
    expect(h.source.spawned.length).toBe(1)
    h.clock.advance(1) // 1000ms total → respawn
    expect(h.source.spawned.length).toBe(2)

    // 2nd failure → backoff 2s.
    h.source.current!.emitExit(0)
    h.clock.advance(2000)
    expect(h.source.spawned.length).toBe(3)

    // 3rd failure → backoff 4s.
    h.source.current!.emitExit(0)
    h.clock.advance(4000)
    expect(h.source.spawned.length).toBe(4)

    // 4th failure → backoff 8s.
    h.source.current!.emitExit(0)
    h.clock.advance(8000)
    expect(h.source.spawned.length).toBe(5)

    // The scheduled delays are visible in the log (1000,2000,4000,8000).
    const delays = h.logs
      .filter(l => l.evt === 'watcher-restart-scheduled')
      .map(l => l.fields?.delayMs)
    expect(delays).toEqual([1000, 2000, 4000, 8000])
  })

  test('backoff is capped', () => {
    // tiny cap so we reach it fast; threshold high so the breaker never trips;
    // huge healthyRunMs so long advances never count a no-line run as "healthy"
    // (we want a pure unhealthy streak to watch the backoff grow then cap).
    const h = harness([evt()], {
      backoffStartMs: 1000,
      backoffCapMs: 3000,
      crashloopThreshold: 100,
      healthyRunMs: 10_000_000,
    })
    h.supervisor.start()
    // failures: 1000, 2000, then capped at 3000, 3000, …
    for (let i = 0; i < 5; i++) {
      h.source.current!.emitExit(0)
      h.clock.advance(60000) // way past any backoff → guarantees respawn
    }
    const delays = h.logs
      .filter(l => l.evt === 'watcher-restart-scheduled')
      .map(l => l.fields?.delayMs)
    expect(delays).toEqual([1000, 2000, 3000, 3000, 3000])
  })

  test('a healthy run (emitted a line) resets the backoff streak', () => {
    const h = harness([evt()], { backoffStartMs: 1000, backoffCapMs: 60000 })
    h.supervisor.start()

    // Two quick failures → backoff would be at 1000 then 2000.
    h.source.current!.emitExit(0)
    h.clock.advance(1000)
    h.source.current!.emitExit(0)
    h.clock.advance(2000)
    // Now a healthy run: forward a line, then exit.
    h.source.current!.emitStdout('alive\n')
    h.source.current!.emitExit(0)
    // The next backoff should be back to 1000 (streak reset by the line).
    h.clock.advance(1000)

    const delays = h.logs
      .filter(l => l.evt === 'watcher-restart-scheduled')
      .map(l => l.fields?.delayMs)
    expect(delays).toEqual([1000, 2000, 1000])
  })

  test('a run that lives past healthyRunMs resets the streak even with no lines', () => {
    const h = harness([evt()], { backoffStartMs: 1000, backoffCapMs: 60000, healthyRunMs: 1000 })
    h.supervisor.start()

    // Fail once → backoff 1000.
    h.source.current!.emitExit(0)
    h.clock.advance(1000) // respawn (clock now at 1000)
    // Let the new process live 5s (clock now 6000) then exit with no lines → healthy.
    h.clock.advance(5000)
    h.source.current!.emitExit(0)
    // Streak reset → next backoff is 1000 again, not 2000.
    h.clock.advance(1000)
    const delays = h.logs
      .filter(l => l.evt === 'watcher-restart-scheduled')
      .map(l => l.fields?.delayMs)
    expect(delays).toEqual([1000, 1000])
  })
})

describe('Supervisor — crashloop circuit breaker', () => {
  test('K rapid failures within the window → circuit-open, alert owner, stop restarting', () => {
    const h = harness([evt({ owner: 'arthur', script: 'broken-cmd' })], {
      backoffStartMs: 1, // tiny so respawns happen within the window
      backoffCapMs: 1,
      crashloopThreshold: 3,
      crashloopWindowMs: 60000,
    })
    h.supervisor.start()

    // Three rapid failures. Each failure pushes a timestamp; the 3rd trips it.
    h.source.current!.emitExit(1) // failure 1 → schedule restart (1ms)
    h.clock.advance(1) // respawn #2
    h.source.current!.emitExit(1) // failure 2 → schedule restart
    h.clock.advance(1) // respawn #3
    h.source.current!.emitExit(1) // failure 3 → THRESHOLD reached → circuit-open

    // No further respawn scheduled.
    h.clock.advance(60000)
    expect(h.source.spawned.length).toBe(3)
    expect(h.logs.some(l => l.evt === 'watcher-crashloop')).toBe(true)

    // Owner got exactly one alert.
    const alerts = h.transport.sent.filter(s => s.target === 'arthur')
    expect(alerts.length).toBe(1)
    expect(alerts[0]!.message).toContain('crashlooping')
    expect(alerts[0]!.message).toContain('broken-cmd')

    // No pending timers → genuinely stopped.
    expect(h.clock.pendingCount).toBe(0)
  })

  test('failures spread beyond the window do NOT trip the breaker', () => {
    const h = harness([evt()], {
      backoffStartMs: 1,
      backoffCapMs: 1,
      crashloopThreshold: 3,
      crashloopWindowMs: 10000, // 10s window
    })
    h.supervisor.start()
    // Space failures ~6s apart so only ≤2 ever sit inside a 10s window.
    for (let i = 0; i < 5; i++) {
      h.source.current!.emitExit(1)
      h.clock.advance(6000)
    }
    expect(h.logs.some(l => l.evt === 'watcher-crashloop')).toBe(false)
    // Still respawning (no circuit) → more than threshold spawns happened.
    expect(h.source.spawned.length).toBeGreaterThan(3)
  })
})

describe('Supervisor — heartbeat hang detection', () => {
  test('no line within heartbeat window → kill + alert owner + restart', () => {
    const h = harness([evt({ heartbeatSec: 30, owner: 'arthur' })])
    h.supervisor.start()
    const proc = h.source.current!

    // 29s pass, still alive, no lines.
    h.clock.advance(29000)
    expect(proc.kills.length).toBe(0)
    // 30s → watchdog fires: alert owner + kill.
    h.clock.advance(1000)
    expect(proc.kills).toEqual(['SIGKILL'])
    const alerts = h.transport.sent.filter(s => s.target === 'arthur')
    expect(alerts.length).toBe(1)
    expect(alerts[0]!.message).toContain('heartbeat')
    expect(h.logs.some(l => l.evt === 'watcher-heartbeat-timeout')).toBe(true)

    // The kill leads to an exit which drives a restart (a hang is a failure).
    proc.emitExit(null, 'SIGKILL')
    h.clock.advance(60000) // past any backoff
    expect(h.source.spawned.length).toBe(2)
  })

  test('each forwarded line resets the heartbeat watchdog', () => {
    const h = harness([evt({ heartbeatSec: 30 })])
    h.supervisor.start()
    const proc = h.source.current!
    // A line every 20s keeps the 30s watchdog from ever firing.
    for (let i = 0; i < 5; i++) {
      h.clock.advance(20000)
      proc.emitStdout(`tick${i}\n`)
    }
    expect(proc.kills.length).toBe(0)
    expect(h.logs.some(l => l.evt === 'watcher-heartbeat-timeout')).toBe(false)
    expect(h.transport.sent.length).toBe(5)
  })

  test('no heartbeatSec → no watchdog (only process death is caught)', () => {
    const h = harness([evt({ heartbeatSec: undefined })])
    h.supervisor.start()
    const proc = h.source.current!
    h.clock.advance(3_600_000) // an hour of silence
    expect(proc.kills.length).toBe(0)
    expect(h.logs.some(l => l.evt === 'watcher-heartbeat-timeout')).toBe(false)
  })
})

describe('Supervisor — graceful stop (no zombie respawn)', () => {
  test('stop() kills all children and a subsequent exit does NOT restart', () => {
    const h = harness([evt({ target: 'a' }), evt({ target: 'b' })])
    h.supervisor.start()
    expect(h.source.spawned.length).toBe(2)
    const [p1, p2] = h.source.spawned

    h.supervisor.stop()
    expect(p1!.kills).toEqual(['SIGTERM'])
    expect(p2!.kills).toEqual(['SIGTERM'])

    // The kills cause exits AFTER stop — these must NOT respawn.
    p1!.emitExit(null, 'SIGTERM')
    p2!.emitExit(null, 'SIGTERM')
    h.clock.advance(120000)
    expect(h.source.spawned.length).toBe(2)
    expect(h.clock.pendingCount).toBe(0)
  })

  test('stop() cancels a pending backoff restart (no respawn after shutdown)', () => {
    const h = harness([evt()], { backoffStartMs: 5000, backoffCapMs: 60000 })
    h.supervisor.start()
    // Fail → a 5s backoff restart is now pending.
    h.source.current!.emitExit(1)
    expect(h.clock.pendingCount).toBe(1)
    // Shut down before the backoff fires.
    h.supervisor.stop()
    h.clock.advance(60000)
    expect(h.source.spawned.length).toBe(1) // never respawned
    expect(h.clock.pendingCount).toBe(0)
  })
})

describe('Supervisor — live reload', () => {
  test('reload adds a NEW watcher and starts it immediately when already running', () => {
    const h = harness([evt({ id: 'a', target: 'a' })])
    h.supervisor.start()
    expect(h.source.spawned.length).toBe(1)
    h.supervisor.reload([evt({ id: 'a', target: 'a' }), evt({ id: 'b', target: 'b' })])
    // The new watcher spawned without a restart of the existing one.
    expect(h.source.spawned.length).toBe(2)
    expect(h.logs.some(l => l.evt === 'reload' && l.fields?.added === 1)).toBe(true)
  })

  test('reload leaves a SURVIVING watcher running (not stopped/respawned)', () => {
    const h = harness([evt({ id: 'a', target: 'a' })])
    h.supervisor.start()
    const proc = h.source.spawned[0]!
    h.supervisor.reload([evt({ id: 'a', target: 'a' })]) // same key
    // The surviving child was NOT killed and NOT respawned.
    expect(proc.kills.length).toBe(0)
    expect(h.source.spawned.length).toBe(1)
    // It still forwards lines (alive).
    proc.emitStdout('still here\n')
    expect(h.transport.sent.at(-1)).toEqual({ target: 'a', message: 'still here' })
  })

  test('reload: same-id replace with a NEW target stops the old child and streams to the new target', () => {
    // The trigger-replace-live-state defect: durable held the new target while
    // the live watcher kept forwarding to the
    // old one until a daemon restart. A surviving key with a CHANGED config must
    // be replaced LIVE.
    const h = harness([evt({ id: 'a', target: 'old-target' })])
    h.supervisor.start()
    const oldProc = h.source.spawned[0]!
    h.supervisor.reload([evt({ id: 'a', target: 'new-target' })]) // same key, new target
    // Old child stopped, fresh one spawned.
    expect(oldProc.kills).toEqual(['SIGTERM'])
    expect(h.source.spawned.length).toBe(2)
    expect(h.logs.some(l => l.evt === 'reload' && l.fields?.replaced === 1)).toBe(true)
    // Lines now forward to the NEW target.
    h.source.current!.emitStdout('signal\n')
    expect(h.transport.sent.at(-1)).toEqual({ target: 'new-target', message: 'signal' })
    // The old child's eventual exit must NOT respawn (stop latch).
    oldProc.emitExit(null, 'SIGTERM')
    h.clock.advance(120000)
    expect(h.source.spawned.length).toBe(2)
  })

  test('reload: same-id replace with a NEW script respawns running the new script', () => {
    const h = harness([evt({ id: 'a', script: 'tail -F /tmp/old.log', target: 'a' })])
    h.supervisor.start()
    h.supervisor.reload([evt({ id: 'a', script: 'tail -F /tmp/new.log', target: 'a' })])
    expect(h.source.spawned.length).toBe(2)
    expect(h.source.current!.args).toEqual(['-c', 'tail -F /tmp/new.log'])
  })

  test('reload: same-id replace adding heartbeatSec arms the watchdog on the fresh watcher', () => {
    const h = harness([evt({ id: 'a', target: 'a' })]) // no heartbeat
    h.supervisor.start()
    h.supervisor.reload([evt({ id: 'a', target: 'a', heartbeatSec: 10 })])
    expect(h.source.spawned.length).toBe(2)
    // Silence past the new window → hang detection kicks in on the fresh child.
    h.clock.advance(10000)
    expect(h.logs.some(l => l.evt === 'watcher-heartbeat-timeout')).toBe(true)
  })

  test('reload removes a GONE watcher: SIGTERM, drop, no respawn', () => {
    const h = harness([evt({ id: 'a', target: 'a' }), evt({ id: 'b', target: 'b' })])
    h.supervisor.start()
    const [pa, pb] = h.source.spawned
    h.supervisor.reload([evt({ id: 'a', target: 'a' })]) // drop b
    expect(pb!.kills).toEqual(['SIGTERM'])
    expect(pa!.kills.length).toBe(0)
    // b's resulting exit must NOT respawn (it was stopped).
    pb!.emitExit(null, 'SIGTERM')
    h.clock.advance(120000)
    expect(h.source.spawned.length).toBe(2)
    expect(h.logs.some(l => l.evt === 'reload' && l.fields?.removed === 1)).toBe(true)
  })

  test('reload BEFORE start adjusts the set; start() then spawns the current set', () => {
    const h = harness([evt({ id: 'a', target: 'a' })])
    h.supervisor.reload([evt({ id: 'a', target: 'a' }), evt({ id: 'b', target: 'b' })])
    // Nothing spawned yet (not started).
    expect(h.source.spawned.length).toBe(0)
    h.supervisor.start()
    expect(h.source.spawned.length).toBe(2)
  })

  test('reload replacing the trigger set (full swap) stops old + starts new', () => {
    const h = harness([evt({ id: 'old', target: 'a' })])
    h.supervisor.start()
    const old = h.source.spawned[0]!
    h.supervisor.reload([evt({ id: 'new', target: 'b' })])
    expect(old.kills).toEqual(['SIGTERM'])
    expect(h.source.spawned.length).toBe(2) // old + new
    expect(h.source.current!.cmd).toBe('/bin/sh')
  })
})

describe('Supervisor — escalation handoff', () => {
  test('a forwarded line carries kind/owner/fallbacks/meta into the Escalator', () => {
    const h = harness([evt({ id: 'w', target: 'linus', fallback: ['boris'], topic: 'mining' })])
    h.supervisor.start()
    h.source.current!.emitStdout('strike 4\n')
    expect(h.transport.jobs).toEqual([
      {
        kind: 'forward',
        target: 'linus',
        message: 'strike 4',
        topic: 'mining',
        fallbacks: ['boris'],
        owner: 'arthur',
        meta: { id: 'arthur:w' },
      },
    ])
  })

  test('a heartbeat alert escalates as kind=alert targeting the owner', () => {
    // Pre-escalation, a failed owner alert died as one alert-error log line.
    // Now it is an escalation job like
    // any signal: the Escalator owns retries/fallback/dead-letter.
    const h = harness([evt({ owner: 'arthur', heartbeatSec: 10, fallback: ['boris'] })])
    h.supervisor.start()
    h.clock.advance(10000) // heartbeat fires → owner alert via Escalator
    expect(h.transport.alerts.length).toBe(1)
    const alert = h.transport.alerts[0]!
    expect(alert.target).toBe('arthur')
    expect(alert.owner).toBe('arthur')
    expect(alert.fallbacks).toEqual(['boris'])
    expect(alert.message).toContain('heartbeat')
  })

  test('a crashloop alert escalates as kind=alert targeting the owner', () => {
    const h = harness([evt({ owner: 'arthur', script: 'broken-cmd' })], {
      backoffStartMs: 1,
      backoffCapMs: 1,
      crashloopThreshold: 2,
      crashloopWindowMs: 60000,
    })
    h.supervisor.start()
    h.source.current!.emitExit(1)
    h.clock.advance(1)
    h.source.current!.emitExit(1) // threshold → circuit open → alert
    expect(h.transport.alerts.length).toBe(1)
    expect(h.transport.alerts[0]!.kind).toBe('alert')
    expect(h.transport.alerts[0]!.target).toBe('arthur')
    expect(h.transport.alerts[0]!.message).toContain('crashlooping')
  })

  test('fallback change alone is a same-id REPLACE on reload (live cutover)', () => {
    const h = harness([evt({ id: 'a', target: 'a' })])
    h.supervisor.start()
    const oldProc = h.source.spawned[0]!
    h.supervisor.reload([evt({ id: 'a', target: 'a', fallback: ['boris'] })])
    // Config differs (fallback) → live replace, not a silent no-op.
    expect(oldProc.kills).toEqual(['SIGTERM'])
    expect(h.source.spawned.length).toBe(2)
    h.source.current!.emitStdout('sig\n')
    expect(h.transport.jobs.at(-1)!.fallbacks).toEqual(['boris'])
  })
})
