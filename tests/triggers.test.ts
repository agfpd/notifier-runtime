import { describe, expect, test } from 'bun:test'
import {
  loadTriggers,
  parseTriggersFromProfile,
  type EventTrigger,
  type TimeTrigger,
} from '../src/triggers.ts'

describe('parseTriggersFromProfile — event role', () => {
  test('event trigger is PARSED with script/target/topic/heartbeatSec', () => {
    const profile = {
      notifier: {
        triggers: [
          {
            role: 'event',
            script: 'tail -F /var/log/app.log | grep ERROR',
            target: 'boris',
            topic: 'prod-errors',
            heartbeatSec: 60,
          },
        ],
      },
    }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(errors).toEqual([])
    expect(ok.length).toBe(1)
    const t = ok[0] as EventTrigger
    // `id` is auto content-hashed when the profile entry omits it.
    expect(typeof t.id).toBe('string')
    expect(t.id.length).toBeGreaterThan(0)
    const { id, ...rest } = t
    expect(rest).toEqual({
      role: 'event',
      script: 'tail -F /var/log/app.log | grep ERROR',
      target: 'boris',
      topic: 'prod-errors',
      heartbeatSec: 60,
      owner: 'arthur',
    })
  })

  test('event without optional topic/heartbeatSec parses (message NOT required)', () => {
    const profile = { notifier: { triggers: [{ role: 'event', script: 'watch.sh', target: 'boris' }] } }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(errors).toEqual([])
    const { id, ...rest } = ok[0] as EventTrigger
    expect(typeof id).toBe('string')
    expect(rest).toEqual({ role: 'event', script: 'watch.sh', target: 'boris', owner: 'arthur' })
  })

  test('event missing script → error, not in ok', () => {
    const profile = { notifier: { triggers: [{ role: 'event', target: 'boris' }] } }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(ok.length).toBe(0)
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('missing non-empty "script"')
  })

  test('event invalid target → error', () => {
    const profile = { notifier: { triggers: [{ role: 'event', script: 'x.sh', target: 'BAD NAME' }] } }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(ok.length).toBe(0)
    expect(errors[0]).toContain('invalid target')
  })

  test('event non-positive heartbeatSec → error', () => {
    const profile = {
      notifier: { triggers: [{ role: 'event', script: 'x.sh', target: 'boris', heartbeatSec: 0 }] },
    }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(ok.length).toBe(0)
    expect(errors[0]).toContain('heartbeatSec')
  })

  test('event non-numeric heartbeatSec → error', () => {
    const profile = {
      notifier: { triggers: [{ role: 'event', script: 'x.sh', target: 'boris', heartbeatSec: '30' }] },
    }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(ok.length).toBe(0)
    expect(errors[0]).toContain('heartbeatSec')
  })
})

describe('parseTriggersFromProfile — mixed roles', () => {
  test('a profile with BOTH time and event triggers returns both', () => {
    const profile = {
      notifier: {
        triggers: [
          { role: 'time', when: '0 9 * * *', message: 'morning', target: 'arthur' },
          { role: 'event', script: 'monitor.sh', target: 'boris', topic: 'alerts' },
        ],
      },
    }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(errors).toEqual([])
    expect(ok.length).toBe(2)
    expect(ok.map(t => t.role).sort()).toEqual(['event', 'time'])
    const time = ok.find(t => t.role === 'time') as TimeTrigger
    const event = ok.find(t => t.role === 'event') as EventTrigger
    expect(time.when).toBe('0 9 * * *')
    expect(event.script).toBe('monitor.sh')
  })

  test('unknown role → error (a typo must not vanish silently)', () => {
    const profile = { notifier: { triggers: [{ role: 'evnt', script: 'x.sh', target: 'boris' }] } }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(ok.length).toBe(0)
    expect(errors[0]).toContain('unknown role')
  })

  test('one bad trigger does not drop the good ones', () => {
    const profile = {
      notifier: {
        triggers: [
          { role: 'event', script: 'good.sh', target: 'boris' },
          { role: 'event', target: 'boris' }, // missing script
          { role: 'time', when: '0 9 * * *', message: 'ok', target: 'arthur' },
        ],
      },
    }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(ok.length).toBe(2)
    expect(errors.length).toBe(1)
  })
})

