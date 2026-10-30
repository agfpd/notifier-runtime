import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PeerProfileStore } from '../src/peerProfileStore.ts'
import { loadTriggers } from '../src/triggers.ts'
import { readRegistry } from '../src/reachability.ts'

test('registration, trigger projection and reachability all honor isolated IAPEER_ROOT', () => {
  const root = mkdtempSync(join(tmpdir(), 'notifier-root-')), prior = process.env.IAPEER_ROOT
  process.env.IAPEER_ROOT = root
  try {
    const cwd = join(root, 'isolated-peer')
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(join(root, 'peers-profiles.json'), JSON.stringify({ peers: [{ personality: 'isolated-peer', cwd, intelligence: 'artificial' }] }))
    writeFileSync(join(cwd, '.iapeer/peer-profile.json'), JSON.stringify({ notifier: { triggers: [{ role: 'time', id: 'tick', owner: 'isolated-peer', target: 'isolated-peer', when: '@every 1m', message: 'm' }] } }))
    expect(new PeerProfileStore().findCwd('isolated-peer')).toBe(cwd)
    expect(loadTriggers().ok.map(t => t.id)).toEqual(['tick'])
    expect([...readRegistry().keys()]).toEqual(['isolated-peer'])
  } finally {
    if (prior === undefined) delete process.env.IAPEER_ROOT
    else process.env.IAPEER_ROOT = prior
    rmSync(root, { recursive: true, force: true })
  }
})
