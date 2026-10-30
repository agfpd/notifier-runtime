import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Escalator, InMemorySpool, makeFileSpool, type EscalationJob, type Spool } from '../src/escalation.ts'
import { makeAcceptanceStore, MemoryAcceptanceStore, parseAcceptanceEvent, type AcceptanceStore } from '../src/acceptance.ts'
import { parseSendSuccess, type Signal, type SendResult } from '../src/transport.ts'
import { parseIapEnvelope } from '../src/envelope.ts'

const dir = mkdtempSync(join(tmpdir(), 'notifier-acceptance-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const flush = () => new Promise<void>(r => setTimeout(r, 0))
const job: EscalationJob = { kind: 'fire', target: 'receiver', owner: 'owner', fallbacks: ['relay'], message: 'TASK', meta: { id: 'owner:tick' } }
const event = (outcome: 'delivered' | 'failed' | 'unresolved', deliveryId = 'delivery-1') => ({ deliveryId, outcome, recipient: 'codex-receiver', reason: 'test' })
function setup(spool: Spool = new InMemorySpool(), acceptanceStore: AcceptanceStore = new MemoryAcceptanceStore()) {
  const sent: Signal[] = [], logs: string[] = []
  let now = Date.now(), seq = 0
  const results: SendResult[] = [{ ok: true, acceptance: 'pending', deliveryId: 'delivery-1' }]
  const e = new Escalator({ spool, acceptanceStore,
    transport: { async send(sig) { sent.push(sig); return results.shift() ?? { ok: true } } },
    now: () => new Date(now), makeId: () => `signal-${++seq}`, setTimer: (_ms, cb) => { queueMicrotask(cb); return () => {} },
    log: evt => logs.push(evt),
  }, { backstop: 'backstop' })
  return { e, sent, logs, results, spool, advance(ms: number) { now += ms } }
}

describe('durable pending acceptance', () => {
  test('pending holds original; delivered deletes without retries/fallback', async () => {
    const h = setup()
    await h.e.deliver(job)
    expect(h.sent.length).toBe(1)
    expect(h.spool.loadPending()[0].delivery?.deliveryId).toBe('delivery-1')
    h.e.accept(event('delivered'))
    await flush()
    expect(h.sent.length).toBe(1)
    expect(h.spool.loadPending()).toEqual([])
    h.e.accept(event('failed')); await flush()
    expect(h.sent.length).toBe(1)
  })
  test('pending → proven failed advances to trigger fallback exactly once', async () => {
    const h = setup()
    await h.e.deliver(job)
    h.e.accept(event('failed')); await flush()
    h.e.accept(event('failed')); await flush()
    expect(h.sent.map(s => s.target)).toEqual(['receiver', 'relay'])
    expect(h.sent[1].message).toContain('TASK')
    expect(h.spool.loadPending()).toEqual([])
  })
  test('fallback and owner refusing continue through backstop, no repeated primary', async () => {
    const h = setup()
    await h.e.deliver(job)
    h.results.push(...Array.from({ length: 4 }, () => ({ ok: false, error: 'pre-paste refusal' })))
    h.e.accept(event('failed')); await flush(); await flush()
    expect(h.sent.map(s => s.target)).toEqual(['receiver', 'relay', 'relay', 'owner', 'owner', 'backstop'])
  })
  test('unresolved sends owner INFORMATION only, retains custody and accepts late delivered', async () => {
    const h = setup()
    await h.e.deliver(job)
    h.e.accept(event('unresolved')); await flush()
    expect(h.sent.map(s => s.target)).toEqual(['receiver', 'owner'])
    expect(h.sent[1].topic).toBe('notifier-unresolved')
    expect(h.sent[1].message).not.toContain('TASK')
    expect(h.sent[1].message).toContain('owner:tick')
    expect(h.spool.loadPending().length).toBe(1)
    h.e.accept(event('unresolved')); await flush()
    expect(h.sent.length).toBe(2)
    h.e.accept(event('delivered')); await flush()
    expect(h.spool.loadPending()).toEqual([])
    h.e.accept(event('unresolved')); await flush()
    expect(h.sent.length).toBe(2)
  })
  test('file-backed restart pending → delivered, event BEFORE CLI response retained', async () => {
    const sp = join(dir, 'restart-delivered'), inbox = join(dir, 'restart-inbox')
    const a = setup(makeFileSpool(sp), makeAcceptanceStore(inbox))
    a.e.accept(event('delivered'))
    await a.e.deliver(job)
    const b = setup(makeFileSpool(sp), makeAcceptanceStore(inbox))
    b.e.start(); await flush()
    expect(b.sent).toEqual([])
    expect(b.spool.loadPending()).toEqual([])
  })
  test('file-backed restart pending → failed correlates same trigger and chain', async () => {
    const sp = join(dir, 'restart-failed'), inbox = join(dir, 'failed-inbox')
    const a = setup(makeFileSpool(sp), makeAcceptanceStore(inbox))
    await a.e.deliver(job)
    const b = setup(makeFileSpool(sp), makeAcceptanceStore(inbox))
    b.results.length = 0
    b.e.start(); await flush()
    expect(b.sent).toEqual([])
    b.e.accept(event('failed')); await flush()
    expect(b.sent.map(s => s.target)).toEqual(['relay'])
    expect(b.spool.loadPending()).toEqual([])
  })
  test('file-backed restart unresolved preserves notification checkpoint, no task replay', async () => {
    const sp = join(dir, 'restart-unknown'), inbox = join(dir, 'unknown-inbox')
    const a = setup(makeFileSpool(sp), makeAcceptanceStore(inbox))
    await a.e.deliver(job)
    a.e.accept(event('unresolved')); await flush()
    const b = setup(makeFileSpool(sp), makeAcceptanceStore(inbox))
    b.e.start(); await flush()
    expect(b.sent).toEqual([])
    expect(b.spool.loadPending()[0].delivery?.phase).toBe('unresolved')
  })
  test('restart during submitting or killed CLI is unknown, never replay', async () => {
    const a = setup()
    await a.e.deliver(job)
    const saved = a.spool.loadPending()[0]
    saved.delivery = { phase: 'submitting', to: 'receiver' }
    a.spool.update(saved)
    const b = setup(a.spool)
    b.results.length = 0
    b.e.start(); await flush()
    expect(b.sent.map(s => s.target)).toEqual(['owner'])
    expect(b.sent[0].message).not.toContain('TASK')
    const c = setup()
    c.results[0] = { ok: false, acceptance: 'unresolved', error: 'killed' }
    await c.e.deliver(job); await flush()
    expect(c.sent.map(s => s.target)).toEqual(['receiver', 'owner'])
  })
  test('missing core event times out to owner uncertainty, no task fallback', async () => {
    const h = setup()
    await h.e.deliver(job)
    h.advance(180_000)
    await h.e.reconcileAcceptance(); await flush()
    expect(h.sent.map(s => s.target)).toEqual(['receiver', 'owner'])
    expect(h.spool.loadPending()[0].delivery?.phase).toBe('unresolved')
  })
  test('wrong recipient cannot resolve and flood breaker cannot discard custody', async () => {
    const h = setup()
    await h.e.deliver(job)
    h.e.accept({ ...event('delivered'), recipient: 'codex-other-receiver' }); await flush()
    expect(h.spool.loadPending().length).toBe(1)
    expect(h.e.cancelPending(() => true)).toBe(0)
  })
  test('pending fallback itself gets a distinct custody checkpoint', async () => {
    const h = setup()
    await h.e.deliver(job)
    h.results.push({ ok: true, acceptance: 'pending', deliveryId: 'delivery-2' })
    h.e.accept(event('failed')); await flush()
    h.e.accept(event('failed')); await flush()
    expect(h.sent.map(s => s.target)).toEqual(['receiver', 'relay'])
    h.e.accept({ ...event('delivered', 'delivery-2'), recipient: 'codex-relay' }); await flush()
    expect(h.spool.loadPending()).toEqual([])
  })

  test('crash before owner-notice checkpoint cannot overwrite its pending deliveryId on restart', async () => {
    const spool = new InMemorySpool(), store = new MemoryAcceptanceStore(), a = setup(spool, store)
    await a.e.deliver(job)
    a.results.push({ ok: true, acceptance: 'pending', deliveryId: 'notice-1' })
    a.e.accept(event('unresolved')); await flush()
    const original = spool.loadPending().find(e => e.message === 'TASK')!
    original.delivery!.noticeQueued = false // crash after notice put, before checkpoint
    spool.update(original)
    const b = setup(spool, store)
    b.results.length = 0
    b.e.start(); await flush()
    expect(b.sent).toEqual([])
    expect(spool.loadPending().find(e => e.meta?.uncertaintyNoticeFor)?.delivery?.deliveryId).toBe('notice-1')
  })
})

test('parse CLI custody and fail-safe unfamiliar exit-zero output', () => {
  expect(parseSendSuccess('pending acceptance abc-123 for p (codex) — core owns resolution')).toEqual({ ok: true, acceptance: 'pending', deliveryId: 'abc-123' })
  expect(parseSendSuccess('delivered to p (codex)')).toEqual({ ok: true })
  expect(parseSendSuccess('queued for p, depth 1')).toEqual({ ok: true })
  expect(parseSendSuccess('surprise').acceptance).toBe('unresolved')
})

test('only core/iapeer-system may supply acceptance, oversized attachment variant supported', () => {
  const body = JSON.stringify({ event: 'delivery-acceptance', ...event('delivered'), originalEnvelopeFile: '/ignored' })
  const env = parseIapEnvelope(`<iap from="iapeer-system" runtime="core" topic="delivery-acceptance"><msg>${body}</msg></iap>`)
  expect(parseAcceptanceEvent(env)?.deliveryId).toBe('delivery-1')
  expect(parseAcceptanceEvent({ ...env, fromRuntime: 'codex' })).toBeNull()
  expect(parseAcceptanceEvent({ ...env, fromPersonality: 'owner' })).toBeNull()
})
