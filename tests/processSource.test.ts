import { describe, expect, test } from 'bun:test'
import {
  FakeProcessSource,
  LineBuffer,
  nodeProcessSource,
  type ProcessHandle,
} from '../src/processSource.ts'

// Drive a real /bin/sh -c process and collect its forwarded lines + exit info.
// Resolves once the process exits (after the trailing-partial flush).
function runScript(script: string): Promise<{ lines: string[]; code: number | null; signal: string | null }> {
  const source = nodeProcessSource()
  const handle: ProcessHandle = source.spawn('/bin/sh', ['-c', script])
  const lines: string[] = []
  return new Promise(resolve => {
    handle.onLine(line => lines.push(line))
    handle.onExit(info => resolve({ lines, code: info.code, signal: info.signal }))
  })
}

describe('LineBuffer (unit — splitting semantics)', () => {
  test('LF: multiple lines in one chunk', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('a\nb\nc\n')
    expect(out).toEqual(['a', 'b', 'c'])
  })

  test('CRLF normalizes to LF (\\r stripped)', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('a\r\nb\r\n')
    expect(out).toEqual(['a', 'b'])
  })

  test('partial line across chunks joins', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('foo')
    b.push('bar\n')
    expect(out).toEqual(['foobar'])
  })

  test('byte-split CRLF (\\r and \\n in different chunks)', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('a\r')
    b.push('\nb\n')
    expect(out).toEqual(['a', 'b'])
  })

  test('trailing partial (no newline) flushes on flush()', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('done\nlast')
    expect(out).toEqual(['done'])
    b.flush()
    expect(out).toEqual(['done', 'last'])
  })

  test('flush of an empty buffer emits nothing (clean ...\\n stream)', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('only\n')
    b.flush()
    expect(out).toEqual(['only'])
  })

  test('flush strips a dangling bare \\r', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('tail\r')
    b.flush()
    expect(out).toEqual(['tail'])
  })

  test('blank lines are emitted verbatim (skip is the forward layer’s job)', () => {
    const out: string[] = []
    const b = new LineBuffer(l => out.push(l))
    b.push('a\n\nb\n')
    expect(out).toEqual(['a', '', 'b'])
  })
})

describe('nodeProcessSource (real /bin/sh -c spawn)', () => {
  test("printf 'a\\nb\\n' -> [a, b]", async () => {
    const r = await runScript("printf 'a\\nb\\n'")
    expect(r.lines).toEqual(['a', 'b'])
    expect(r.code).toBe(0)
    expect(r.signal).toBeNull()
  })

  test("CRLF 'a\\r\\nb\\r\\n' -> [a, b]", async () => {
    const r = await runScript("printf 'a\\r\\nb\\r\\n'")
    expect(r.lines).toEqual(['a', 'b'])
  })

  test('multiple lines in one write -> all delivered', async () => {
    const r = await runScript("printf 'one\\ntwo\\nthree\\n'")
    expect(r.lines).toEqual(['one', 'two', 'three'])
  })

  test('trailing partial with no newline flushes on exit', async () => {
    // No final newline — the partial "tail" must be flushed exactly once on exit.
    const r = await runScript("printf 'head\\ntail'")
    expect(r.lines).toEqual(['head', 'tail'])
  })

  test('exit code is surfaced', async () => {
    const r = await runScript('exit 3')
    expect(r.code).toBe(3)
    expect(r.signal).toBeNull()
    expect(r.lines).toEqual([])
  })

  test('kill by signal -> signal surfaced', async () => {
    const source = nodeProcessSource()
    const handle = source.spawn('/bin/sh', ['-c', 'sleep 30'])
    const info = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      handle.onExit(resolve)
      // Give the process a tick to actually start before killing.
      setTimeout(() => handle.kill('SIGKILL'), 50)
    })
    expect(info.signal).toBe('SIGKILL')
    expect(info.code).toBeNull()
  })

  test('spawn error (ENOENT) surfaces as an exit (uniform failure path)', async () => {
    const source = nodeProcessSource()
    const handle = source.spawn('/nonexistent/definitely-not-here', [])
    const info = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
      handle.onExit(resolve)
    })
    // finalize(null, null) — the supervisor treats this like any other failure.
    expect(info.code).toBeNull()
    expect(info.signal).toBeNull()
  })
})

describe('FakeProcessSource', () => {
  test('records spawns and exposes current handle', () => {
    const src = new FakeProcessSource()
    expect(src.current).toBeUndefined()
    const h = src.spawn('/bin/sh', ['-c', 'echo hi'])
    expect(src.spawned.length).toBe(1)
    expect(src.current).toBe(h as any)
    expect((h as any).cmd).toBe('/bin/sh')
  })

  test('emitStdout goes through the same LineBuffer (CRLF + partials)', () => {
    const src = new FakeProcessSource()
    const h = src.spawn('/bin/sh', ['-c', 'x'])
    const lines: string[] = []
    h.onLine(l => lines.push(l))
    src.current!.emitStdout('a\r\nb')
    src.current!.emitStdout('c\n')
    expect(lines).toEqual(['a', 'bc'])
  })

  test('emitExit flushes the trailing partial then fires onExit (idempotent)', () => {
    const src = new FakeProcessSource()
    const h = src.spawn('/bin/sh', ['-c', 'x'])
    const lines: string[] = []
    let exits = 0
    h.onLine(l => lines.push(l))
    h.onExit(() => exits++)
    src.current!.emitStdout('partial')
    src.current!.emitExit(0)
    src.current!.emitExit(0) // idempotent — no second exit, no re-flush
    expect(lines).toEqual(['partial'])
    expect(exits).toBe(1)
  })

  test('kill is recorded, not executed', () => {
    const src = new FakeProcessSource()
    const h = src.spawn('/bin/sh', ['-c', 'x'])
    h.kill('SIGTERM')
    h.kill('SIGKILL')
    expect(src.current!.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })
})
