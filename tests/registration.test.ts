import { describe, expect, test } from 'bun:test'
import { handleEnvelope, type RegistrationEnvelope } from '../src/registration.ts'
import { PeerProfileStore } from '../src/peerProfileStore.ts'
import { FakeTransport } from '../src/transport.ts'
import type { ScriptProbe } from '../src/format.ts'

// In-memory file system for the injected store: maps absolute path → contents.
// Registration writes ONLY here — never a real peer profile (HARD RULE).
function makeFs(initial: Record<string, string> = {}): {
  files: Record<string, string>
  store: PeerProfileStore
  writes: string[]
} {
  const files = { ...initial }
  const writes: string[] = []
  const store = new PeerProfileStore({
    peersIndexPath: '/reg/index.json',
    profilePathFor: cwd => `${cwd}/.iapeer/peer-profile.json`,
    readFile: p => {
      if (!(p in files)) throw new Error(`unexpected read ${p}`)
      return files[p]!
    },
    fileExists: p => p in files,
    writeFile: (p, content) => {
      files[p] = content
      writes.push(p)
    },
  })
  return { files, store, writes }
}

const okProbe: ScriptProbe = { exists: () => true, stat: () => ({ mode: 0o755, isFile: true }) }

// Registry with two peers; only `boris` and `arthur` are registered.
const REGISTRY = JSON.stringify({
  peers: [
    { personality: 'boris', cwd: '/peers/boris' },
    { personality: 'arthur', cwd: '/peers/arthur' },
  ],
})

function env(over: Partial<RegistrationEnvelope> & { message: string }): RegistrationEnvelope {
  return { fromPersonality: 'boris', topic: 'register', ...over }
}

function profileOf(files: Record<string, string>, cwd: string): any {
  const p = `${cwd}/.iapeer/peer-profile.json`
  return p in files ? JSON.parse(files[p]!) : undefined
}

describe('handleEnvelope — register (timer)', () => {
  test('writes the trigger into the REQUESTER profile with owner=from-personality and replies OK', () => {
    const { files, store, writes } = makeFs({ '/reg/index.json': REGISTRY })
    const transport = new FakeTransport()
    let reloads = 0
    const res = handleEnvelope(
      env({ message: JSON.stringify({ id: 'beat', when: '@every 30m', message: 'alive', target: 'boris' }) }),
      'timer',
      { store, transport, reloadCb: () => reloads++ },
    )
    expect(res.outcome).toBe('registered')
    expect(res.reloaded).toBe(true)
    expect(reloads).toBe(1)

    // Wrote ONLY boris's profile.
    expect(writes).toEqual(['/peers/boris/.iapeer/peer-profile.json'])
    const prof = profileOf(files, '/peers/boris')
    expect(prof.notifier.triggers).toEqual([
      { role: 'time', id: 'beat', owner: 'boris', target: 'boris', when: '@every 30m', message: 'alive' },
    ])
    // OK reply went back to boris (the requester) on the inbound topic.
    expect(transport.sent.length).toBe(1)
    expect(transport.sent[0]!.target).toBe('boris')
    expect(transport.sent[0]!.message).toContain('registered')
    expect(transport.sent[0]!.topic).toBe('register')
  })

  test('target "self" resolves to the requester', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    handleEnvelope(
      env({ fromPersonality: 'arthur', message: JSON.stringify({ id: 'x', when: '@every 1h', message: 'm', target: 'self' }) }),
      'timer',
      { store, transport: new FakeTransport() },
    )
    const prof = profileOf(files, '/peers/arthur')
    expect(prof.notifier.triggers[0].target).toBe('arthur')
    expect(prof.notifier.triggers[0].owner).toBe('arthur')
  })

  test('no id → auto content-hash id; same config registered twice = same id (idempotent)', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    const body = JSON.stringify({ when: '@every 10m', message: 'm', target: 'self' })
    handleEnvelope(env({ message: body }), 'timer', { store, transport: new FakeTransport() })
    handleEnvelope(env({ message: body }), 'timer', { store, transport: new FakeTransport() })
    const triggers = profileOf(files, '/peers/boris').notifier.triggers
    expect(triggers.length).toBe(1) // replace, not duplicate
    expect(typeof triggers[0].id).toBe('string')
  })

  test('re-registering the same id = REPLACE (not duplicate)', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(env({ message: JSON.stringify({ id: 'beat', when: '@every 30m', message: 'v1', target: 'self' }) }), 'timer', { store, transport: t })
    const res = handleEnvelope(env({ message: JSON.stringify({ id: 'beat', when: '@every 30m', message: 'v2', target: 'self' }) }), 'timer', { store, transport: t })
    expect(res.outcome).toBe('replaced')
    const triggers = profileOf(files, '/peers/boris').notifier.triggers
    expect(triggers.length).toBe(1)
    expect(triggers[0].message).toBe('v2')
  })

  test('PRESERVES unknown top-level profile fields (description/intelligence/interfaces)', () => {
    const { files, store } = makeFs({
      '/reg/index.json': REGISTRY,
      '/peers/boris/.iapeer/peer-profile.json': JSON.stringify({
        personality: 'boris',
        runtime: 'claude',
        description: 'keep me',
        intelligence: 'artificial',
        interfaces: { telegram: { bot: 'boris' } },
      }),
    })
    handleEnvelope(env({ message: JSON.stringify({ id: 'beat', when: '@every 30m', message: 'm', target: 'self' }) }), 'timer', {
      store,
      transport: new FakeTransport(),
    })
    const prof = profileOf(files, '/peers/boris')
    expect(prof.description).toBe('keep me')
    expect(prof.intelligence).toBe('artificial')
    expect(prof.interfaces).toEqual({ telegram: { bot: 'boris' } })
    expect(prof.personality).toBe('boris')
    expect(prof.notifier.triggers.length).toBe(1)
  })
})

