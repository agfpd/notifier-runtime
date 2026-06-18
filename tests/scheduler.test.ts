import { describe, expect, test } from 'bun:test'
import { Scheduler, type SchedulerDeps } from '../src/scheduler.ts'
import type { EscalationJob } from '../src/escalation.ts'
import type { TimeTrigger } from '../src/triggers.ts'
import type { CheckResult } from '../src/checkGate.ts'

function local(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s)
}

// Records every EscalationJob the scheduler hands off. `sent` projects the
// signal shape ({target, message, topic?}) so the pre-escalation assertions
// keep reading naturally — delivery semantics themselves are escalation.test.ts
// territory.
class DeliverRecorder {
  jobs: EscalationJob[] = []
  get sent(): Array<{ target: string; message: string; topic?: string }> {
    return this.jobs.map(j => ({
      target: j.target,
      message: j.message,
      ...(j.topic ? { topic: j.topic } : {}),
    }))
  }
}

interface Harness {
  scheduler: Scheduler
  transport: DeliverRecorder
  logs: Array<{ evt: string; fields?: Record<string, unknown> }>
  setNow: (d: Date) => void
}

function harness(
  triggers: TimeTrigger[],
  opts: { start: Date; check?: (check: string | undefined) => CheckResult } = { start: local(2026, 6, 6, 10, 0) },
): Harness {
  let current = opts.start
  const transport = new DeliverRecorder()
  const logs: Harness['logs'] = []
  const deps: SchedulerDeps = {
    now: () => current,
    deliver: job => transport.jobs.push(job),
    runCheck: opts.check ?? (() => ({ send: true, reason: 'unconditional' })),
    log: (evt, fields) => logs.push({ evt, fields }),
  }
  const scheduler = new Scheduler(triggers, deps)
  return { scheduler, transport, logs, setNow: d => (current = d) }
}

function trig(over: Partial<TimeTrigger> = {}): TimeTrigger {
  return {
    role: 'time',
    id: over.id ?? `t-${over.target ?? 'boris'}-${over.when ?? '@every 30m'}`,
    when: '@every 30m',
    message: 'ping',
    target: 'boris',
    owner: 'arthur',
    ...over,
  }
}

