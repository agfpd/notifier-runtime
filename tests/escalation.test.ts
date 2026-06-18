import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  Escalator,
  InMemorySpool,
  buildChain,
  makeFileSpool,
  wrapForFallback,
  type EscalationJob,
  type SpoolEntry,
} from '../src/escalation.ts'
import type { AsyncTransport, SendResult, Signal } from '../src/transport.ts'

// ── deterministic clock (same pattern as supervisor.test.ts) ────────────────
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

  advance(ms: number): void {
    const target = this.t + ms
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
}

// ── scripted async transport ────────────────────────────────────────────────
// Per-target queues of behaviors: a SendResult, 'hang' (never settles),
// 'manual' (test resolves explicitly via pending[]), or 'throw'.
type Behavior = SendResult | 'hang' | 'manual' | 'throw'

class ScriptedTransport implements AsyncTransport {
  calls: Signal[] = []
  pending: Array<{ sig: Signal; resolve: (r: SendResult) => void }> = []
  defaultResult: SendResult = { ok: true }
  private behaviors = new Map<string, Behavior[]>()

  plan(target: string, ...b: Behavior[]): void {
    this.behaviors.set(target, b)
  }

  send(sig: Signal): Promise<SendResult> {
    this.calls.push(sig)
    const q = this.behaviors.get(sig.target)
    const b = q && q.length > 0 ? q.shift()! : this.defaultResult
    if (b === 'hang') return new Promise<SendResult>(() => {})
    if (b === 'manual')
      return new Promise<SendResult>(resolve => this.pending.push({ sig, resolve }))
    if (b === 'throw') throw new Error('transport blew up synchronously')
    return Promise.resolve(b)
  }

  callsTo(target: string): Signal[] {
    return this.calls.filter(c => c.target === target)
  }
}

// Drain microtasks + zero-delay macrotasks so the chain progresses between
// scripted steps. The 30s retry sleeps run on the FakeClock — never real.
const flush = () => new Promise<void>(r => setTimeout(r, 0))

interface Harness {
  escalator: Escalator
  clock: FakeClock
  spool: InMemorySpool
  transport: ScriptedTransport
  logs: Array<{ evt: string; fields?: Record<string, unknown> }>
}

function harness(opts: { attemptsPerLink?: number; retryDelayMs?: number; backstop?: string } = {}): Harness {
  const clock = new FakeClock()
  const spool = new InMemorySpool()
  const transport = new ScriptedTransport()
  const logs: Harness['logs'] = []
  let seq = 0
  const escalator = new Escalator(
    {
      transport,
      spool,
      log: (evt, fields) => logs.push({ evt, fields }),
      setTimer: clock.setTimer,
      now: () => new Date(1_760_000_000_000 + clock.now()),
      makeId: () => `sig-${++seq}`,
    },
    { attemptsPerLink: 2, retryDelayMs: 30_000, backstop: 'boris', ...opts },
  )
  return { escalator, clock, spool, transport, logs }
}

function job(over: Partial<EscalationJob> = {}): EscalationJob {
  return {
    kind: 'forward',
    target: 'linus',
    message: 'strike 4',
    owner: 'prl-assistant',
    meta: { id: 'prl-assistant:prl-monitor' },
    ...over,
  }
}

const FAIL = (error: string): SendResult => ({ ok: false, error })

describe('buildChain', () => {
  test('target → fallbacks → owner → backstop, order-preserving dedup', () => {
    expect(buildChain(job({ fallbacks: ['darwin'] }), 'boris')).toEqual([
      'linus',
      'darwin',
      'prl-assistant',
      'boris',
    ])
  })

  test('alert kind: target IS the owner — collapses to [owner, backstop]', () => {
    expect(buildChain(job({ kind: 'alert', target: 'prl-assistant' }), 'boris')).toEqual([
      'prl-assistant',
      'boris',
    ])
  })

  test('a fallback repeating the target or backstop adds nothing', () => {
    expect(buildChain(job({ fallbacks: ['linus', 'boris'] }), 'boris')).toEqual([
      'linus',
      'boris',
      'prl-assistant',
    ])
  })
})