describe('handleEnvelope — register (watcher)', () => {
  test('writes a role:event trigger and validates script format (never runs it)', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    const res = handleEnvelope(
      env({ message: JSON.stringify({ id: 'errwatch', script: 'tail -F /x | grep ERR', target: 'self', heartbeatSec: 30 }) }),
      'watcher',
      { store, transport: new FakeTransport(), scriptProbe: okProbe },
    )
    expect(res.outcome).toBe('registered')
    const t = profileOf(files, '/peers/boris').notifier.triggers[0]
    expect(t).toEqual({ role: 'event', id: 'errwatch', owner: 'boris', target: 'boris', script: 'tail -F /x | grep ERR', heartbeatSec: 30 })
  })
})

describe('handleEnvelope — security invariant', () => {
  test('writes ONLY to the requester profile, never the target peer profile', () => {
    const { files, store, writes } = makeFs({ '/reg/index.json': REGISTRY })
    // boris registers a trigger whose TARGET is arthur. The owner (and the only
    // profile written) must be boris — boris cannot put a trigger in arthur's
    // profile.
    handleEnvelope(
      env({ fromPersonality: 'boris', message: JSON.stringify({ id: 'ping', when: '@every 5m', message: 'm', target: 'arthur' }) }),
      'timer',
      { store, transport: new FakeTransport() },
    )
    expect(writes).toEqual(['/peers/boris/.iapeer/peer-profile.json'])
    expect(profileOf(files, '/peers/arthur')).toBeUndefined() // arthur's profile untouched
    const t = profileOf(files, '/peers/boris').notifier.triggers[0]
    expect(t.owner).toBe('boris')
    expect(t.target).toBe('arthur')
  })

  test('a foreign requester not in the registry → teaching error, no write, no reload', () => {
    const { store, writes } = makeFs({ '/reg/index.json': REGISTRY })
    const transport = new FakeTransport()
    let reloads = 0
    const res = handleEnvelope(
      env({ fromPersonality: 'stranger', message: JSON.stringify({ when: '@every 5m', message: 'm', target: 'self' }) }),
      'timer',
      { store, transport, reloadCb: () => reloads++ },
    )
    expect(res.outcome).toBe('rejected')
    expect(writes).toEqual([])
    expect(reloads).toBe(0)
    expect(transport.sent[0]!.target).toBe('stranger')
    expect(transport.sent[0]!.message).toContain('not in the peer registry')
  })
})

