import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, readlinkSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { publishInstallPair } from '../src/installPair.ts'
import { buildManifest, runtimeManifestPath } from '../src/manifest.ts'
import { selfInstall } from '../src/selfInstall.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(previous = true) {
  const root = mkdtempSync(join(tmpdir(), 'notifier-pair-')); roots.push(root)
  const env = { IAPEER_ROOT: join(root, 'iap'), IAPEER_BIN_DIR: join(root, 'bin') }
  mkdirSync(env.IAPEER_BIN_DIR)
  const bin = join(env.IAPEER_BIN_DIR, 'notifier-runtime')
  const staged = join(env.IAPEER_BIN_DIR, 'staged')
  const manifest = runtimeManifestPath(env)
  mkdirSync(dirname(manifest), { recursive: true })
  if (previous) {
    writeFileSync(bin, 'old binary', { mode: 0o751 })
    writeFileSync(manifest, 'old manifest\n')
  }
  writeFileSync(staged, 'new binary', { mode: 0o755 })
  return { root, env, bin, staged, manifest }
}

test('real ENOTDIR during self-install leaves binary inode/bytes and manifest unchanged', () => {
  const f = fixture()
  const inode = statSync(f.bin).ino
  const blocked = join(f.root, 'blocked'); writeFileSync(blocked, 'not a directory')
  expect(() => selfInstall({ env: { ...f.env, IAPEER_ROOT: blocked }, sourceEntry: '/no-source.ts', execPath: f.staged, platform: 'linux' })).toThrow()
  expect(readFileSync(f.bin, 'utf8')).toBe('old binary')
  expect(statSync(f.bin).ino).toBe(inode)
  expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest\n')
  expect(readdirSync(f.env.IAPEER_BIN_DIR).sort()).toEqual(['notifier-runtime', 'staged'])
})

for (const previous of [true, false]) for (const failAt of [1, 2]) {
  test(`rename ${failAt} failure restores ${previous ? 'upgrade' : 'fresh install'} pair`, () => {
    const f = fixture(previous)
    const inode = previous ? statSync(f.bin).ino : undefined
    let calls = 0
    expect(() => publishInstallPair(f.staged, f.bin, buildManifest(f.bin), f.env, (from, to) => {
      if (++calls === failAt) throw new Error('injected rename error')
      renameSync(from, to)
    })).toThrow('injected rename error')
    expect(existsSync(f.bin)).toBe(previous)
    expect(existsSync(f.manifest)).toBe(previous)
    if (previous) {
      expect(statSync(f.bin).ino).toBe(inode!)
      expect(statSync(f.bin).mode & 0o777).toBe(0o751)
      expect(readFileSync(f.bin, 'utf8')).toBe('old binary')
      expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest\n')
    }
    expect(readdirSync(dirname(f.manifest))).toEqual(previous ? ['runtime.json'] : [])
    expect(readdirSync(f.env.IAPEER_BIN_DIR).some(n => /rollback|tmp/.test(n))).toBe(false)
  })
}

test('real EISDIR on manifest publication restores binary inode', () => {
  const f = fixture()
  const inode = statSync(f.bin).ino
  rmSync(f.manifest); mkdirSync(f.manifest); writeFileSync(join(f.manifest, 'keep'), 'keep')
  expect(() => publishInstallPair(f.staged, f.bin, buildManifest(f.bin), f.env)).toThrow()
  expect(statSync(f.bin).ino).toBe(inode)
  expect(readFileSync(join(f.manifest, 'keep'), 'utf8')).toBe('keep')
  expect(readdirSync(dirname(f.manifest))).toEqual(['runtime.json'])
})

test('rollback preserves a dangling relative legacy symlink', () => {
  const f = fixture()
  rmSync(f.bin); symlinkSync('missing-relative-target', f.bin)
  let calls = 0
  expect(() => publishInstallPair(f.staged, f.bin, buildManifest(f.bin), f.env, (from, to) => {
    if (++calls === 2) throw new Error('late failure')
    renameSync(from, to)
  })).toThrow('late failure')
  expect(readlinkSync(f.bin)).toBe('missing-relative-target')
  expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest\n')
})

test('double failure retains old inode and reports recovery path', () => {
  const f = fixture()
  const inode = statSync(f.bin).ino
  let calls = 0
  let error: unknown
  try {
    publishInstallPair(f.staged, f.bin, buildManifest(f.bin), f.env, (from, to) => {
      if (++calls >= 2) throw new Error('storage failure')
      renameSync(from, to)
    })
  } catch (e) { error = e }
  expect(error).toBeInstanceOf(AggregateError)
  const backups = readdirSync(f.env.IAPEER_BIN_DIR).filter(n => n.endsWith('.rollback'))
  expect(backups).toHaveLength(1)
  const backup = join(f.env.IAPEER_BIN_DIR, backups[0]!)
  expect(String(error)).toContain(backup)
  expect(statSync(backup).ino).toBe(inode)
  expect(readFileSync(f.manifest, 'utf8')).toBe('old manifest\n')
})

test('success publishes new pair and removes temporary recovery files', () => {
  const f = fixture()
  expect(publishInstallPair(f.staged, f.bin, buildManifest(f.bin), f.env)).toBe(f.manifest)
  expect(readFileSync(f.bin, 'utf8')).toBe('new binary')
  expect(JSON.parse(readFileSync(f.manifest, 'utf8')).selfConfig.command).toBe(f.bin)
  expect(readdirSync(f.env.IAPEER_BIN_DIR)).toEqual(['notifier-runtime'])
})