describe('Escalator — primary delivery', () => {
  test('first-try success: verbatim message, spool emptied, len-attributed log', async () => {
    const h = harness()
    await h.escalator.deliver(job({ kind: 'fire', message: 'alarm', topic: 'mining', meta: { when: '@every 1m' } }))
    expect(h.transport.calls).toEqual([{ target: 'linus', message: 'alarm', topic: 'mining' }])
    // Write-ahead entry existed and was removed on success.
    expect(h.spool.entries.size).toBe(0)
    const sent = h.logs.find(l => l.evt === 'sent')
    expect(sent?.fields).toMatchObject({ target: 'linus', len: 5, when: '@every 1m' })
    expect(sent?.fields?.via).toBeUndefined()
  })

  test('kind maps to the 0.1.3 log contract: fire→sent, forward→forwarded, alert→alert-sent', async () => {
    const h = harness()
    await h.escalator.deliver(job({ kind: 'fire' }))
    await h.escalator.deliver(job({ kind: 'forward' }))
    await h.escalator.deliver(job({ kind: 'alert', target: 'prl-assistant' }))
    for (const evt of ['sent', 'forwarded', 'alert-sent']) {
      expect(h.logs.some(l => l.evt === evt)).toBe(true)
    }
  })

  test('failed attempt retries the SAME link after the delay, then succeeds', async () => {
    const h = harness()
    h.transport.plan('linus', FAIL('wake failed: never-became-ready'), { ok: true })
    const p = h.escalator.deliver(job())
    await flush()
    // Attempt 1 failed → progress persisted, retry armed.
    expect(h.transport.callsTo('linus').length).toBe(1)
    expect(h.logs.filter(l => l.evt === 'deliver-failed').length).toBe(1)
    const pending = h.spool.loadPending()
    expect(pending.length).toBe(1)
    expect(pending[0]!.attempts).toMatchObject([{ target: 'linus', error: 'wake failed: never-became-ready' }])
    // 30s retry → attempt 2 succeeds, spool emptied.
    h.clock.advance(30_000)
    await p
    expect(h.transport.callsTo('linus').length).toBe(2)
    expect(h.logs.some(l => l.evt === 'forwarded')).toBe(true)
    expect(h.spool.entries.size).toBe(0)
  })
})