describe('loadTriggers — projects both roles across peers', () => {
  test('reads peers index → per-cwd profiles → returns time + event triggers', () => {
    const files: Record<string, string> = {
      '/index.json': JSON.stringify({
        peers: [
          { personality: 'arthur', cwd: '/peers/arthur' },
          { personality: 'doc', cwd: '/peers/doc' },
        ],
      }),
      '/peers/arthur/.iapeer/peer-profile.json': JSON.stringify({
        notifier: { triggers: [{ role: 'event', script: 'a.sh', target: 'boris' }] },
      }),
      '/peers/doc/.iapeer/peer-profile.json': JSON.stringify({
        notifier: { triggers: [{ role: 'time', when: '@every 5m', message: 'beat', target: 'arthur' }] },
      }),
    }
    const { ok, errors } = loadTriggers({
      peersIndexPath: '/index.json',
      profilePathFor: cwd => `${cwd}/.iapeer/peer-profile.json`,
      readFile: p => {
        if (!(p in files)) throw new Error(`unexpected read ${p}`)
        return files[p]!
      },
      fileExists: p => p in files,
    })
    expect(errors).toEqual([])
    expect(ok.length).toBe(2)
    const roles = ok.map(t => t.role).sort()
    expect(roles).toEqual(['event', 'time'])
    expect((ok.find(t => t.role === 'event') as EventTrigger).owner).toBe('arthur')
    expect((ok.find(t => t.role === 'time') as TimeTrigger).owner).toBe('doc')
  })
})

describe('fallback (escalation chain) — profile projection', () => {
  test('string form normalizes to array; "self" resolves to the OWNER', () => {
    const profile = {
      notifier: {
        triggers: [
          { role: 'time', when: '@every 5m', message: 'm', target: 'linus', fallback: 'self' },
          { role: 'event', script: 'watch.sh', target: 'linus', fallback: ['boris', 'self'] },
        ],
      },
    }
    const { ok, errors } = parseTriggersFromProfile(profile, 'prl-assistant')
    expect(errors).toEqual([])
    expect((ok[0] as TimeTrigger).fallback).toEqual(['prl-assistant'])
    expect((ok[1] as EventTrigger).fallback).toEqual(['boris', 'prl-assistant'])
  })

  test('invalid fallback element → error collected, trigger skipped, others survive', () => {
    const profile = {
      notifier: {
        triggers: [
          { role: 'time', when: '@every 5m', message: 'm', target: 'linus', fallback: [42] },
          { role: 'time', when: '@every 5m', message: 'm', target: 'linus' },
        ],
      },
    }
    const { ok, errors } = parseTriggersFromProfile(profile, 'arthur')
    expect(ok.length).toBe(1)
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('invalid fallback')
  })

  test('auto content-hash id: absence of fallback keeps the legacy id; presence changes it', () => {
    const base = { role: 'time', when: '@every 5m', message: 'm', target: 'linus' }
    const legacy = parseTriggersFromProfile({ notifier: { triggers: [base] } }, 'arthur').ok[0]!
    const again = parseTriggersFromProfile({ notifier: { triggers: [base] } }, 'arthur').ok[0]!
    const withFb = parseTriggersFromProfile(
      { notifier: { triggers: [{ ...base, fallback: 'boris' }] } },
      'arthur',
    ).ok[0]!
    // Deterministic across parses (reload diff key stability)…
    expect(legacy.id).toBe(again.id)
    // …and a fallback-carrying config is a DIFFERENT config (different id).
    expect(withFb.id).not.toBe(legacy.id)
  })
})
