import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveRole, runSelfConfig } from '../src/selfConfig.ts'

describe('resolveRole', () => {
  test('prefers the NAMESPACED IAPEER_PEER_PERSONALITY (the foundation contract env)', () => {
    expect(resolveRole({ IAPEER_PEER_PERSONALITY: 'watcher', PEER_PERSONALITY: 'timer' }, '/cwd')).toEqual({
      role: 'watcher',
      personality: 'watcher',
    })
  })

  test('timer namespaced → timer', () => {
    expect(resolveRole({ IAPEER_PEER_PERSONALITY: 'timer' }, '/cwd')).toEqual({ role: 'timer', personality: 'timer' })
  })

  test('falls back to bare PEER_PERSONALITY when namespaced is absent', () => {
    expect(resolveRole({ PEER_PERSONALITY: 'watcher' }, '/cwd')).toEqual({ role: 'watcher', personality: 'watcher' })
  })

  test('defaults to timer when nothing resolves', () => {
    expect(resolveRole({}, '/nonexistent-cwd')).toEqual({ role: 'timer', personality: 'timer' })
  })

  test('any non-watcher personality maps to the timer role', () => {
    expect(resolveRole({ IAPEER_PEER_PERSONALITY: 'something-else' }, '/cwd').role).toBe('timer')
  })
})

describe('runSelfConfig', () => {
  function sandboxCwd(): string {
    return mkdtempSync(join(tmpdir(), 'notif-selfconfig-'))
  }

  test('writes the role self-doc into <cwd>/.iapeer/peer-profile.json', () => {
    const cwd = sandboxCwd()
    try {
      const r = runSelfConfig({ env: { IAPEER_PEER_PERSONALITY: 'timer' }, cwd })
      expect(r.role).toBe('timer')
      expect(r.profilePath).toBe(join(cwd, '.iapeer', 'peer-profile.json'))
      const profile = JSON.parse(readFileSync(r.profilePath, 'utf8'))
      expect(typeof profile.description).toBe('string')
      expect(profile.description).toContain('notifier-timer')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('PRESERVES the foundation-provisioned intelligence=absent (never clobbers identity)', () => {
    const cwd = sandboxCwd()
    try {
      // The foundation provisions the local profile first (personality + intelligence).
      const profilePath = join(cwd, '.iapeer', 'peer-profile.json')
      mkdirSync(join(cwd, '.iapeer'), { recursive: true })
      writeFileSync(
        profilePath,
        JSON.stringify({ personality: 'watcher', runtime: 'notifier', intelligence: 'absent', extra: 'keep-me' }),
      )

      runSelfConfig({ env: { IAPEER_PEER_PERSONALITY: 'watcher', IAPEER_PEER_INTELLIGENCE: 'absent' }, cwd })

      const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
      expect(profile.intelligence).toBe('absent') // not "scripted"
      expect(profile.personality).toBe('watcher')
      expect(profile.runtime).toBe('notifier')
      expect(profile.extra).toBe('keep-me') // unknown fields preserved
      expect(profile.description).toContain('notifier-watcher')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('idempotent: a second run yields a byte-identical profile', () => {
    const cwd = sandboxCwd()
    try {
      const env = { IAPEER_PEER_PERSONALITY: 'watcher' }
      const r1 = runSelfConfig({ env, cwd })
      const first = readFileSync(r1.profilePath, 'utf8')
      const r2 = runSelfConfig({ env, cwd })
      const second = readFileSync(r2.profilePath, 'utf8')
      expect(second).toBe(first)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
