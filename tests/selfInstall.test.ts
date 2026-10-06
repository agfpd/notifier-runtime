import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BIN_NAME, resolveBinDir, selfInstall } from '../src/selfInstall.ts'
import { runtimeManifestPath } from '../src/manifest.ts'
import { type InstallCommandResult, type InstallCommandRunner } from '../src/installSignature.ts'

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

        // FU6: docs staged to <root>/docs/notifier-runtime/ during install (the
        // sandbox runs from the repo source, so docs/ exists → copied).
        expect(r.docs.copied).toBe(true)
        expect(r.docs.dest).toBe(join(root, 'docs', 'notifier-runtime'))
        expect(statSync(join(r.docs.dest, 'README.md')).isFile()).toBe(true)
        expect(existsSync(join(r.docs.dest, 'ru'))).toBe(true)

        // the compiled bin actually runs (self-contained snapshot)
        const help = spawnSync(r.binPath, ['--help'], { encoding: 'utf8' })
        expect(help.status).toBe(0)
        expect(help.stdout).toContain('self-install')
        expect(help.stdout).toContain('run')

        if (process.platform === 'darwin') {
          expect(['valid', 'repaired']).toContain(r.signature)
          expect(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', r.binPath]).status).toBe(0)
        }

        // Exercise the ACTUAL compiled CLI's copy-self fallback (no source tree).
        const copyEnv = { ...env, IAPEER_ROOT: join(dir, 'copy-root'), IAPEER_BIN_DIR: join(dir, 'copy-bin') }
        const copied = spawnSync(r.binPath, ['self-install'], { env: copyEnv, encoding: 'utf8' })
        expect(copied.status).toBe(0)
        expect(copied.stdout).toContain('(copied-self)')
        const copyPath = join(copyEnv.IAPEER_BIN_DIR, BIN_NAME)
        // A valid signature survives the copy untouched, including its identity.
        expect(readFileSync(copyPath).equals(readFileSync(r.binPath))).toBe(true)
        if (process.platform === 'darwin') {
          expect(copied.stdout).toContain('signature: valid')
          expect(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', copyPath]).status).toBe(0)
        }
        expect(spawnSync(copyPath, ['--help']).status).toBe(0)
        expect(JSON.parse(readFileSync(runtimeManifestPath(copyEnv), 'utf8')).selfConfig.command).toBe(copyPath)
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

describe('selfInstall signature publication gate (mock runner, real sandbox files)', () => {
  function sandbox(previous = true) {
    const dir = mkdtempSync(join(tmpdir(), 'notif-signature-'))
    const binDir = join(dir, 'bin')
    const env = { ...process.env, IAPEER_ROOT: join(dir, 'root'), IAPEER_BIN_DIR: binDir }
    const binPath = join(binDir, BIN_NAME)
    const manifestPath = runtimeManifestPath(env)
    const sourceBin = join(dir, 'running-bin')
    mkdirSync(binDir)
    mkdirSync(join(env.IAPEER_ROOT, 'runtimes', 'notifier'), { recursive: true })
    writeFileSync(sourceBin, 'new executable', { mode: 0o600 })
    if (previous) {
      writeFileSync(binPath, 'old executable', { mode: 0o755 })
      writeFileSync(manifestPath, 'old manifest\n')
    }
    return { dir, env, binDir, binPath, manifestPath, sourceBin }
  }

  const ok: InstallCommandResult = { status: 0 }
  const invalid: InstallCommandResult = { status: 1, stderr: 'invalid signature' }
  for (const mode of ['compiled', 'copied-self'] as const) {
    const options = (s: ReturnType<typeof sandbox>) => ({
      env: s.env, platform: 'darwin' as const,
      sourceEntry: mode === 'compiled' ? SOURCE_ENTRY : join(s.dir, 'missing.ts'),
      execPath: mode === 'compiled' ? '/mock/bun' : s.sourceBin,
    })

    function mock(s: ReturnType<typeof sandbox>, results: InstallCommandResult[], previous = true) {
      const events: string[] = []
      let signCall = 0
      const run: InstallCommandRunner = (command, args, opts) => {
        expect(opts.env).toBe(s.env)
        if (command === '/mock/bun') {
          expect(args.slice(0, 3)).toEqual(['build', '--compile', '--outfile'])
          writeFileSync(args[3], 'new executable', { mode: 0o600 })
          events.push('compile')
          return ok
        }
        expect(command).toBe('/usr/bin/codesign')
        const staged = args.at(-1)!
        expect(staged).not.toBe(s.binPath)
        expect(staged.startsWith(`${s.binPath}.tmp.`)).toBe(true)
        expect(readFileSync(staged, 'utf8')).toBe('new executable')
        expect(statSync(staged).mode & 0o777).toBe(0o755) // chmod BEFORE verify
        if (previous) {
          // Neither publication may precede ANY of verify/sign/reverify.
          expect(readFileSync(s.binPath, 'utf8')).toBe('old executable')
          expect(readFileSync(s.manifestPath, 'utf8')).toBe('old manifest\n')
        } else {
          expect(existsSync(s.binPath)).toBe(false)
          expect(existsSync(s.manifestPath)).toBe(false)
        }
        events.push(args[0] === '--verify' ? 'verify' : 'sign')
        const result = results[signCall++]
        if (!result) throw new Error('unexpected signature command')
        return result
      }
      return { run, events }
    }

    for (const [signature, results, expectedEvents] of [
      ['valid', [ok], ['verify']],
      ['repaired', [invalid, ok, ok], ['verify', 'sign', 'verify']],
    ] as const) {
      test(`${mode}: ${signature} gate runs before bin rename AND manifest write`, () => {
        const s = sandbox()
        try {
          const { run, events } = mock(s, [...results])
          const r = selfInstall({ ...options(s), run })
          expect(r.binMode).toBe(mode)
          expect(r.signature).toBe(signature)
          expect(events).toEqual(mode === 'compiled' ? ['compile', ...expectedEvents] : [...expectedEvents])
          expect(readFileSync(s.binPath, 'utf8')).toBe('new executable')
          expect(JSON.parse(readFileSync(s.manifestPath, 'utf8')).selfConfig.command).toBe(s.binPath)
          expect(readdirSync(s.binDir)).toEqual([BIN_NAME])
        } finally { rmSync(s.dir, { recursive: true, force: true }) }
      })
    }

    for (const [name, results] of [
      ['failed sign', [invalid, invalid]],
      ['failed reverify', [invalid, ok, invalid]],
      ['verify launch error', [{ status: null, error: new Error('ENOENT') }]],
      ['sign timeout', [invalid, { status: null, error: new Error('ETIMEDOUT'), signal: 'SIGKILL' }]],
      ['reverify killed', [invalid, ok, { status: null, signal: 'SIGKILL' }]],
      ['verify runner throws', []],
    ] as [string, InstallCommandResult[]][]) {
      test(`${mode}: ${name} preserves previous bin+manifest, removes tmp (not .dead)`, () => {
        const s = sandbox()
        try {
          const { run } = mock(s, results)
          expect(() => selfInstall({ ...options(s), run })).toThrow('codesign')
          expect(readFileSync(s.binPath, 'utf8')).toBe('old executable')
          expect(statSync(s.binPath).mode & 0o777).toBe(0o755)
          expect(readFileSync(s.manifestPath, 'utf8')).toBe('old manifest\n')
          expect(readdirSync(s.binDir)).toEqual([BIN_NAME])
        } finally { rmSync(s.dir, { recursive: true, force: true }) }
      })
    }

    test(`${mode}: fresh install signature failure publishes nothing`, () => {
      const s = sandbox(false)
      try {
        const { run } = mock(s, [invalid, invalid], false)
        expect(() => selfInstall({ ...options(s), run })).toThrow('codesign ad-hoc sign')
        expect(existsSync(s.binPath)).toBe(false)
        expect(existsSync(s.manifestPath)).toBe(false)
        expect(readdirSync(s.binDir)).toEqual([])
      } finally { rmSync(s.dir, { recursive: true, force: true }) }
    })

    test(`${mode}: non-macOS publishes without invoking codesign`, () => {
      const s = sandbox()
      try {
        const { run, events } = mock(s, [])
        const r = selfInstall({ ...options(s), platform: 'linux', run })
        expect(r.signature).toBe('skipped')
        expect(events).toEqual(mode === 'compiled' ? ['compile'] : [])
      } finally { rmSync(s.dir, { recursive: true, force: true }) }
    })
  }

  test('partial compile failure cleans tmp and preserves installed pair', () => {
    const s = sandbox()
    try {
      expect(() => selfInstall({ env: s.env, sourceEntry: SOURCE_ENTRY, execPath: '/mock/bun',
        run: (_command, args) => {
          writeFileSync(args[3], 'partial output')
          return { status: 1, stderr: 'compile failed' }
        },
      })).toThrow('bun build --compile failed: compile failed')
      expect(readFileSync(s.binPath, 'utf8')).toBe('old executable')
      expect(readFileSync(s.manifestPath, 'utf8')).toBe('old manifest\n')
      expect(readdirSync(s.binDir)).toEqual([BIN_NAME])
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform !== 'darwin')('real macOS negative: post-sign corruption fails reverify, old pair intact', () => {
    const s = sandbox()
    try {
      // Fault injection only at the file layer: ALL codesign invocations are
      // real. Even a successful signer must not bypass the second strict gate.
      expect(() => selfInstall({ env: s.env, sourceEntry: join(s.dir, 'missing.ts'), execPath: s.sourceBin,
        run: (command, args, opts) => {
          const r = spawnSync(command, args, opts)
          if (args[0] === '--force' && r.status === 0) writeFileSync(args.at(-1)!, 'post-sign corruption')
          return r
        },
      })).toThrow('codesign verify after repair failed')
      expect(readFileSync(s.binPath, 'utf8')).toBe('old executable')
      expect(readFileSync(s.manifestPath, 'utf8')).toBe('old manifest\n')
      expect(readdirSync(s.binDir)).toEqual([BIN_NAME])
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform !== 'darwin')('real minimal fresh compile: refuse unrepairable Bun output, or publish only verified executable', () => {
    const s = sandbox()
    try {
      const minimal = join(s.dir, 'minimal.ts')
      writeFileSync(minimal, 'console.log(123)\n')
      let installed: ReturnType<typeof selfInstall> | undefined
      let failure: unknown
      try { installed = selfInstall({ env: s.env, sourceEntry: minimal }) }
      catch (error) { failure = error }
      if (installed) {
        // Future toolchains may produce repairable/valid output. Don't bake a
        // specific Bun defect into CI; the invariant is never publishing invalid.
        expect(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed.binPath]).status).toBe(0)
        const executed = spawnSync(installed.binPath, [], { encoding: 'utf8' })
        expect(executed.status).toBe(0)
        expect(executed.stdout.trim()).toBe('123')
      } else {
        // Observed on this host's Bun 1.3.13: --force --sign - itself fails
        // "main executable failed strict validation". Preserve the prior pair.
        expect(String(failure)).toContain('codesign')
        expect(readFileSync(s.binPath, 'utf8')).toBe('old executable')
        expect(readFileSync(s.manifestPath, 'utf8')).toBe('old manifest\n')
      }
      expect(readdirSync(s.binDir)).toEqual([BIN_NAME])
    } finally { rmSync(s.dir, { recursive: true, force: true }) }
  }, 120_000)
})
