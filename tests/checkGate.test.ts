import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runCheck } from '../src/checkGate.ts'

const work = mkdtempSync(join(tmpdir(), 'notifier-checkgate-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function makeScript(name: string, body: string): string {
  const path = join(work, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

describe('runCheck — UNIX exit semantics', () => {
  test('no check → unconditional send', () => {
    const r = runCheck(undefined)
    expect(r.send).toBe(true)
    expect(r.reason).toBe('unconditional')
  })

  test('exit 0 → send (like /usr/bin/true)', () => {
    const r = runCheck('/usr/bin/true')
    expect(r.send).toBe(true)
    expect(r.exitCode).toBe(0)
  })

  test('exit != 0 → skip (like /usr/bin/false)', () => {
    const r = runCheck('/usr/bin/false')
    expect(r.send).toBe(false)
    expect(r.exitCode).toBe(1)
    expect(r.error).toBeUndefined() // a clean non-zero exit is NOT a fail-safe error
  })

  test('non-zero exit code is surfaced', () => {
    const script = makeScript('exit3.sh', 'exit 3')
    const r = runCheck(script)
    expect(r.send).toBe(false)
    expect(r.exitCode).toBe(3)
  })

  test('ENOENT → skip + error (fail-safe, never send)', () => {
    const r = runCheck('/nonexistent/definitely/not/a/binary')
    expect(r.send).toBe(false)
    expect(r.error).toBeDefined()
  })

  test('timeout → skip + error (fail-safe)', () => {
    const script = makeScript('sleep.sh', 'sleep 5')
    const r = runCheck(script, { timeoutMs: 100 })
    expect(r.send).toBe(false)
    expect(r.error).toBeDefined()
    expect(r.reason).toBe('check-timeout')
  })
})