describe('handleEnvelope — invalid config teaches', () => {
  test('a bad config → teaching reply, no write, no reload', () => {
    const { store, writes } = makeFs({ '/reg/index.json': REGISTRY })
    const transport = new FakeTransport()
    let reloads = 0
    const res = handleEnvelope(env({ message: '{not json' }), 'timer', { store, transport, reloadCb: () => reloads++ })
    expect(res.outcome).toBe('rejected')
    expect(writes).toEqual([])
    expect(reloads).toBe(0)
    expect(transport.sent[0]!.message).toContain('not valid JSON')
    // The teaching reply carries an example the requester can copy.
    expect(transport.sent[0]!.message).toContain('"when"')
  })
})

describe('handleEnvelope — unregister', () => {
  test('removes the trigger by id, reloads, replies', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(env({ message: JSON.stringify({ id: 'beat', when: '@every 30m', message: 'm', target: 'self' }) }), 'timer', { store, transport: t })
    expect(profileOf(files, '/peers/boris').notifier.triggers.length).toBe(1)

    let reloads = 0
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'unregister', id: 'beat' }) }), 'timer', {
      store,
      transport: t,
      reloadCb: () => reloads++,
    })
    expect(res.outcome).toBe('unregistered')
    expect(reloads).toBe(1)
    expect(profileOf(files, '/peers/boris').notifier.triggers.length).toBe(0)
    expect(t.sent.at(-1)!.message).toContain('unregistered')
  })

  test('unregister a non-existent id → not-found reply, no reload', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const transport = new FakeTransport()
    let reloads = 0
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'unregister', id: 'ghost' }) }), 'timer', {
      store,
      transport,
      reloadCb: () => reloads++,
    })
    expect(res.outcome).toBe('not-found')
    expect(reloads).toBe(0)
    expect(transport.sent[0]!.message).toContain('no trigger with id "ghost"')
  })
})

describe('handleEnvelope — list', () => {
  test('returns the requester own triggers, never reloads', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(env({ message: JSON.stringify({ id: 'a', when: '@every 5m', message: 'm', target: 'self' }) }), 'timer', { store, transport: t })
    handleEnvelope(env({ message: JSON.stringify({ id: 'b', when: '@every 1h', message: 'm', target: 'boris' }) }), 'timer', { store, transport: t })

    let reloads = 0
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'list' }) }), 'timer', { store, transport: t, reloadCb: () => reloads++ })
    expect(res.outcome).toBe('listed')
    expect(reloads).toBe(0)
    const reply = t.sent.at(-1)!.message
    expect(reply).toContain('a')
    expect(reply).toContain('b')
  })

  test('list with no triggers → friendly empty reply nudging help', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const transport = new FakeTransport()
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'list' }) }), 'timer', { store, transport })
    expect(res.outcome).toBe('listed')
    expect(transport.sent[0]!.message).toContain('none yet')
    expect(transport.sent[0]!.message).toContain('help')
  })

  // Spec §Команды line 31: list returns "триггеры requester (этой роли)" — of
  // THIS role. A peer with both a timer and a watcher trigger must NOT see the
  // cross-role trigger when it lists from a single role's session.
  test('list is scoped to the session role — timer session hides watcher triggers (and vice versa)', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    // boris registers one timer trigger and one watcher trigger.
    handleEnvelope(
      env({ message: JSON.stringify({ id: 'mytimer', when: '@every 5m', message: 'm', target: 'self' }) }),
      'timer',
      { store, transport: t },
    )
    handleEnvelope(
      env({ message: JSON.stringify({ id: 'mywatch', script: 'tail -F /x', target: 'self' }) }),
      'watcher',
      { store, transport: t, scriptProbe: okProbe },
    )

    // timer session list → only the timer trigger.
    const timerList = handleEnvelope(env({ message: JSON.stringify({ cmd: 'list' }) }), 'timer', { store, transport: t })
    expect(timerList.outcome).toBe('listed')
    expect(timerList.reply).toContain('mytimer')
    expect(timerList.reply).not.toContain('mywatch')

    // watcher session list → only the watcher trigger.
    const watcherList = handleEnvelope(env({ message: JSON.stringify({ cmd: 'list' }) }), 'watcher', { store, transport: t })
    expect(watcherList.outcome).toBe('listed')
    expect(watcherList.reply).toContain('mywatch')
    expect(watcherList.reply).not.toContain('mytimer')
  })
})

