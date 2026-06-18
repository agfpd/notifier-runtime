import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FakeTransport, makeAsyncIapTransport, makeIapTransport } from '../src/transport.ts'

const work = mkdtempSync(join(tmpdir(), 'notifier-transport-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('FakeTransport', () => {
  test('records signals and returns configured result', () => {
    const t = new FakeTransport()
    expect(t.send({ target: 'boris', message: 'hi' })).toEqual({ ok: true })
    t.result = { ok: false, error: 'boom' }
    expect(t.send({ target: 'boris', message: 'again', topic: 'x' })).toEqual({ ok: false, error: 'boom' })
    expect(t.sent).toEqual([
      { target: 'boris', message: 'hi' },
      { target: 'boris', message: 'again', topic: 'x' },
    ])
  })
})

describe('makeIapTransport — argv/env/stdin golden (stub binary, no real iap)', () => {
  // Stub `iap` that records argv, stdin and a couple of env vars to a file, so
  // we can assert the exact command shape without touching a live peer.
  function makeStub(name: string, exitCode = 0): { bin: string; out: string } {
    const out = join(work, `${name}.out`)
    const bin = join(work, name)
    writeFileSync(
      bin,
      [
        '#!/usr/bin/env bash',
        `OUT=${JSON.stringify(out).replace(/"/g, '')}`,
        // Record argv one per line, then a marker, then stdin, then env markers.
        'printf "ARGV\\n" > "$OUT"',
        'for a in "$@"; do printf "%s\\n" "$a" >> "$OUT"; done',
        'printf "STDIN\\n" >> "$OUT"',
        'cat >> "$OUT"',
        'printf "\\nCWD=%s\\n" "$PWD" >> "$OUT"',
        'printf "MARK=%s\\n" "${NOTIFIER_TEST_MARK:-}" >> "$OUT"',
        `exit ${exitCode}`,
      ].join('\n') + '\n',
      { mode: 0o755 },
    )
    chmodSync(bin, 0o755)
    return { bin, out }
  }

  test('builds `send <target> --message-file -` with message on stdin', () => {
    const { bin, out } = makeStub('iap-ok')
    const t = makeIapTransport({ iapBin: bin, cwd: work, env: { ...process.env, NOTIFIER_TEST_MARK: 'm1' } })
    const res = t.send({ target: 'boris', message: 'hello world' })
    expect(res.ok).toBe(true)

    const recorded = readFileSync(out, 'utf8')
    const [argvBlock, rest] = recorded.split('\nSTDIN\n')
    const argv = argvBlock.replace(/^ARGV\n/, '').split('\n').filter(Boolean)
    expect(argv).toEqual(['send', 'boris', '--message-file', '-'])
    // stdin carries the message verbatim.
    expect(rest.startsWith('hello world')).toBe(true)
    // cwd is honored — compare on the basename to dodge the macOS /var → /private/var
    // symlink that $PWD canonicalizes (the dir itself matches, only the prefix differs).
    expect(rest).toContain(`CWD=`)
    expect(rest).toContain(work.split('/').pop()!)
    expect(rest).toContain('MARK=m1')
  })

  test('appends --topic when present', () => {
    const { bin, out } = makeStub('iap-topic')
    const t = makeIapTransport({ iapBin: bin, cwd: work, env: process.env })
    t.send({ target: 'boris', message: 'm', topic: 'daily' })
    const argv = readFileSync(out, 'utf8')
      .split('\nSTDIN\n')[0]
      .replace(/^ARGV\n/, '')
      .split('\n')
      .filter(Boolean)
    expect(argv).toEqual(['send', 'boris', '--message-file', '-', '--topic', 'daily'])
  })

  test('non-zero exit → ok:false with stderr/stdout detail', () => {
    const bin = join(work, 'iap-fail')
    writeFileSync(
      bin,
      '#!/usr/bin/env bash\necho "delivery refused" >&2\nexit 7\n',
      { mode: 0o755 },
    )
    chmodSync(bin, 0o755)
    const t = makeIapTransport({ iapBin: bin })
    const res = t.send({ target: 'boris', message: 'm' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('delivery refused')
  })

  test('spawn error (ENOENT bin) → ok:false', () => {
    const t = makeIapTransport({ iapBin: '/nonexistent/iap-binary' })
    const res = t.send({ target: 'boris', message: 'm' })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })
})

describe('makeAsyncIapTransport — spawn + hard timeout (the spawnSync mine)', () => {
  function makeAsyncStub(name: string, body: string[]): string {
    const bin = join(work, name)
    writeFileSync(bin, ['#!/usr/bin/env bash', ...body].join('\n') + '\n', { mode: 0o755 })
    chmodSync(bin, 0o755)
    return bin
  }

  test('exit 0 → ok', async () => {
    const bin = makeAsyncStub('aiap-ok', ['cat > /dev/null', 'exit 0'])
    const t = makeAsyncIapTransport({ iapBin: bin })
    expect(await t.send({ target: 'boris', message: 'hi' })).toEqual({ ok: true })
  })

  test('non-zero exit → error carries stderr detail', async () => {
    const bin = makeAsyncStub('aiap-fail', ['cat > /dev/null', 'echo "wake failed: never-became-ready" >&2', 'exit 7'])
    const t = makeAsyncIapTransport({ iapBin: bin })
    const r = await t.send({ target: 'linus', message: 'alarm' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('never-became-ready')
  })

  test('a HUNG send is killed at the timeout and reported, promptly', async () => {
    // The old spawnSync path had NO timeout: this exact child would wedge the
    // whole notifier forever. Now it is killed and the loop lives on.
    const bin = makeAsyncStub('aiap-hang', ['cat > /dev/null', 'sleep 30'])
    const t = makeAsyncIapTransport({ iapBin: bin, timeoutMs: 250 })
    const started = Date.now()
    const r = await t.send({ target: 'linus', message: 'alarm' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('timed out after 250ms')
  })

  test('missing binary → error, not an exception', async () => {
    const t = makeAsyncIapTransport({ iapBin: join(work, 'no-such-bin') })
    const r = await t.send({ target: 'boris', message: 'hi' })
    expect(r.ok).toBe(false)
    expect(r.error!.length).toBeGreaterThan(0)
  })
})