describe('Scheduler', () => {
  test('nextWakeup is anchor+ms on a fresh interval trigger', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ when: '@every 30m' })], { start })
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 30))
  })

  test('due trigger fires exactly once with the right payload', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ when: '@every 30m', message: 'tick', target: 'boris', topic: 'beat' })], { start })
    // Not yet due.
    h.setNow(local(2026, 6, 6, 10, 29))
    h.scheduler.tick(local(2026, 6, 6, 10, 29))
    expect(h.transport.sent.length).toBe(0)
    // Due at 10:30.
    h.setNow(local(2026, 6, 6, 10, 30))
    h.scheduler.tick(local(2026, 6, 6, 10, 30))
    expect(h.transport.sent).toEqual([{ target: 'boris', message: 'tick', topic: 'beat' }])
    // Same instant ticked again → no double-fire (nextAt advanced strictly past now).
    h.scheduler.tick(local(2026, 6, 6, 10, 30))
    expect(h.transport.sent.length).toBe(1)
    expect(h.scheduler.nextWakeup()!.getTime()).toBeGreaterThan(local(2026, 6, 6, 10, 30).getTime())
  })

  test('skip-to-next: a big now jump fires once and parks nextAt in the future', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ when: '@every 30m' })], { start })
    // Jump 100 minutes ahead — only ONE fire (no catch-up for the 3 missed slots).
    const jumped = local(2026, 6, 6, 11, 40)
    h.setNow(jumped)
    h.scheduler.tick(jumped)
    expect(h.transport.sent.length).toBe(1)
    expect(h.scheduler.nextWakeup()!.getTime()).toBeGreaterThan(jumped.getTime())
    // Next slot off the anchor grid after 11:40 is 12:00.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 12, 0))
  })

  test('check-gate skip → no send, logged as skipped', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ when: '@every 30m', check: '/usr/bin/false' })], {
      start,
      check: () => ({ send: false, reason: 'check-failed', exitCode: 1 }),
    })
    h.setNow(local(2026, 6, 6, 10, 30))
    h.scheduler.tick(local(2026, 6, 6, 10, 30))
    expect(h.transport.sent.length).toBe(0)
    expect(h.logs.some(l => l.evt === 'skipped')).toBe(true)
    // Advanced anyway → no busy-spin.
    expect(h.scheduler.nextWakeup()!.getTime()).toBeGreaterThan(local(2026, 6, 6, 10, 30).getTime())
  })

  test('fail-safe gate error → no send, logged loudly as check-error', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ when: '@every 30m', check: '/bad' })], {
      start,
      check: () => ({ send: false, reason: 'check-error', error: 'ENOENT' }),
    })
    h.setNow(local(2026, 6, 6, 10, 30))
    h.scheduler.tick(local(2026, 6, 6, 10, 30))
    expect(h.transport.sent.length).toBe(0)
    expect(h.logs.some(l => l.evt === 'check-error')).toBe(true)
  })

  test('earliest nextWakeup across several triggers', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness(
      [
        trig({ when: '@every 1h', target: 'a' }),
        trig({ when: '@every 15m', target: 'b' }),
        trig({ when: '@every 45m', target: 'c' }),
      ],
      { start },
    )
    // The 15m trigger is earliest → 10:15.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 15))
  })

  test('cron trigger fires at the scheduled minute', () => {
    const start = local(2026, 6, 6, 8, 0)
    const h = harness([trig({ when: '0 9 * * *', message: 'morning', target: 'arthur' })], { start })
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 9, 0))
    h.setNow(local(2026, 6, 6, 9, 0))
    h.scheduler.tick(local(2026, 6, 6, 9, 0))
    expect(h.transport.sent).toEqual([{ target: 'arthur', message: 'morning' }])
    // Next fire is tomorrow 09:00.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 7, 9, 0))
  })

  test('run loop wakes on abort and exits promptly', async () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ when: '@every 30m' })], { start })
    const controller = new AbortController()
    const p = h.scheduler.run(controller.signal)
    controller.abort()
    // Should resolve without hanging on the 60s cap.
    await expect(p).resolves.toBeUndefined()
  })

  test('no triggers → nextWakeup null, run loop still abortable', async () => {
    const h = harness([], { start: local(2026, 6, 6, 10, 0) })
    expect(h.scheduler.nextWakeup()).toBeNull()
    const controller = new AbortController()
    const p = h.scheduler.run(controller.signal)
    controller.abort()
    await expect(p).resolves.toBeUndefined()
  })

  test('reload: a SURVIVING slot keeps its nextAt/anchor (grid not reset)', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ id: 'beat', when: '@every 30m', target: 'boris' })], { start })
    // First fire is at 10:30 off the start anchor.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 30))
    // Advance the clock to 10:20 (no fire yet) and reload with the SAME key plus a
    // new trigger. The surviving slot must keep its 10:30 nextAt — it must NOT
    // re-anchor to 10:20 (which would push the next fire to 10:50).
    h.setNow(local(2026, 6, 6, 10, 20))
    h.scheduler.reload([
      trig({ id: 'beat', when: '@every 30m', target: 'boris' }),
      trig({ id: 'new', when: '@every 30m', target: 'arthur' }),
    ])
    // The earliest is still the surviving slot at 10:30 (preserved), not 10:50.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 30))
  })

  test('reload: a NEW slot is anchored at now (its first fire is from the reload instant)', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([], { start })
    h.setNow(local(2026, 6, 6, 10, 20))
    h.scheduler.reload([trig({ id: 'fresh', when: '@every 30m', target: 'boris' })])
    // Anchored at 10:20 → first fire 10:50.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 50))
  })

  test('reload: a GONE slot stops firing', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ id: 'a', when: '@every 30m', target: 'a' })], { start })
    h.scheduler.reload([]) // drop everything
    expect(h.scheduler.nextWakeup()).toBeNull()
    // Even at a time the dropped slot would have fired, nothing is sent.
    h.setNow(local(2026, 6, 6, 11, 0))
    h.scheduler.tick(local(2026, 6, 6, 11, 0))
    expect(h.transport.sent.length).toBe(0)
  })

  test('reload: refreshes a surviving slot payload (edited message takes effect, schedule kept)', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ id: 'beat', when: '@every 30m', message: 'v1', target: 'boris' })], { start })
    h.scheduler.reload([trig({ id: 'beat', when: '@every 30m', message: 'v2', target: 'boris' })])
    h.setNow(local(2026, 6, 6, 10, 30))
    h.scheduler.tick(local(2026, 6, 6, 10, 30))
    expect(h.transport.sent).toEqual([{ target: 'boris', message: 'v2' }])
  })

  test('reload: same-id replace with a NEW target retargets LIVE (schedule kept)', () => {
    // The trigger-replace-live-state defect (timer flavor): durable got the new
    // target but the live slot kept firing at the old one. The payload refresh
    // must make the very next fire go to the NEW target, on the SAME grid.
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ id: 'beat', when: '@every 30m', target: 'boris' })], { start })
    h.setNow(local(2026, 6, 6, 10, 20))
    h.scheduler.reload([trig({ id: 'beat', when: '@every 30m', target: 'arthur' })])
    // Grid preserved (10:30, not re-anchored to 10:50)…
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 30))
    // …and the fire goes to the NEW target.
    h.setNow(local(2026, 6, 6, 10, 30))
    h.scheduler.tick(local(2026, 6, 6, 10, 30))
    expect(h.transport.sent).toEqual([{ target: 'arthur', message: 'ping' }])
  })

  test('reload: same-id replace with a CHANGED when RE-ARMS at now (old grid dropped)', () => {
    // The scheduler flavor of trigger-replace-live-state for `when`: parsed/
    // anchor were never recomputed, so a replaced schedule never took effect
    // until a daemon restart. A changed `when` must re-arm from the reload
    // instant.
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([trig({ id: 'beat', when: '@every 30m', target: 'boris' })], { start })
    // Old grid: next fire 10:30.
    h.setNow(local(2026, 6, 6, 10, 20))
    h.scheduler.reload([trig({ id: 'beat', when: '@every 5m', target: 'boris' })])
    // Re-anchored at 10:20 with the NEW expression → next fire 10:25 (not 10:30).
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 25))
    expect(h.logs.some(l => l.evt === 'reload' && l.fields?.replaced === 1)).toBe(true)
    h.setNow(local(2026, 6, 6, 10, 25))
    h.scheduler.tick(local(2026, 6, 6, 10, 25))
    expect(h.transport.sent.length).toBe(1)
    // The new 5m cadence continues: next is 10:30 off the 10:20 anchor.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 30))
  })

  test('reload: two triggers from DIFFERENT owners sharing an id are distinct slots', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness([], { start })
    h.scheduler.reload([
      { ...trig({ id: 'beat', when: '@every 30m', target: 'a' }), owner: 'arthur' },
      { ...trig({ id: 'beat', when: '@every 15m', target: 'b' }), owner: 'boris' },
    ])
    // Both kept (keys arthur:beat and boris:beat differ) → earliest is the 15m one.
    expect(h.scheduler.nextWakeup()).toEqual(local(2026, 6, 6, 10, 15))
  })
})

