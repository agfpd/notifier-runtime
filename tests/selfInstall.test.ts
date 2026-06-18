import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BIN_NAME, resolveBinDir, selfInstall } from '../src/selfInstall.ts'

const SOURCE_ENTRY = join(import.meta.dir, '../src/cli.ts')

describe('resolveBinDir', () => {
  test('IAPEER_BIN_DIR wins (keeps the sandbox proof off the real ~/.local/bin)', () => {
    expect(resolveBinDir({ IAPEER_BIN_DIR: '/sbx/bin', HOME: '/home/x' })).toBe('/sbx/bin')
  })
  test('falls back to $HOME/.local/bin (on the launchd-minimal PATH)', () => {
    expect(resolveBinDir({ HOME: '/home/x' })).toBe('/home/x/.local/bin')
  })
  test('BIN_NAME is notifier-runtime (matches the foundation default launcher)', () => {
    expect(BIN_NAME).toBe('notifier-runtime')
  })
})

describe('selfInstall (real compile)', () => {
  function sandbox(): { env: NodeJS.ProcessEnv; root: string; binDir: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'notif-install-'))
    const root = join(dir, 'iapeer-root')
    const binDir = join(dir, 'bin')
    const env = { ...process.env, HOME: dir, IAPEER_ROOT: root, IAPEER_BIN_DIR: binDir }
    return { env, root, binDir, dir }
  }

  test(
    'places a compiled, executable bin on PATH + writes the manifest under IAPEER_ROOT',
    () => {
      const { env, root, binDir, dir } = sandbox()
      try {
        const r = selfInstall({ env, sourceEntry: SOURCE_ENTRY })

        expect(r.binMode).toBe('compiled')
        expect(r.binPath).toBe(join(binDir, 'notifier-runtime'))
        expect(r.root).toBe(root)
        // bin exists and is executable
        const st = statSync(r.binPath)
        expect(st.isFile()).toBe(true)
        expect(st.mode & 0o111).toBeGreaterThan(0)

        // manifest under the RIGHT root (the env-resolved IAPEER_ROOT)
        expect(r.manifestPath).toBe(join(root, 'runtimes', 'notifier', 'runtime.json'))
        const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf8'))
        expect(manifest.runtime).toBe('notifier')
        // self-config descriptor pins the ABSOLUTE installed bin
        expect(manifest.selfConfig).toEqual({ command: r.binPath, args: ['self-config'] })
        expect(manifest.peers.map((p: { personality: string }) => p.personality)).toEqual(['timer', 'watcher'])
        for (const p of manifest.peers) expect(p.intelligence).toBe('absent')

        // the compiled bin actually runs (self-contained snapshot)
        const help = spawnSync(r.binPath, ['--help'], { encoding: 'utf8' })
        expect(help.status).toBe(0)
        expect(help.stdout).toContain('self-install')
        expect(help.stdout).toContain('run')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )

  test(
    'idempotent: a repeat install yields a byte-identical manifest and a present bin',
    () => {
      const { env, dir } = sandbox()
      try {
        const r1 = selfInstall({ env, sourceEntry: SOURCE_ENTRY })
        const m1 = readFileSync(r1.manifestPath, 'utf8')
        const r2 = selfInstall({ env, sourceEntry: SOURCE_ENTRY })
        const m2 = readFileSync(r2.manifestPath, 'utf8')
        expect(r2.manifestPath).toBe(r1.manifestPath)
        expect(m2).toBe(m1)
        expect(statSync(r2.binPath).isFile()).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