describe('Escalator — fallback chain (the incident scenario)', () => {
  test('target dead ×R → owner dead ×R → delivered to boris with the escalation wrapper', async () => {
    const h = harness()
    h.transport.plan('linus', FAIL('wake failed: never-became-ready'), FAIL('wake failed: never-became-ready'))
    h.transport.plan('prl-assistant', FAIL('not in registry'), FAIL('not in registry'))
    const p = h.escalator.deliver(job({ topic: 'mining' }))
    await flush()
    h.clock.advance(30_000) // linus retry
    await flush()
    h.clock.advance(30_000) // prl-assistant retry
    await p

    // boris received it exactly once, wrapped.
    const boris = h.transport.callsTo('boris')
    expect(boris.length).toBe(1)
    const msg = boris[0]!.message
    expect(msg).toContain('notifier-escalation')
    expect(msg).toContain('signal for "linus" UNDELIVERED')
    expect(msg).toContain('linus×2 (last error: wake failed: never-became-ready)')
    expect(msg).toContain('prl-assistant×2')
    expect(msg).toContain('owner=prl-assistant')
    // The original signal rides along verbatim.
    expect(msg).toContain('strike 4')
    // Topic provenance is preserved on the escalated delivery.
    expect(boris[0]!.topic).toBe('mining')

    // Success log carries the fallback attribution.
    const fwd = h.logs.find(l => l.evt === 'forwarded')
    expect(fwd?.fields).toMatchObject({ target: 'boris', via: 'fallback', intendedTarget: 'linus', link: 3 })
    // Explicit attempt chain in the log: 2 per dead link + 1 successful.
    expect(h.logs.filter(l => l.evt === 'deliver-attempt').length).toBe(5)
    expect(h.logs.filter(l => l.evt === 'deliver-failed').length).toBe(4)
    expect(h.spool.entries.size).toBe(0)
  })

  test('declared per-trigger fallback is tried BEFORE the owner', async () => {
    const h = harness()
    h.transport.plan('linus', FAIL('dead'), FAIL('dead'))
    const p = h.escalator.deliver(job({ fallbacks: ['darwin'] }))
    await flush()
    h.clock.advance(30_000)
    await p
    expect(h.transport.callsTo('darwin').length).toBe(1)
    expect(h.transport.callsTo('prl-assistant').length).toBe(0)
    expect(h.transport.callsTo('boris').length).toBe(0)
  })

  test('whole chain dead → loud delivery-lost + durable dead-letter (never silently dropped)', async () => {
    const h = harness()
    h.transport.defaultResult = FAIL('everything is down')
    const p = h.escalator.deliver(job())
    // Drive through all retries: chain [linus, prl-assistant, boris] ×2 attempts.
    for (let i = 0; i < 6; i++) {
      await flush()
      h.clock.advance(30_000)
    }
    await p
    expect(h.transport.calls.length).toBe(6)
    const lost = h.logs.find(l => l.evt === 'delivery-lost')
    expect(lost?.fields).toMatchObject({
      sig: 'sig-1',
      intendedTarget: 'linus',
      owner: 'prl-assistant',
      chain: 'linus→prl-assistant→boris',
      attempts: 6,
    })
    // Dead-letter retained: status lost, NOT pending (won't re-drain), NOT removed.
    expect(h.spool.entries.size).toBe(1)
    expect([...h.spool.entries.values()][0]!.status).toBe('lost')
    expect(h.spool.loadPending().length).toBe(0)
  })
})

describe('Escalator — liveness (the spawnSync-mine class)', () => {
  test('a HUNG send to one target does not stop delivery to другие targets', async () => {
    const h = harness()
    h.transport.plan('linus', 'hang')
    void h.escalator.deliver(job({ target: 'linus' }))
    await flush()
    // linus is wedged mid-attempt. A signal to another peer flows regardless.
    await h.escalator.deliver(job({ kind: 'fire', target: 'darwin', message: 'tick', owner: 'index', meta: {} }))
    expect(h.transport.callsTo('darwin').length).toBe(1)
    expect(h.logs.some(l => l.evt === 'sent')).toBe(true)
    // The hung one is still in-flight: no outcome events for it.
    expect(h.logs.filter(l => l.evt === 'deliver-failed').length).toBe(0)
  })

  test('per-target lane: a second signal to the SAME target waits for the first send to settle', async () => {
    const h = harness()
    h.transport.plan('linus', 'manual', { ok: true })
    void h.escalator.deliver(job({ message: 'first' }))
    void h.escalator.deliver(job({ message: 'second' }))
    await flush()
    // Only ONE in-flight send to linus (no concurrent wake stampede).
    expect(h.transport.callsTo('linus').length).toBe(1)
    expect(h.transport.callsTo('linus')[0]!.message).toBe('first')
    // First settles → the queued one goes, in order.
    h.transport.pending.shift()!.resolve({ ok: true })
    await flush()
    expect(h.transport.callsTo('linus').map(c => c.message)).toEqual(['first', 'second'])
  })

  test('a transport that THROWS synchronously is contained: escalation-error, entry stays pending', async () => {
    const h = harness()
    h.transport.plan('linus', 'throw')
    await h.escalator.deliver(job())
    expect(h.logs.some(l => l.evt === 'escalation-error')).toBe(true)
    // Pending → the next start() re-drains it; nothing vanished.
    expect(h.spool.loadPending().length).toBe(1)
  })
})