describe('handleEnvelope — unregister is role-scoped', () => {
  test('timer session cannot delete a watcher id (no-op not-found, leaves event trigger intact)', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(
      env({ message: JSON.stringify({ id: 'mytimer', when: '@every 5m', message: 'm', target: 'self' }) }),
      'timer',
      { store, transport: t },
    )
    handleEnvelope(
      env({ message: JSON.stringify({ id: 'mywatch', script: 'tail -F /x', target: 'self' }) }),
      'watcher',
      { store, transport: t, scriptProbe: okProbe },
    )

    let reloads = 0
    // timer session tries to unregister the watcher id → must be a no-op.
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'unregister', id: 'mywatch' }) }), 'timer', {
      store,
      transport: t,
      reloadCb: () => reloads++,
    })
    expect(res.outcome).toBe('not-found')
    expect(reloads).toBe(0)
    // The watcher trigger is still present.
    const ids = profileOf(files, '/peers/boris').notifier.triggers.map((tr: any) => tr.id)
    expect(ids).toContain('mywatch')
    expect(ids).toContain('mytimer')
  })
})

// CLI-like replies: register / list / unregister / help all
// end with the owner's active triggers (this role) + a one-line control hint, so a
// peer manages its triggers straight from the reply — no command format loaded up
// front. The control line carries an <id> placeholder; the active list supplies the
// concrete ids.
describe('handleEnvelope — CLI-like replies', () => {
  const CONTROL = 'Remove: {"cmd":"unregister","id":"<id>"}  ·  Refresh: {"cmd":"list"}'

  test('register reply shows the action + active triggers + control hint', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    const res = handleEnvelope(
      env({ message: JSON.stringify({ id: 'beat', when: '@every 30m', message: 'm', target: 'self', topic: 'health' }) }),
      'timer',
      { store, transport: t },
    )
    expect(res.outcome).toBe('registered')
    const reply = t.sent.at(-1)!.message
    expect(reply).toContain('registered') // the action
    expect(reply).toContain('beat — @every 30m → boris') // active-trigger line: id — when → target
    expect(reply).toContain('topic health')
    expect(reply).toContain(CONTROL) // removal/refresh control line, verbatim
  })

  test('watcher register line shows id — script → target with heartbeat', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(
      env({ message: JSON.stringify({ id: 'w1', script: 'tail -F /x', target: 'self', heartbeatSec: 30 }) }),
      'watcher',
      { store, transport: t, scriptProbe: okProbe },
    )
    const reply = t.sent.at(-1)!.message
    expect(reply).toContain('w1 — tail -F /x → boris')
    expect(reply).toContain('heartbeat 30s')
    expect(reply).toContain(CONTROL)
  })

  test('list reply shows every active trigger + control hint', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(env({ message: JSON.stringify({ id: 'a', when: '@every 5m', message: 'm', target: 'self' }) }), 'timer', { store, transport: t })
    handleEnvelope(env({ message: JSON.stringify({ id: 'b', when: '0 9 * * *', message: 'm', target: 'boris' }) }), 'timer', { store, transport: t })
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'list' }) }), 'timer', { store, transport: t })
    expect(res.outcome).toBe('listed')
    const reply = t.sent.at(-1)!.message
    expect(reply).toContain('a — @every 5m → boris')
    expect(reply).toContain('b — 0 9 * * * → boris')
    expect(reply).toContain(CONTROL)
  })

  test('unregister reply confirms + shows the REMAINING active triggers', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(env({ message: JSON.stringify({ id: 'keep', when: '@every 5m', message: 'm', target: 'self' }) }), 'timer', { store, transport: t })
    handleEnvelope(env({ message: JSON.stringify({ id: 'drop', when: '@every 1h', message: 'm', target: 'self' }) }), 'timer', { store, transport: t })
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'unregister', id: 'drop' }) }), 'timer', { store, transport: t })
    expect(res.outcome).toBe('unregistered')
    const reply = t.sent.at(-1)!.message
    expect(reply).toContain('unregistered')
    expect(reply).toContain('"drop"')
    expect(reply).toContain('keep — @every 5m → boris') // the survivor is shown
    expect(reply).not.toContain('drop — ') // the removed one is gone from the list
    expect(reply).toContain(CONTROL)
  })

  test('not-found unregister still shows what you DO have', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    const t = new FakeTransport()
    handleEnvelope(env({ message: JSON.stringify({ id: 'real', when: '@every 5m', message: 'm', target: 'self' }) }), 'timer', { store, transport: t })
    const res = handleEnvelope(env({ message: JSON.stringify({ cmd: 'unregister', id: 'ghost' }) }), 'timer', { store, transport: t })
    expect(res.outcome).toBe('not-found')
    const reply = t.sent.at(-1)!.message
    expect(reply).toContain('no trigger with id "ghost"')
    expect(reply).toContain('real — @every 5m → boris')
  })

  for (const body of ['help', '?', '{"cmd":"help"}', '"help"']) {
    test(`help via ${body} → active triggers + format, friendly (not error), no reload`, () => {
      const { store } = makeFs({ '/reg/index.json': REGISTRY })
      const t = new FakeTransport()
      handleEnvelope(env({ message: JSON.stringify({ id: 'h1', when: '@every 5m', message: 'm', target: 'self' }) }), 'timer', { store, transport: t })
      let reloads = 0
      const res = handleEnvelope(env({ message: body }), 'timer', { store, transport: t, reloadCb: () => reloads++ })
      expect(res.outcome).toBe('helped')
      expect(reloads).toBe(0)
      const reply = t.sent.at(-1)!.message
      expect(reply).toContain('h1 — @every 5m → boris') // active triggers
      expect(reply).toContain('notifier-timer') // describeFormat header (the registration format)
      expect(reply).not.toContain('not valid JSON') // friendly, NOT a teaching error
    })
  }
})

