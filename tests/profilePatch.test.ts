import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PeerProfileStore } from '../src/peerProfileStore.ts'
import { runSelfConfig } from '../src/selfConfig.ts'

function sandbox() {
  const cwd = mkdtempSync(join(tmpdir(), 'notifier-profile-patch-'))
  mkdirSync(join(cwd, '.iapeer'))
  return { cwd, path: join(cwd, '.iapeer/peer-profile.json') }
}

test('all production profile writers reject invalid JSON without replacing it', () => {
  const { cwd, path } = sandbox()
  try {
    for (const value of ['{broken', 'null', '[]']) {
      writeFileSync(path, value)
      const store = new PeerProfileStore()
      expect(() => store.upsert(cwd, { id: 'x', role: 'time', owner: 'probe', target: 'probe' })).toThrow()
      expect(() => store.remove(cwd, 'x')).toThrow()
      expect(() => runSelfConfig({ cwd, env: {} })).toThrow()
      expect(readFileSync(path, 'utf8')).toBe(value)
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('unchanged config and absent/wrong-role removal preserve inode and bytes', () => {
  const { cwd, path } = sandbox()
  try {
    const store = new PeerProfileStore()
    const trigger = { id: 'same', role: 'event' as const, owner: 'probe', target: 'probe' }
    store.upsert(cwd, trigger)
    runSelfConfig({ cwd, env: { PEER_PERSONALITY: 'watcher' } })
    const before = readFileSync(path, 'utf8'), inode = statSync(path).ino
    expect(store.upsert(cwd, trigger)).toBe('replaced')
    expect(store.remove(cwd, 'same', 'time', 'probe')).toBe(false)
    expect(store.remove(cwd, 'same', 'event', 'other')).toBe(false)
    expect(store.remove(cwd, 'absent')).toBe(false)
    runSelfConfig({ cwd, env: { PEER_PERSONALITY: 'watcher' } })
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(statSync(path).ino).toBe(inode)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('held core lock rejects notifier write after timeout without touching profile', () => {
  const { cwd, path } = sandbox()
  try {
    writeFileSync(path, '{"foreign":"keep"}\n')
    mkdirSync(join(cwd, '.iapeer/.peer-profile.lock'))
    expect(() => new PeerProfileStore().upsert(cwd, { id: 'x', role: 'time', owner: 'probe', target: 'probe' })).toThrow(/lock timeout/)
    expect(readFileSync(path, 'utf8')).toBe('{"foreign":"keep"}\n')
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})

test('independent timer/watcher/self-config/core writers retain every update', async () => {
  const { cwd, path } = sandbox()
  const children: ReturnType<typeof Bun.spawn>[] = []
  try {
    writeFileSync(path, JSON.stringify({ personality: 'watcher', foreign: { keep: true }, notifier: { unknown: 7 } }))
    const worker = join(cwd, 'worker.ts')
    writeFileSync(worker, `
      import { PeerProfileStore } from ${JSON.stringify(new URL('../src/peerProfileStore.ts', import.meta.url).pathname)};
      import { runSelfConfig } from ${JSON.stringify(new URL('../src/selfConfig.ts', import.meta.url).pathname)};
      import { patchPeerProfile } from ${JSON.stringify(import.meta.resolve('@agfpd/iapeer/peer-profile'))};
      const cwd = process.argv[2], kind = process.argv[3], store = new PeerProfileStore();
      for (let i=0; i<25; i++) {
        if (kind === 'config') runSelfConfig({cwd, env:{}});
        else if (kind === 'core') patchPeerProfile(cwd, raw => { raw.interfaces = {test:i}; });
        else store.upsert(cwd, {id:kind+i, role:kind === 'timer' ? 'time' : 'event', owner:'probe',target:'probe'});
        await Bun.sleep(1);
      }
    `)
    for (const kind of ['timer', 'watcher', 'config', 'core']) {
      children.push(Bun.spawn([process.execPath, worker, cwd, kind], { stdout: 'pipe', stderr: 'pipe' }))
    }
    for (const child of children) {
      const error = await new Response(child.stderr as ReadableStream<Uint8Array>).text()
      expect(await child.exited, error).toBe(0)
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.foreign).toEqual({ keep: true })
    expect(raw.interfaces).toEqual({ test: 24 })
    expect(raw.notifier.unknown).toBe(7)
    expect(raw.notifier.triggers).toHaveLength(50)
    expect(new Set(raw.notifier.triggers.map((t: any) => t.id)).size).toBe(50)
    expect(raw.description).toContain('send_to_peer(watcher,')
  } finally {
    for (const child of children) { child.kill(); await child.exited }
    rmSync(cwd, { recursive: true, force: true })
  }
}, 15000)
