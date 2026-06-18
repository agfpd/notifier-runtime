import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildManifest,
  DECLARED_PEERS,
  readManifest,
  resolveIapeerRoot,
  runtimeManifestPath,
  writeManifestAtomic,
} from '../src/manifest.ts'

describe('resolveIapeerRoot', () => {
  test('IAPEER_ROOT wins (env override beats $HOME/.iapeer)', () => {
    expect(resolveIapeerRoot({ IAPEER_ROOT: '/sbx/root', HOME: '/home/x' })).toBe('/sbx/root')
  })
  test('IAPEER_ROOT trimmed', () => {
    expect(resolveIapeerRoot({ IAPEER_ROOT: '  /sbx/root  ', HOME: '/home/x' })).toBe('/sbx/root')
  })
  test('falls back to $HOME/.iapeer when IAPEER_ROOT unset', () => {
    expect(resolveIapeerRoot({ HOME: '/home/x' })).toBe('/home/x/.iapeer')
  })
})

describe('runtimeManifestPath', () => {
  test('is <root>/runtimes/notifier/runtime.json (where the foundation reads)', () => {
    expect(runtimeManifestPath({ IAPEER_ROOT: '/sbx/root' })).toBe('/sbx/root/runtimes/notifier/runtime.json')
  })
})

describe('buildManifest', () => {
  const m = buildManifest('/abs/bin/notifier-runtime')

  test('runtime is "notifier"', () => {
    expect(m.runtime).toBe('notifier')
  })

  test('version stamp equals package.json (the foundation update-runtime version-gate handle)', () => {
    // No stamp → the gate is skipped and EVERY update pays a full re-install
    // (observed live on the 0.1.3 rollout). The stamp closes already-latest.
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version: string }
    expect(m.version).toBe(pkg.version)
    expect(m.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('selfConfig is the OBJECT form with the absolute bin + self-config arg', () => {
    // String descriptor cannot carry the `self-config` arg (foundation reads a string
    // as command-only) → we MUST use {command, args}. Absolute path = PATH-independent.
    expect(m.selfConfig).toEqual({ command: '/abs/bin/notifier-runtime', args: ['self-config'] })
  })

  test('declares the FIXED set timer + watcher (declared-set, mode a)', () => {
    expect(m.peers?.map(p => p.personality)).toEqual(['timer', 'watcher'])
    expect(DECLARED_PEERS).toEqual(['timer', 'watcher'])
  })

  test('BOTH peers are intelligence=absent (frozen contract; never "scripted")', () => {
    for (const p of m.peers ?? []) expect(p.intelligence).toBe('absent')
  })

  test('each peer carries a dense single-line self-doc description within the registry cap', () => {
    for (const p of m.peers ?? []) {
      const d = p.description ?? ''
      expect(typeof p.description).toBe('string')
      expect(d.length).toBeGreaterThan(0)
      // ONE line — the IAP known-peers list is one line per peer.
      expect(d.split('\n').length).toBe(1)
      // The foundation caps a registry description at 450 chars (iapeer ea76e6d); an
      // over-budget edit must fail HERE, not get silently truncated on deploy.
      expect(d.length).toBeLessThanOrEqual(450)
      // Self-documenting: the registration verb is in the injected text itself, so a
      // peer-client can register straight from the blurb (no teaching round-trip).
      expect(d).toContain(`send_to_peer(${p.personality},`)
    }
  })
})

describe('writeManifestAtomic + readManifest roundtrip', () => {
  function sandbox(): { env: NodeJS.ProcessEnv; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'notif-manifest-'))
    return { env: { IAPEER_ROOT: dir }, dir }
  }

  test('writes under the right root and reads back identical', () => {
    const { env, dir } = sandbox()
    try {
      const m = buildManifest('/abs/bin/notifier-runtime')
      const path = writeManifestAtomic(m, env)
      expect(path).toBe(join(dir, 'runtimes', 'notifier', 'runtime.json'))
      expect(readManifest(env)).toEqual(m)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('idempotent: a repeat write is byte-identical', () => {
    const { env, dir } = sandbox()
    try {
      const m = buildManifest('/abs/bin/notifier-runtime')
      const p1 = writeManifestAtomic(m, env)
      const first = readFileSync(p1, 'utf8')
      const p2 = writeManifestAtomic(m, env)
      const second = readFileSync(p2, 'utf8')
      expect(p2).toBe(p1)
      expect(second).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readManifest returns null when absent', () => {
    const { env, dir } = sandbox()
    try {
      expect(readManifest(env)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
