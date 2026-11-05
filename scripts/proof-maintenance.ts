// Run from a clean package extraction: bun scripts/proof-maintenance.ts --receipt /abs/result.json
// Actual signed install + actual compiled run loops. The IAP boundary is a local
// recording CLI, NOT a claim of native/core acceptance. All mutations are scratch-only.
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { selfInstall } from '../src/selfInstall.ts'
import pkg from '../package.json'

const root = mkdtempSync(join(tmpdir(), 'notifier-maintenance-'))
const receiptIndex = process.argv.indexOf('--receipt')
const receipt = receiptIndex >= 0 ? resolve(process.argv[receiptIndex + 1]!) : undefined
const checks: { check: string; details?: unknown }[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
let success = false
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const read = (p: string) => existsSync(p) ? readFileSync(p, 'utf8') : ''
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const pass = (check: string, details?: unknown) => { checks.push({ check, details }); console.log(`PASS ${check}`) }
const until = async (message: string, fn: () => boolean, ms = 10000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (fn()) return; await Bun.sleep(50) }
  throw new Error(`timeout: ${message}`)
}
const script = (name: string, body: string) => {
  const p = join(root, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p
}
const env = { ...process.env, HOME: join(root, 'home'), IAPEER_ROOT: join(root, 'iap'), IAPEER_BIN_DIR: join(root, 'bin') }
const run = (bin: string, args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(bin, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' })
try {
  const installed = selfInstall({ env, sourceEntry: resolve(import.meta.dir, '../src/cli.ts') })
  const bin = installed.binPath
  assert(run(bin, ['--help']).status === 0, 'installed binary must execute')
  assert(JSON.parse(read(installed.manifestPath)).version === pkg.version, 'version stamp')
  if (process.platform === 'darwin') assert(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bin]).status === 0, 'strict signature')
  pass('fresh compile, strict signature and executable CLI', { version: pkg.version, sha256: sha(bin), signature: installed.signature })
  const copyEnv = { IAPEER_ROOT: join(root, 'copy-iap'), IAPEER_BIN_DIR: join(root, 'copy-bin') }
  assert(run(bin, ['self-install'], copyEnv).status === 0, 'copy-self install')
  assert(sha(join(copyEnv.IAPEER_BIN_DIR, 'notifier-runtime')) === sha(bin), 'copy preserves signature bytes')
  pass('native copy-self preserves signed bytes')

  const old = { sha: sha(bin), inode: statSync(bin).ino, manifest: read(installed.manifestPath) }
  const blocked = join(root, 'blocked'); writeFileSync(blocked, 'not a directory')
  assert(run(bin, ['self-install'], { IAPEER_ROOT: blocked }).status !== 0, 'ENOTDIR must fail')
  assert(sha(bin) === old.sha && statSync(bin).ino === old.inode && read(installed.manifestPath) === old.manifest, 'ENOTDIR changed installed pair')
  pass('real ENOTDIR preserves binary inode and manifest')

  rmSync(installed.manifestPath); mkdirSync(installed.manifestPath)
  writeFileSync(join(installed.manifestPath, 'keep'), 'keep')
  assert(run(bin, ['self-install']).status !== 0, 'EISDIR must fail after binary publication')
  assert(sha(bin) === old.sha && statSync(bin).ino === old.inode, 'late failure did not restore inode')
  assert(read(join(installed.manifestPath, 'keep')) === 'keep', 'late failure touched old manifest directory')
  rmSync(installed.manifestPath, { recursive: true }); writeFileSync(installed.manifestPath, old.manifest)
  pass('real late EISDIR restores signed binary inode')

  const truncated = join(root, 'truncated'); writeFileSync(truncated, readFileSync(bin).subarray(0, 1024)); chmodSync(truncated, 0o755)
  if (process.platform === 'darwin') {
    let refused = false
    try { selfInstall({ env, execPath: truncated, sourceEntry: '/missing-source.ts' }) } catch { refused = true }
    assert(refused && sha(bin) === old.sha && read(installed.manifestPath) === old.manifest, 'invalid signature must preserve pair')
    pass('real codesign rejects truncated Mach-O without changing pair')
  }

  const owner = join(root, 'owner'); mkdirSync(join(owner, '.iapeer'), { recursive: true })
  const ownerProfile = join(owner, '.iapeer/peer-profile.json')
  writeFileSync(ownerProfile, JSON.stringify({ personality: 'probe', runtime: 'codex', intelligence: 'artificial' }))
  writeFileSync(join(env.IAPEER_ROOT, 'peers-profiles.json'), JSON.stringify({ peers: [{ personality: 'probe', cwd: owner, intelligence: 'artificial' }] }))
  // Sink reads a real spawned CLI's stdin and records each outbound payload.
  const sink = join(root, 'sink.ts'), wire = join(root, 'wire.jsonl')
  writeFileSync(sink, `import {appendFileSync} from 'fs'; const message = await Bun.stdin.text(); appendFileSync(${JSON.stringify(wire)}, JSON.stringify({target:process.argv[3],message})+'\\n'); console.log('delivered to '+process.argv[3]);\n`)
  const iap = script('iap-cli', `exec '${process.execPath}' '${sink}' "$@"`)
  const messages = () => read(wire).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) as { target: string; message: string }[]
  const start = async (role: 'timer' | 'watcher') => {
    const cwd = join(root, role); mkdirSync(cwd)
    const log = join(root, `${role}.log`)
    const child = Bun.spawn([bin, 'run'], { cwd, env: { ...env, IAP_BIN: iap, NOTIFIER_FALLBACK_TARGET: 'probe', PEER_PERSONALITY: role, PEER_RUNTIME: 'notifier', PEER_IDENTITY: `notifier-${role}` }, stdin: 'pipe', stdout: Bun.file(log), stderr: Bun.file(join(root, `${role}.err`)) })
    children.push(child)
    await until(`${role} start`, () => read(log).includes('"evt":"start"'))
    return { child, log, send: (body: unknown) => { child.stdin!.write(`<iap from="probe" runtime="codex" topic="maintenance"><msg>${JSON.stringify(body)}</msg></iap>\n`); child.stdin!.flush() } }
  }
  const timer = await start('timer')
  timer.send({ id: 'calendar', when: '0 0 1 1 *', message: 'unused', target: 'self' })
  await until('calendar warning reply', () => messages().some(m => m.message.includes('NEXT FIRE IS IN') && m.message.includes('NOT a one-shot')))
  const before = read(ownerProfile)
  for (const when of ['0 0 30 2 *', '@every 9000000000000s']) {
    timer.send({ id: 'calendar', when, message: 'bad', target: 'self' })
    await until(`schedule rejected ${when}`, () => messages().some(m => m.message.includes('Nothing was changed') && m.message.includes(when.startsWith('@') ? 'date range' : 'search horizon')))
    assert(read(ownerProfile) === before, 'invalid replacement changed profile')
  }
  pass('compiled timer warns about cron rollover; impossible/overflow replace preserves profile', messages().map(m => m.message).filter(m => /NEXT FIRE|Nothing was changed/.test(m)))

  const marker = join(root, 'gate-ran')
  const gate = script('gate with spaces', `if /bin/mkdir '${marker}' 2>/dev/null; then trap '' TERM; exec /bin/sleep 45; fi\nexit 1`)
  timer.send({ id: 'hang', when: '@every 1s', message: 'MUST_NOT_SEND', check: gate, target: 'self' })
  await until('gate registered without execution', () => messages().some(m => m.message.includes('registered timer trigger "hang"')))
  assert(!existsSync(marker), 'preflight executed gate')
  timer.send({ id: 'beat', when: '@every 1s', message: 'TIMER_OK', target: 'self' })
  await until('hard check timeout and subsequent timer delivery', () => read(timer.log).includes('"reason":"check-timeout"') && messages().some(m => m.message === 'TIMER_OK'), 38000)
  assert(!messages().some(m => m.message === 'MUST_NOT_SEND'), 'timed-out gate sent payload')
  pass('real 30s check timeout hard-kills TERM-ignoring executable; timer continues and sends')

  const watcher = await start('watcher')
  const watchScript = script('watch.sh', "printf 'WATCHER_OK\\n'\nexec /bin/sleep 300")
  watcher.send({ id: 'watch', script: watchScript, target: 'self' })
  await until('watcher forwards verbatim', () => messages().some(m => m.message === 'WATCHER_OK'))
  pass('compiled watcher starts real script and forwards stdout verbatim')
  for (const id of ['calendar', 'hang', 'beat']) timer.send({ cmd: 'unregister', id })
  watcher.send({ cmd: 'unregister', id: 'watch' })
  await until('all test triggers removed', () => JSON.parse(read(ownerProfile)).notifier.triggers.length === 0)
  pass('runtime unregister cleans only isolated owner triggers')
  success = true
} finally {
  for (const child of children) {
    child.stdin?.end(); child.kill('SIGTERM')
    if (await Promise.race([child.exited.then(() => true), Bun.sleep(4000).then(() => false)]) === false) child.kill('SIGKILL')
    await child.exited
  }
  const result = { success, version: pkg.version, at: new Date().toISOString(), boundary: 'real signed binary and scripts; recording CLI instead of core/native acceptance', checks,
    logs: Object.fromEntries(['timer', 'watcher'].map(role => [role, read(join(root, `${role}.log`))])) }
  if (receipt) { mkdirSync(dirname(receipt), { recursive: true }); writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n') }
  console.log(JSON.stringify({ success, checks: checks.length, receipt }))
  rmSync(root, { recursive: true, force: true })
}
