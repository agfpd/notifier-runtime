import { describe, expect, test } from 'bun:test'
import {
  describeFormat,
  EXAMPLES,
  parseRegistration,
  type ScriptProbe,
} from '../src/format.ts'

// A script probe that says "every path exists, is a file, and is executable".
// Lets watcher-register tests validate FORMAT without touching disk.
const okProbe: ScriptProbe = {
  exists: () => true,
  stat: () => ({ mode: 0o755, isFile: true }),
}

describe('format invariant — EXAMPLES are the single source', () => {
  // THE reliability invariant (SPEC_F4 §format.ts): every canonical example
  // parses to ok:true for its role, AND describeFormat embeds those same
  // strings. Same module = source of truth → the doc a peer reads can never
  // drift from the parser.
  for (const role of ['timer', 'watcher'] as const) {
    test(`every EXAMPLES.${role} string parses to ok:true`, () => {
      expect(EXAMPLES[role].length).toBeGreaterThan(0)
      for (const example of EXAMPLES[role]) {
        const result = parseRegistration(role, example, { scriptProbe: okProbe })
        if (!result.ok) throw new Error(`example failed to parse: ${example}\n${result.error}`)
        expect(result.ok).toBe(true)
      }
    })

    test(`describeFormat(${role}) embeds every EXAMPLES.${role} string verbatim`, () => {
      const doc = describeFormat(role)
      for (const example of EXAMPLES[role]) {
        expect(doc).toContain(example)
      }
    })
  }
})

describe('parseRegistration — timer register (valid)', () => {
  test('full timer config (cron, check, topic, explicit id)', () => {
    const body = JSON.stringify({
      id: 'morning',
      when: '0 9 * * *',
      check: '/usr/bin/true',
      message: 'standup',
      target: 'boris',
      topic: 'ops',
    })
    const r = parseRegistration('timer', body)
    expect(r.ok).toBe(true)
    if (r.ok && r.command.kind === 'register' && r.command.role === 'timer') {
      expect(r.command.config).toEqual({
        id: 'morning',
        when: '0 9 * * *',
        check: '/usr/bin/true',
        message: 'standup',
        target: 'boris',
        topic: 'ops',
      })
    } else {
      throw new Error('expected a timer register command')
    }
  })

  test('minimal timer config (interval, target self, no id)', () => {
    const r = parseRegistration('timer', JSON.stringify({ when: '@every 5m', message: 'beat', target: 'self' }))
    expect(r.ok).toBe(true)
    if (r.ok && r.command.kind === 'register' && r.command.role === 'timer') {
      expect(r.command.config.id).toBeUndefined()
      expect(r.command.config.target).toBe('self')
    }
  })

  test('explicit cmd:"register" is accepted', () => {
    const r = parseRegistration('timer', JSON.stringify({ cmd: 'register', when: '@every 1h', message: 'x', target: 'self' }))
    expect(r.ok).toBe(true)
  })
})

describe('parseRegistration — watcher register (valid)', () => {
  test('full watcher config (bare command, heartbeat, topic, id)', () => {
    const body = JSON.stringify({
      id: 'errwatch',
      script: 'tail -F /var/log/app.log | grep ERROR',
      target: 'boris',
      heartbeatSec: 60,
      topic: 'errors',
    })
    const r = parseRegistration('watcher', body, { scriptProbe: okProbe })
    expect(r.ok).toBe(true)
    if (r.ok && r.command.kind === 'register' && r.command.role === 'watcher') {
      expect(r.command.config).toEqual({
        id: 'errwatch',
        script: 'tail -F /var/log/app.log | grep ERROR',
        target: 'boris',
        heartbeatSec: 60,
        topic: 'errors',
      })
    } else {
      throw new Error('expected a watcher register command')
    }
  })

  test('a path-like script that exists+executable validates (FORMAT only, never run)', () => {
    const r = parseRegistration('watcher', JSON.stringify({ script: '/opt/watch.sh', target: 'self' }), {
      scriptProbe: { exists: () => true, stat: () => ({ mode: 0o755, isFile: true }) },
    })
    expect(r.ok).toBe(true)
  })
})