describe('Scheduler — escalation handoff', () => {
  test('a fire hands the Escalator a full job: kind/owner/fallbacks/meta', () => {
    const start = local(2026, 6, 6, 10, 0)
    const h = harness(
      [trig({ when: '@every 30m', message: 'alarm', target: 'linus', topic: 'mining', fallback: ['boris'] })],
      { start },
    )
    h.setNow(local(2026, 6, 6, 10, 30))
    h.scheduler.tick(local(2026, 6, 6, 10, 30))
    expect(h.transport.jobs).toEqual([
      {
        kind: 'fire',
        target: 'linus',
        message: 'alarm',
        topic: 'mining',
        fallbacks: ['boris'],
        owner: 'arthur',
        meta: { owner: 'arthur', when: '@every 30m', reason: 'unconditional' },
      },
    ])
  })
})

describe('Scheduler — extra', () => {
  test('one throwing trigger does not stop the others in a tick', () => {
    const start = local(2026, 6, 6, 10, 0)
    let current = start
    const logs: Harness['logs'] = []
    // A deliver hook that throws for target "bad" but records "good" (the
    // production deliver never throws — this guards the tick against a buggy one).
    const recorded: string[] = []
    const scheduler = new Scheduler(
      [trig({ when: '@every 30m', target: 'bad' }), trig({ when: '@every 30m', target: 'good' })],
      {
        now: () => current,
        deliver: job => {
          if (job.target === 'bad') throw new Error('boom')
          recorded.push(job.target)
        },
        runCheck: () => ({ send: true, reason: 'unconditional' }),
        log: (evt, fields) => logs.push({ evt, fields }),
      },
    )
    current = local(2026, 6, 6, 10, 30)
    scheduler.tick(current)
    // "good" still delivered despite "bad" throwing.
    expect(recorded).toEqual(['good'])
    expect(logs.some(l => l.evt === 'trigger-error')).toBe(true)
    // The throwing slot advanced too (no busy-spin).
    expect(scheduler.nextWakeup()!.getTime()).toBeGreaterThan(current.getTime())
  })
})

// Live-reload promptness: reload() must WAKE a sleeping run loop so a
// just-registered trigger fires on its own schedule, not after the (up to 60s)
// sleep cap. Regression guard for the gap caught in live acceptance — without
// the wake, the loop started with 0 triggers sleeps the full cap and the new
// @every-1s trigger never fires inside this window. Uses REAL timers.
describe('reload wakes the sleeping run loop', () => {
  test('a trigger registered while idle fires promptly (not after the cap)', async () => {
    const transport = new DeliverRecorder()
    const scheduler = new Scheduler([], {
      now: () => new Date(),
      deliver: job => transport.jobs.push(job),
      runCheck: () => ({ send: true, reason: 'unconditional' }),
      log: () => {},
    })
    const controller = new AbortController()
    const running = scheduler.run(controller.signal)
    // Loop is now sleeping (no triggers → cap). Register an interval due in ~1s.
    scheduler.reload([
      { role: 'time', id: 'live', owner: 'o', target: 't', when: '@every 1s', message: 'm' },
    ])
    await new Promise(r => setTimeout(r, 1300))
    controller.abort()
    await running
    expect(transport.sent.length).toBeGreaterThanOrEqual(1)
    expect(transport.sent[0]).toMatchObject({ target: 't', message: 'm' })
  })
})
