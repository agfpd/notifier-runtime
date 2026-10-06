import { describe, expect, test } from 'bun:test'
import {
  ensureExecutableSignature, type InstallCommandResult, type InstallCommandRunner,
} from '../src/installSignature.ts'

const PATH = '/sandbox/bin/notifier-runtime.tmp'
const VERIFY = ['--verify', '--deep', '--strict', PATH]
const SIGN = ['--force', '--sign', '-', PATH]
const ok: InstallCommandResult = { status: 0 }
const invalid: InstallCommandResult = { status: 1, stderr: 'invalid signature' }

function runner(results: InstallCommandResult[]) {
  const calls: string[][] = []
  const run: InstallCommandRunner = (command, args, opts) => {
    expect(command).toBe('/usr/bin/codesign')
    expect(opts.encoding).toBe('utf8')
    expect(opts.timeout).toBe(30_000)
    expect(opts.killSignal).toBe('SIGKILL')
    calls.push(args)
    const result = results[calls.length - 1]
    if (!result) throw new Error('unexpected command')
    return result
  }
  return { run, calls }
}

describe('ensureExecutableSignature', () => {
  test('other platforms skip codesign entirely', () => {
    expect(ensureExecutableSignature(PATH, {
      platform: 'linux', run: () => { throw new Error('must not run') },
    })).toBe('skipped')
  })

  test('strict-valid signatures are preserved — one verify, no sign (TCC)', () => {
    const { run, calls } = runner([ok])
    expect(ensureExecutableSignature(PATH, { platform: 'darwin', run })).toBe('valid')
    expect(calls).toEqual([VERIFY])
  })

  test('invalid/unsigned signature: verify → force ad-hoc sign → strict verify', () => {
    const { run, calls } = runner([invalid, ok, ok])
    expect(ensureExecutableSignature(PATH, { platform: 'darwin', run })).toBe('repaired')
    expect(calls).toEqual([VERIFY, SIGN, VERIFY])
  })

  const operationalFailures: [string, InstallCommandResult][] = [
    ['launch error', { status: null, error: new Error('ENOENT') }],
    ['timeout', { status: null, error: new Error('ETIMEDOUT'), signal: 'SIGKILL' }],
    ['signal', { status: null, signal: 'SIGKILL' }],
    ['no exit status', { status: null }],
    ['error even with status zero', { status: 0, error: new Error('spawn error') }],
  ]
  for (const [name, failure] of operationalFailures) {
    test(`verify ${name} fails closed without re-signing`, () => {
      const { run, calls } = runner([failure])
      expect(() => ensureExecutableSignature(PATH, { platform: 'darwin', run })).toThrow('codesign verify failed')
      expect(calls).toEqual([VERIFY])
    })
  }

  for (const [stage, prefix, args] of [
    ['ad-hoc sign', [invalid], [VERIFY, SIGN]],
    ['verify after repair', [invalid, ok], [VERIFY, SIGN, VERIFY]],
  ] as const) {
    for (const [name, failure] of [['nonzero', invalid], ...operationalFailures] as [string, InstallCommandResult][]) {
      test(`${stage} ${name} is fatal, never accepted as installed`, () => {
        const { run, calls } = runner([...prefix, failure])
        expect(() => ensureExecutableSignature(PATH, { platform: 'darwin', run })).toThrow(`codesign ${stage} failed`)
        expect(calls).toEqual([...args])
      })
    }
  }

  test('thrown runner error is reported and cannot trigger repair', () => {
    let calls = 0
    expect(() => ensureExecutableSignature(PATH, {
      platform: 'darwin',
      run: () => { calls++; throw new Error('runner failed') },
    })).toThrow('codesign verify failed: runner failed')
    expect(calls).toBe(1)
  })
})
