import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Escalator, InMemorySpool, makeFileSpool, type SpoolEntry } from '../src/escalation.ts'
import { LostReporter, buildLostDigest } from '../src/lostReport.ts'
import { checkReachable, parseRegistry, telegramRelays } from '../src/reachability.ts'
import { handleEnvelope } from '../src/registration.ts'
import { PeerProfileStore } from '../src/peerProfileStore.ts'
import { FakeTransport, type AsyncTransport, type SendResult, type Signal } from '../src/transport.ts'

// Registry mirroring the live fleet shape (26.08–17.10 incident).
const RAW = {
  peers: [
    { personality: 'arthur', cwd: '/peers/arthur', intelligence: 'natural', interfaces: { telegram: { user_id: '1' } } },
    { personality: 'boris', cwd: '/peers/boris', intelligence: 'artificial', interfaces: { telegram: { bot_username: 'boris_bot' } } },
    { personality: 'doc', cwd: '/peers/doc', intelligence: 'artificial', interfaces: { telegram: { bot_username: 'doc_bot' } } },
    { personality: 'mrbooker', cwd: '/peers/mrbooker', intelligence: 'artificial' },
    { personality: 'timer', cwd: '/peers/timer', intelligence: 'absent' },
    { personality: 'watcher', cwd: '/peers/watcher', intelligence: 'absent' },
  ],
}
const REG = parseRegistry(RAW)

class ScriptTransport implements AsyncTransport {
  calls: Signal[] = []
  constructor(private readonly ok: (to: string) => boolean) {}
  send(sig: Signal): Promise<SendResult> {
    this.calls.push(sig)
    return Promise.resolve(this.ok(sig.target) ? { ok: true } : { ok: false, error: `peer "${sig.target}" offline and wake failed: never-became-ready` })
  }
}

const immediate = (_ms: number, cb: () => void) => {
  queueMicrotask(cb)
  return () => {}
}

describe('reachability', () => {
  test('human from a faceless notifier → error naming telegram relays', () => {
    const r = checkReachable('arthur', 'timer', REG)
    expect(r?.level).toBe('error')
    expect(r?.reason).toContain('telegram')
    expect(r?.reason).toContain('"boris"')
  })
  test('human is reachable when the sender HAS a telegram face', () => {
    const reg = parseRegistry({
      peers: [...RAW.peers.filter(p => p.personality !== 'timer'), { personality: 'timer', intelligence: 'absent', interfaces: { telegram: { bot_username: 't_bot' } } }],
    })
    expect(checkReachable('arthur', 'timer', reg)).toBeNull()
  })
  test('model-less program peer → error; agent → ok; unknown → warn; empty registry → silent', () => {
    expect(checkReachable('watcher', 'timer', REG)?.level).toBe('error')
    expect(checkReachable('boris', 'timer', REG)).toBeNull()
    expect(checkReachable('ghost', 'timer', REG)?.level).toBe('warn')
    expect(checkReachable('arthur', 'timer', new Map())).toBeNull()
  })
  test('telegramRelays = telegram-faced agents only', () => {
    expect(telegramRelays(REG)).toEqual(['boris', 'doc'])
  })
})

describe('register — dead link in the chain (hole 1)', () => {
  function fs() {
    const files: Record<string, string> = { '/reg/index.json': JSON.stringify(RAW) }
    const store = new PeerProfileStore({
      peersIndexPath: '/reg/index.json',
      profilePathFor: cwd => `${cwd}/.iapeer/peer-profile.json`,
      readFile: p => files[p]!,
      fileExists: p => p in files,
      writeFile: (p, c) => {
        files[p] = c
      },
    })
    return { files, store }
  }
  test('timer trigger with fallback arthur → loud REFUSAL, nothing written, no reload', () => {
    const { files, store } = fs()
    const transport = new FakeTransport()
    let reloads = 0
    const res = handleEnvelope(
      {
        fromPersonality: 'mrbooker',
        message: JSON.stringify({ id: 'zayavka', when: '*/5 * * * *', message: 'сверка', target: 'self', fallback: ['arthur', 'boris'] }),
      },
      'timer',
      { store, transport, reloadCb: () => reloads++, registry: () => REG },
    )
    expect(res.outcome).toBe('rejected')
    expect(res.reply).toContain('REFUSED')
    expect(res.reply).toContain('fallback "arthur" is a human')
    expect(transport.sent[0]!.message).toBe(res.reply)
    expect(reloads).toBe(0)
    expect('/peers/mrbooker/.iapeer/peer-profile.json' in files).toBe(false)
  })
  test('target arthur → refused too', () => {
    const { store } = fs()
    const res = handleEnvelope(
      { fromPersonality: 'boris', message: JSON.stringify({ when: '@every 1h', message: 'x', target: 'arthur' }) },
      'timer',
      { store, transport: new FakeTransport(), registry: () => REG },
    )
    expect(res.outcome).toBe('rejected')
    expect(res.reply).toContain('target "arthur" is a human')
  })
  test('unknown fallback → registered WITH a warning in the reply', () => {
    const { store } = fs()
    const res = handleEnvelope(
      { fromPersonality: 'mrbooker', message: JSON.stringify({ when: '@every 1h', message: 'x', target: 'self', fallback: 'ghost' }) },
      'timer',
      { store, transport: new FakeTransport(), registry: () => REG },
    )
    expect(res.outcome).toBe('registered')
    expect(res.reply).toContain('⚠ fallback "ghost" is not in the peer registry')
  })
  test('valid chain via a telegram-faced relay → registered, no warning', () => {
    const { store } = fs()
    const res = handleEnvelope(
      { fromPersonality: 'mrbooker', message: JSON.stringify({ when: '@every 1h', message: 'x', target: 'self', fallback: 'boris' }) },
      'timer',
      { store, transport: new FakeTransport(), registry: () => REG },
    )
    expect(res.outcome).toBe('registered')
    expect(res.reply).not.toContain('⚠')
  })
})