describe('parseRegistration — teaching errors (include format + example)', () => {
  // Every rejection must teach: the reply embeds the full describeFormat (which
  // embeds EXAMPLES). We assert the reply CONTAINS the format doc.
  function assertTeaches(role: 'timer' | 'watcher', error: string): void {
    expect(error).toContain(describeFormat(role))
  }

  test('broken JSON → teaching', () => {
    const r = parseRegistration('timer', '{not json')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('not valid JSON')
      assertTeaches('timer', r.error)
    }
  })

  test('timer missing when → teaching', () => {
    const r = parseRegistration('timer', JSON.stringify({ message: 'x', target: 'self' }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('missing "when"')
      assertTeaches('timer', r.error)
    }
  })

  test('timer bad when → teaching', () => {
    const r = parseRegistration('timer', JSON.stringify({ when: 'not-a-cron', message: 'x', target: 'self' }))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('invalid "when"')
      assertTeaches('timer', r.error)
    }
  })

  test('timer missing message → teaching', () => {
    const r = parseRegistration('timer', JSON.stringify({ when: '@every 5m', target: 'self' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('missing non-empty "message"')
  })

  test('timer bad target → teaching', () => {
    const r = parseRegistration('timer', JSON.stringify({ when: '@every 5m', message: 'x', target: 'BAD NAME' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('invalid target')
  })

  test('watcher missing script → teaching', () => {
    const r = parseRegistration('watcher', JSON.stringify({ target: 'self' }), { scriptProbe: okProbe })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('missing non-empty "script"')
      assertTeaches('watcher', r.error)
    }
  })

  test('watcher path script not found → teaching (FORMAT check)', () => {
    const r = parseRegistration('watcher', JSON.stringify({ script: '/nope/missing.sh', target: 'self' }), {
      scriptProbe: { exists: () => false, stat: () => null },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('script not found')
  })

  test('watcher path script not executable → teaching', () => {
    const r = parseRegistration('watcher', JSON.stringify({ script: '/opt/x.sh', target: 'self' }), {
      scriptProbe: { exists: () => true, stat: () => ({ mode: 0o644, isFile: true }) },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not executable')
  })

  test('bad id (invalid name) → teaching', () => {
    const r = parseRegistration('timer', JSON.stringify({ id: 'Bad Id', when: '@every 5m', message: 'x', target: 'self' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('invalid id')
  })

  test('unknown cmd → teaching', () => {
    const r = parseRegistration('timer', JSON.stringify({ cmd: 'frobnicate' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('unknown cmd')
  })
})

describe('parseRegistration — cross-role rejection', () => {
  test('a watcher config sent to the timer role → rejected (no script field on timer)', () => {
    // {script,target} has no `when`/`message` → the timer parser rejects it as a
    // malformed timer register (a peer cannot register the wrong primitive on the
    // wrong session).
    const r = parseRegistration('timer', JSON.stringify({ script: '/opt/x.sh', target: 'self' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('missing "when"')
  })

  test('a timer config sent to the watcher role → rejected (no script)', () => {
    const r = parseRegistration('watcher', JSON.stringify({ when: '@every 5m', message: 'x', target: 'self' }), {
      scriptProbe: okProbe,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('missing non-empty "script"')
  })
})

describe('parseRegistration — unregister / list', () => {
  test('unregister with id → command', () => {
    const r = parseRegistration('timer', JSON.stringify({ cmd: 'unregister', id: 'morning' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command).toEqual({ kind: 'unregister', id: 'morning' })
  })

  test('unregister without id → teaching', () => {
    const r = parseRegistration('timer', JSON.stringify({ cmd: 'unregister' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('unregister requires')
  })

  test('list → command', () => {
    const r = parseRegistration('watcher', JSON.stringify({ cmd: 'list' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command).toEqual({ kind: 'list' })
  })
})

describe('parseRegistration — help (conversational entry, NOT an error)', () => {
  // Bare "help"/"?" are not JSON; {"cmd":"help"} and "help" (quoted) are. All four
  // resolve to the help command so a peer can ask without knowing the format.
  for (const [label, body] of [
    ['bare help', 'help'],
    ['bare HELP (case-insensitive)', 'HELP'],
    ['bare ?', '?'],
    ['padded help', '   help  '],
    ['{"cmd":"help"}', JSON.stringify({ cmd: 'help' })],
    ['quoted "help"', JSON.stringify('help')],
  ] as const) {
    test(`${label} → help command for both roles`, () => {
      for (const role of ['timer', 'watcher'] as const) {
        const r = parseRegistration(role, body)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.command).toEqual({ kind: 'help' })
      }
    })
  }
})

describe('fallback field (escalation chain)', () => {
  test('single name normalizes to an array, both roles', () => {
    const t = parseRegistration('timer', JSON.stringify({ when: '@every 5m', message: 'm', target: 'linus', fallback: 'boris' }))
    expect(t).toMatchObject({ ok: true, command: { kind: 'register', config: { fallback: ['boris'] } } })
    const w = parseRegistration(
      'watcher',
      JSON.stringify({ script: '/bin/watch.sh', target: 'linus', fallback: 'boris' }),
      { scriptProbe: okProbe },
    )
    expect(w).toMatchObject({ ok: true, command: { kind: 'register', config: { fallback: ['boris'] } } })
  })

  test('array form passes through; "self" allowed (resolved downstream like target)', () => {
    const r = parseRegistration(
      'timer',
      JSON.stringify({ when: '@every 5m', message: 'm', target: 'linus', fallback: ['self', 'darwin'] }),
    )
    expect(r).toMatchObject({ ok: true, command: { config: { fallback: ['self', 'darwin'] } } })
  })

  test('invalid element → teaching error naming fallback', () => {
    const r = parseRegistration(
      'timer',
      JSON.stringify({ when: '@every 5m', message: 'm', target: 'linus', fallback: ['ok-name', 'BAD NAME'] }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('invalid fallback')
  })

  test('absent / empty-array fallback → omitted from the config', () => {
    const r1 = parseRegistration('timer', JSON.stringify({ when: '@every 5m', message: 'm', target: 'linus' }))
    const r2 = parseRegistration('timer', JSON.stringify({ when: '@every 5m', message: 'm', target: 'linus', fallback: [] }))
    for (const r of [r1, r2]) {
      expect(r.ok).toBe(true)
      if (r.ok && r.command.kind === 'register') expect(r.command.config.fallback).toBeUndefined()
    }
  })

  test('describeFormat documents fallback for both roles', () => {
    expect(describeFormat('timer')).toContain('"fallback"?')
    expect(describeFormat('watcher')).toContain('"fallback"?')
  })
})
