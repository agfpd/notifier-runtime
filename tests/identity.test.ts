import { describe, expect, test } from 'bun:test'
import { resolvePersonality } from '../src/identity.ts'

describe('resolvePersonality', () => {
  function deps(opts: { env?: NodeJS.ProcessEnv; profile?: string | null }) {
    const profilePath = '/cwd/.iapeer/peer-profile.json'
    return {
      cwd: '/cwd',
      env: opts.env ?? {},
      profilePathFor: () => profilePath,
      fileExists: (p: string) => p === profilePath && opts.profile != null,
      readFile: (p: string) => {
        if (p === profilePath && opts.profile != null) return opts.profile
        throw new Error(`unexpected read ${p}`)
      },
    }
  }

  test('env.PEER_PERSONALITY wins over everything', () => {
    expect(
      resolvePersonality(deps({ env: { PEER_PERSONALITY: 'watcher' }, profile: JSON.stringify({ personality: 'timer' }) })),
    ).toBe('watcher')
  })

  test('falls back to peer-profile personality when env is unset', () => {
    expect(resolvePersonality(deps({ profile: JSON.stringify({ personality: 'watcher' }) }))).toBe('watcher')
  })

  test("defaults to 'timer' when neither env nor profile provides one", () => {
    expect(resolvePersonality(deps({ profile: null }))).toBe('timer')
  })

  test("defaults to 'timer' on a malformed profile (does not throw)", () => {
    expect(resolvePersonality(deps({ profile: '{ not json' }))).toBe('timer')
  })

  test('empty env value is ignored (falls through to profile)', () => {
    expect(
      resolvePersonality(deps({ env: { PEER_PERSONALITY: '' }, profile: JSON.stringify({ personality: 'watcher' }) })),
    ).toBe('watcher')
  })

  test('profile without a personality field → default', () => {
    expect(resolvePersonality(deps({ profile: JSON.stringify({ runtime: 'notifier' }) }))).toBe('timer')
  })
})