describe('Escalator — runtime dead-link skip', () => {
  test('a dead fallback is skipped without a send; the attempt is recorded', async () => {
    const spool = new InMemorySpool()
    const transport = new ScriptTransport(to => to === 'boris')
    const logs: string[] = []
    const esc = new Escalator(
      {
        transport,
        spool,
        log: e => logs.push(e),
        setTimer: immediate,
        now: () => new Date('2026-10-17T00:00:00Z'),
        deadLink: p => (p === 'arthur' ? 'human, no telegram face' : null),
      },
      { backstop: 'boris' },
    )
    await esc.deliver({ kind: 'fire', target: 'mrbooker', owner: 'mrbooker', fallbacks: ['arthur'], message: 'сверка' })
    expect(transport.calls.map(c => c.target)).toEqual(['mrbooker', 'mrbooker', 'boris'])
    expect(logs).toContain('link-skipped')
    expect(transport.calls[2]!.message).toContain('arthur×1 (last error: skipped: human, no telegram face)')
  })
})

function lostEntry(i: number, over: Partial<SpoolEntry> = {}): SpoolEntry {
  return {
    v: 1,
    id: `l${i}`,
    createdAt: `2026-10-17T0${i}:00:00.000Z`,
    kind: 'fire',
    target: 'linus',
    message: 'майнинг',
    topic: 'prl',
    owner: 'linus',
    chain: ['linus', 'boris'],
    attempts: [{ target: 'boris', at: 'x', error: 'wake failed' }],
    status: 'lost',
    meta: { id: 'mining' },
    ...over,
  }
}

describe('LostReporter (hole 2)', () => {
  test('digest groups by trigger with counts, period and relay instruction', () => {
    const msg = buildLostDigest([lostEntry(1), lostEntry(2, { coalesced: 2 }), lostEntry(3, { owner: 'mrbooker', target: 'mrbooker', meta: { id: 'заявка' } })], 'notifier-timer', '/spool')
    expect(msg).toContain('5 signal(s)')
    expect(msg).toContain('4× fire owner=linus trigger=mining → linus topic=prl | 2026-10-17T01:00:00.000Z … 2026-10-17T02:00:00.000Z')
    expect(msg).toContain('1× fire owner=mrbooker trigger=заявка')
    expect(msg).toContain('send_to_peer arthur')
    expect(msg).toContain('owner(s): linus, mrbooker')
  })

  test('all relays dead → nothing marked, retried next tick; first live relay → marked once', async () => {
    const spool = new InMemorySpool()
    for (let i = 1; i <= 3; i++) spool.put(lostEntry(i))
    spool.put(lostEntry(4, { status: 'pending' }))
    let alive = false
    const transport = new ScriptTransport(to => alive && to === 'doc')
    const logs: Array<[string, Record<string, unknown> | undefined]> = []
    const rep = new LostReporter({
      spool,
      transport,
      relays: () => ['boris', 'doc'],
      log: (e, f) => logs.push([e, f]),
      now: () => new Date('2026-10-17T10:00:00Z'),
      identity: 'notifier-timer',
      spoolDir: '/spool',
    })
    expect(await rep.tick()).toBe('failed')
    expect(spool.loadUnreportedLost()).toHaveLength(3)
    alive = true
    expect(await rep.tick()).toBe('sent')
    expect(transport.calls.at(-1)!.target).toBe('doc')
    expect(transport.calls.at(-1)!.topic).toBe('notifier-lost')
    expect(spool.loadUnreportedLost()).toHaveLength(0)
    expect(spool.entries.get('l1')!.reportedAt).toBe('2026-10-17T10:00:00.000Z')
    const before = transport.calls.length
    expect(await rep.tick()).toBe('idle')
    expect(transport.calls.length).toBe(before) // no re-report, no storm
  })

  test('file spool: loadUnreportedLost sees only unreported "lost" entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-lost-'))
    const spool = makeFileSpool(dir)
    spool.put(lostEntry(1))
    spool.put(lostEntry(2, { reportedAt: 'x' }))
    spool.put(lostEntry(3, { status: 'pending' }))
    spool.put(lostEntry(4, { status: 'flooded' }))
    expect(spool.loadUnreportedLost().map(e => e.id)).toEqual(['l1'])
    expect(spool.loadPending().map(e => e.id)).toEqual(['l3'])
    expect(readdirSync(dir)).toHaveLength(4)
    expect(JSON.parse(readFileSync(join(dir, 'l2.json'), 'utf8')).reportedAt).toBe('x')
  })
})
