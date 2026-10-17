import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EchoGuard } from '../src/echoGuard.ts'
import { Escalator, InMemorySpool } from '../src/escalation.ts'
import { nodeProcessSource } from '../src/processSource.ts'
import { Supervisor } from '../src/supervisor.ts'
import type { AsyncTransport, Signal } from '../src/transport.ts'

const line = (to: string, ok: boolean, caller = 'notifier-watcher') =>
  `ts=2026-10-17T13:48:27.491Z ev=delivery path=cli caller=${caller} to=${to} ok=${ok} ms=7 len=227 err="offline"`

describe('EchoGuard (unit)', () => {
  test('echo = own identity + recipient in flight', () => {
    const g = new EchoGuard('notifier-watcher', () => 0)
    g.begin('doc')
    expect(g.echoOf(line('doc', false))).toBe('doc')
    expect(g.echoOf(line('boris', false))).toBeNull() // not a recipient of ours
  })

  test('recipient stays echo-able for the window after send end, then expires', () => {
    let t = 0
    const g = new EchoGuard('notifier-watcher', () => t, 60_000)
    g.begin('boris')
    g.end('boris')
    t = 60_000
    expect(g.echoOf(line('boris', true))).toBe('boris') // ok=true echoes too
    t = 60_001
    expect(g.echoOf(line('boris', true))).toBeNull()
  })

  test('foreign caller is never an echo (other peers’ failures still forward)', () => {
    const g = new EchoGuard('notifier-watcher', () => 0)
    g.begin('doc')
    expect(g.echoOf(line('doc', false, 'claude-index'))).toBeNull()
    expect(g.echoOf(line('doc', false, 'notifier-timer'))).toBeNull()
  })

  test('token boundaries: notifier-watcher2 / claude-doc do not match', () => {
    const g = new EchoGuard('notifier-watcher', () => 0)
    g.begin('doc')
    expect(g.echoOf(line('doc', false, 'notifier-watcher2'))).toBeNull()
    expect(g.echoOf(line('claude-doc', false))).toBeNull()
    expect(g.echoOf(line('doc', false))).toBe('doc')
  })

  test('wrapAsync/wrapSync track in-flight and end even on throw', async () => {
    let t = 0
    const g = new EchoGuard('notifier-watcher', () => t, 10)
    let seen = null as string | null
    const a = g.wrapAsync({
      send: async () => {
        seen = g.echoOf(line('doc', false))
        throw new Error('boom')
      },
    })
    await expect(a.send({ target: 'doc', message: 'x' })).rejects.toThrow('boom')
    expect(seen).toBe('doc')
    t = 11
    expect(g.echoOf(line('doc', false))).toBeNull()
    const s = g.wrapSync({ send: () => ({ ok: true }) })
    expect(s.send({ target: 'arthur', message: 'x' }).ok).toBe(true)
    expect(g.echoOf(line('arthur', true))).toBe('arthur')
  })
})

// Closed-loop stand (acceptance): a real `tail -F | grep ok=false` watcher over
// a delivery log; the "core" (fake transport) appends one delivery line per
// send, every target offline. Chain: doc → boris (fallback) → owner → backstop.
// Without the guard the loop amplifies until the flood breaker trips; with it,
// exactly one signal is lost and the log stays finite.
async function runStand(guarded: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-stand-'))
  const log = join(dir, 'delivery.log')
  writeFileSync(log, '')
  const guard = new EchoGuard('notifier-watcher')
  const core: AsyncTransport = {
    async send(sig: Signal) {
      appendFileSync(log, `${line(sig.target, false)}\n`)
      return { ok: false, error: 'offline' }
    },
  }
  const transport = guarded ? guard.wrapAsync(core) : core
  const logs: Array<{ evt: string; fields?: Record<string, unknown> }> = []
  const logFn = (evt: string, fields?: Record<string, unknown>) => logs.push({ evt, fields })
  const setTimer = (ms: number, cb: () => void) => {
    const t = setTimeout(cb, ms)
    return () => clearTimeout(t)
  }
  const escalator = new Escalator(
    { transport, spool: new InMemorySpool(), log: logFn, setTimer, now: () => new Date() },
    { attemptsPerLink: 1, retryDelayMs: 0, backstop: 'arthur' },
  )
  const supervisor = new Supervisor(
    [
      {
        role: 'event',
        id: 'dl',
        owner: 'doc',
        target: 'doc',
        fallback: ['boris'],
        script: `tail -n 0 -F ${log} | grep --line-buffered ok=false`,
      } as never,
    ],
    {
      now: () => Date.now(),
      deliver: job => void escalator.deliver(job),
      cancelForwards: id => escalator.cancelPending(e => e.kind === 'forward' && e.meta?.id === id),
      processSource: nodeProcessSource(),
      ...(guarded ? { echoOf: (l: string) => guard.echoOf(l) } : {}),
      log: logFn,
      setTimer,
    },
    { floodThreshold: 30, floodWindowMs: 10_000 },
  )
  supervisor.start()
  await new Promise(r => setTimeout(r, 400)) // tail is up
  // The seed: one foreign failed delivery.
  appendFileSync(log, `${line('doc', false, 'claude-index')}\n`)
  await new Promise(r => setTimeout(r, 2500))
  supervisor.stop()
  const lines = (await Bun.file(log).text()).split('\n').filter(Boolean).length
  rmSync(dir, { recursive: true, force: true })
  return {
    lines,
    flood: logs.filter(l => l.evt === 'watcher-flood').length,
    lost: logs.filter(l => l.evt === 'delivery-lost').length,
    echoes: logs.filter(l => l.evt === 'echo-suppressed').length,
  }
}

describe('echo loop stand (delivery.log watcher, all targets offline)', () => {
  test('WITHOUT guard: the loop amplifies into a flood-stop (repro)', async () => {
    const r = await runStand(false)
    expect(r.flood).toBe(1)
    expect(r.lines).toBeGreaterThan(30)
  }, 10_000)

  test('WITH guard: one lost signal, no flood, finite log', async () => {
    const r = await runStand(true)
    expect(r.flood).toBe(0)
    expect(r.lost).toBe(1)
    // seed + one line per chain link (doc, boris, arthur) — nothing more.
    expect(r.lines).toBe(4)
    expect(r.echoes).toBe(3)
  }, 10_000)
})