describe('PeerProfileStore — explicit id round-trips through projection', () => {
  test('a stored explicit id survives a list read', () => {
    const { store } = makeFs({ '/reg/index.json': REGISTRY })
    handleEnvelope(env({ message: JSON.stringify({ id: 'named', when: '@every 5m', message: 'm', target: 'self' }) }), 'timer', { store, transport: new FakeTransport() })
    const triggers = store.list('/peers/boris')
    expect(triggers[0]!.id).toBe('named')
  })
})

describe('PeerProfileStore.isEphemeral', () => {
  const profilePath = '/peers/p/.iapeer/peer-profile.json'
  const withProfile = (body?: string) =>
    makeFs(body === undefined ? {} : { [profilePath]: body }).store

  test('wake_policy "ephemeral" → true', () => {
    expect(withProfile(JSON.stringify({ personality: 'p', wake_policy: 'ephemeral' })).isEphemeral('/peers/p')).toBe(true)
  })
  test('wake_policy absent → false (ordinary durable peer)', () => {
    expect(withProfile(JSON.stringify({ personality: 'p' })).isEphemeral('/peers/p')).toBe(false)
  })
  test('wake_policy some other value → false (only "ephemeral" suppresses)', () => {
    expect(withProfile(JSON.stringify({ personality: 'p', wake_policy: 'durable' })).isEphemeral('/peers/p')).toBe(false)
  })
  test('no profile file at all → false', () => {
    expect(withProfile(undefined).isEphemeral('/peers/p')).toBe(false)
  })
})

