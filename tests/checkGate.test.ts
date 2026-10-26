import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runCheck, validateCheck } from '../src/checkGate.ts'
import { parseRegistration } from '../src/format.ts'

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

describe('check registration preflight — no execution or shell parsing', () => {
  const body = (check: unknown) => JSON.stringify({ when: '@every 1h', message: 'm', target: 'self', check })

  test('rejects missing paths, shell expressions, arguments, quoted paths, empty and NUL', () => {
    for (const check of ['/notifier-no-such-gate', '/bin/test "$(/bin/date +%Y-%m-%d)" = 2026-10-26',
      '/usr/bin/true arg', 'true && false', '"/usr/bin/true"', '   ', '', 'true\0arg', 42, null]) {
      const r = parseRegistration('timer', body(check))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain('check')
    }
  })

  test('rejects directories, non-executable files and dangling symlinks', () => {
    const notExec = join(work, 'not-executable')
    writeFileSync(notExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    chmodSync(notExec, 0o644)
    const dangling = join(work, 'dangling')
    symlinkSync(join(work, 'missing'), dangling)
    for (const check of [work, notExec, dangling]) {
      expect(validateCheck(check)).toContain('not executable by timer')
      expect(parseRegistration('timer', body(check)).ok).toBe(false)
    }
  })

  test('literal path with spaces/metacharacters and symlink pass WITHOUT running the gate', () => {
    const marker = join(work, 'ran')
    const check = makeScript('gate with spaces;$.sh', `echo ran > '${marker}'\nexit 0`)
    const link = join(work, 'gate link')
    symlinkSync(check, link)
    for (const path of [check, link]) {
      expect(validateCheck(path)).toBeUndefined()
      const r = parseRegistration('timer', body(path))
      expect(r.ok).toBe(true)
      if (r.ok && r.command.kind === 'register' && r.command.role === 'timer') {
        expect(r.command.config.check).toBe(path) // no trimming, tokenization or quoting
      }
    }
    expect(existsSync(marker)).toBe(false)
    expect(runCheck(check).send).toBe(true)
    expect(existsSync(marker)).toBe(true)
  })

  test('bare names search timer PATH, including empty/relative entries and later executable matches', () => {
    const first = join(work, 'path-first')
    const second = join(work, 'path second')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'gate'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    writeFileSync(join(second, 'gate'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const path = `${first}:${second}`
    expect(validateCheck('gate', { path })).toBeUndefined()
    expect(validateCheck('gate', { path: first })).toContain('EACCES')
    expect(validateCheck('missing', { path })).toContain('not found')
    expect(validateCheck('gate', { cwd: second, path: '' })).toBeUndefined()
    expect(validateCheck('gate', { cwd: work, path: 'path second' })).toBeUndefined()
    expect(validateCheck('./gate', { cwd: second })).toBeUndefined()
    expect(validateCheck('true')).toBeUndefined()
    expect(runCheck('true').send).toBe(true)
    expect(parseRegistration('timer', body('true')).ok).toBe(true)
  })

  test('a file removed after preflight still fails closed at fire time', () => {
    const check = makeScript('removed.sh', 'exit 0')
    expect(validateCheck(check)).toBeUndefined()
    rmSync(check)
    expect(runCheck(check).send).toBe(false)
    expect(runCheck(check).error).toBeDefined()
  })
})