describe('Escalator — re-drain (write-ahead spool survives restarts)', () => {
  function strandedEntry(over: Partial<SpoolEntry> = {}): SpoolEntry {
    return {
      v: 1,
      id: 'stranded-1',
      createdAt: '2026-06-10T22:21:00.000Z',
      kind: 'forward',
      target: 'linus',
      message: 'strike 4',
      owner: 'prl-assistant',
      chain: ['linus', 'boris'],
      attempts: [{ target: 'linus', at: '2026-06-10T22:21:01.000Z', error: 'wake failed' }],
      status: 'pending',
      ...over,
    }
  }

  test('start() re-runs the chain for a pending entry and delivers it', async () => {
    const h = harness()
    h.spool.put(strandedEntry())
    h.escalator.start()
    await flush()
    expect(h.logs.some(l => l.evt === 'spool-redrain' && l.fields?.sig === 'stranded-1')).toBe(true)
    // Chain restarts from the primary target; attempt history is preserved.
    expect(h.transport.callsTo('linus').length).toBe(1)
    expect(h.spool.entries.size).toBe(0)
  })

  test('a dead-letter (status lost) is NOT re-drained', async () => {
    const h = harness()
    h.spool.put(strandedEntry({ status: 'lost' }))
    h.escalator.start()
    await flush()
    expect(h.transport.calls.length).toBe(0)
    expect(h.spool.entries.size).toBe(1)
  })
})

describe('wrapForFallback', () => {
  test('collapses consecutive attempts per target and carries the verbatim original', () => {
    const entry: SpoolEntry = {
      v: 1,
      id: 's',
      createdAt: 'now',
      kind: 'fire',
      target: 'linus',
      message: 'MINER DOWN',
      owner: 'prl-assistant',
      chain: ['linus', 'boris'],
      attempts: [
        { target: 'linus', at: 't1', error: 'first error' },
        { target: 'linus', at: 't2', error: 'second error' },
      ],
      status: 'pending',
    }
    const msg = wrapForFallback(entry, 1)
    expect(msg).toContain('link 2/2')
    expect(msg).toContain('linus×2 (last error: second error)')
    expect(msg).toContain('relay it to "linus"')
    expect(msg.endsWith('MINER DOWN')).toBe(true)
  })
})

describe('makeFileSpool', () => {
  test('put/update/remove/loadPending roundtrip on real fs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notifier-spool-'))
    const logs: Array<{ evt: string }> = []
    const spool = makeFileSpool(dir, evt => logs.push({ evt }))
    const entry: SpoolEntry = {
      v: 1,
      id: 'e-1',
      createdAt: 'now',
      kind: 'fire',
      target: 'linus',
      message: 'm',
      owner: 'o',
      chain: ['linus', 'boris'],
      attempts: [],
      status: 'pending',
    }
    spool.put(entry)
    expect(spool.loadPending()).toMatchObject([{ id: 'e-1', target: 'linus' }])
    // Dead-letter: stays on disk, excluded from the drain.
    spool.update({ ...entry, status: 'lost' })
    expect(spool.loadPending()).toEqual([])
    expect(readdirSync(dir).length).toBe(1)
    // Remove is idempotent.
    spool.remove('e-1')
    spool.remove('e-1')
    expect(readdirSync(dir).length).toBe(0)
  })

  test('a corrupt entry is skipped loudly without aborting the drain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notifier-spool-'))
    const logs: Array<{ evt: string }> = []
    const spool = makeFileSpool(dir, evt => logs.push({ evt }))
    writeFileSync(join(dir, 'garbage.json'), 'not json at all')
    const entry: SpoolEntry = {
      v: 1,
      id: 'ok-1',
      createdAt: 'now',
      kind: 'forward',
      target: 't',
      message: 'm',
      owner: 'o',
      chain: ['t'],
      attempts: [],
      status: 'pending',
    }
    spool.put(entry)
    expect(spool.loadPending()).toMatchObject([{ id: 'ok-1' }])
    expect(logs.some(l => l.evt === 'spool-read-error')).toBe(true)
  })

  test('missing spool dir → nothing pending (fresh install)', () => {
    const spool = makeFileSpool(join(tmpdir(), 'does-not-exist-notifier-spool'))
    expect(spool.loadPending()).toEqual([])
  })
})