// ADR-006: a delivered envelope SPAWNS an ephemeral (FaaS) peer a fresh worker
// session. So the notifier must NOT deliver a registration reply to an ephemeral
// requester — the ack is gratuitous (it verifies success by READING STATE) and a
// delivered reply would spawn a spurious session. Registration STILL writes state
// and reloads the engine; only the wire delivery of the reply is suppressed.
describe('handleEnvelope — ephemeral requester reply-suppression', () => {
  const EPH_REGISTRY = JSON.stringify({
    peers: [
      { personality: 'index', cwd: '/peers/index' },
      { personality: 'boris', cwd: '/peers/boris' },
    ],
  })
  const ephFs = () =>
    makeFs({
      '/reg/index.json': EPH_REGISTRY,
      '/peers/index/.iapeer/peer-profile.json': JSON.stringify({ personality: 'index', wake_policy: 'ephemeral' }),
    })

  test('register from ephemeral: state written + reloaded, but NO reply delivered (no spawn)', () => {
    const { files, store, writes } = ephFs()
    const transport = new FakeTransport()
    let reloads = 0
    const res = handleEnvelope(
      env({ fromPersonality: 'index', message: JSON.stringify({ id: 'beat', when: '@every 30m', message: 'm', target: 'self' }) }),
      'timer',
      { store, transport, reloadCb: () => reloads++ },
    )
    expect(res.outcome).toBe('registered') // registration still succeeds
    expect(res.reloaded).toBe(true) // live engine still reloaded
    expect(reloads).toBe(1)
    // durable trigger written into the ephemeral peer's own profile
    expect(writes).toEqual(['/peers/index/.iapeer/peer-profile.json'])
    expect(profileOf(files, '/peers/index').notifier.triggers[0].id).toBe('beat')
    // the spurious ack is NOT delivered → no spawn
    expect(transport.sent).toEqual([])
  })

  test('malformed body from ephemeral: rejected, no write, error reply also suppressed', () => {
    const { store, writes } = ephFs()
    const transport = new FakeTransport()
    const res = handleEnvelope(env({ fromPersonality: 'index', message: '{not json' }), 'timer', { store, transport })
    expect(res.outcome).toBe('rejected')
    expect(writes).toEqual([])
    // error reply suppressed too: no deliverable reply on ANY register input → no spawn
    expect(transport.sent).toEqual([])
    // the text still flows back in the result for logging/tests
    expect(res.reply).toContain('not valid JSON')
  })

  test('list/help from ephemeral are suppressed as well (any reply spawns it)', () => {
    const { store } = ephFs()
    const transport = new FakeTransport()
    const list = handleEnvelope(env({ fromPersonality: 'index', message: JSON.stringify({ cmd: 'list' }) }), 'timer', { store, transport })
    const help = handleEnvelope(env({ fromPersonality: 'index', message: 'help' }), 'timer', { store, transport })
    expect(list.outcome).toBe('listed')
    expect(help.outcome).toBe('helped')
    expect(transport.sent).toEqual([])
  })

  test('a DURABLE requester is unaffected — reply still delivered as before', () => {
    const { store } = ephFs()
    const transport = new FakeTransport()
    handleEnvelope(
      env({ fromPersonality: 'boris', message: JSON.stringify({ id: 'b', when: '@every 5m', message: 'm', target: 'self' }) }),
      'timer',
      { store, transport },
    )
    expect(transport.sent.length).toBe(1) // boris (no wake_policy) keeps interactive feedback
    expect(transport.sent[0]!.message).toContain('registered')
  })
})

describe('handleEnvelope — fallback field (escalation chain)', () => {
  test('register stores the resolved fallback ("self" → requester) and the reply shows it', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    const transport = new FakeTransport()
    const res = handleEnvelope(
      env({
        message: JSON.stringify({
          id: 'prl-monitor',
          when: '@every 5m',
          message: 'MINER DOWN',
          target: 'arthur',
          fallback: ['self', 'arthur'],
        }),
      }),
      'timer',
      { store, transport },
    )
    expect(res.outcome).toBe('registered')
    const prof = profileOf(files, '/peers/boris')
    expect(prof.notifier.triggers[0]).toMatchObject({
      id: 'prl-monitor',
      owner: 'boris',
      target: 'arthur',
      fallback: ['boris', 'arthur'],
    })
    // The CLI reply line surfaces the chain so the owner can verify at a glance.
    expect(transport.sent[0]!.message).toContain('fallback boris→arthur')
  })

  test('watcher register with fallback persists it alongside heartbeatSec', () => {
    const { files, store } = makeFs({ '/reg/index.json': REGISTRY })
    const transport = new FakeTransport()
    const res = handleEnvelope(
      env({
        message: JSON.stringify({
          id: 'prl-watch',
          script: '/usr/local/bin/prl-monitor.sh',
          target: 'arthur',
          heartbeatSec: 600,
          fallback: 'arthur',
        }),
      }),
      'watcher',
      { store, transport, scriptProbe: okProbe },
    )
    expect(res.outcome).toBe('registered')
    const prof = profileOf(files, '/peers/boris')
    expect(prof.notifier.triggers[0]).toMatchObject({
      role: 'event',
      id: 'prl-watch',
      fallback: ['arthur'],
      heartbeatSec: 600,
    })
  })
})
