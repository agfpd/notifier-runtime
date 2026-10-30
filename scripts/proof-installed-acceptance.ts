// Derived from iapeer/scripts/proof-installed-legacy-operators.ts (0.4.155).
// Setup imports sibling iapeer source; all sends/supervisor operations run installed binaries.
// --runtime codex --role timer|watcher --scenario refusal|delivered|unresolved --artifacts <dir>
// Installed Claude/Codex parity for proof-installed-operators.ts (OpenCode).
// Native TUI + loopback provider; no cloud credentials or host configuration.
// Source imports only arrange fixtures/read native records. All operations use --bin.
// bun scripts/proof-installed-legacy-operators.ts --runtime claude|codex --artifacts <dir>
// Wire docs checked 2026-10-18:
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://developers.openai.com/api/docs/guides/streaming-responses
// https://developers.openai.com/codex/config-advanced#custom-model-providers
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findSurfaceNamespace, findSurfaceTool, proveReload, surfaceNames, surfaceProofServer } from '../../iapeer/scripts/reload-proof.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const runtime = arg('--runtime')
if (runtime !== 'claude' && runtime !== 'codex') throw new Error('set --runtime claude|codex')
const hostHome = homedir(), bin = resolve(arg('--bin') ?? join(hostHome, '.local/bin/iapeer'))
const native = resolve(arg('--native') ?? (runtime === 'claude' ? join(hostHome, '.local/bin/claude') : '/opt/homebrew/bin/codex'))
const artifacts = arg('--artifacts')
let cliBin = arg('--legacy-bin') ?? bin
const binSHA256 = createHash('sha256').update(readFileSync(bin)).digest('hex')
const legacyBinSHA256 = arg('--legacy-bin') ? createHash('sha256').update(readFileSync(resolve(arg('--legacy-bin')!))).digest('hex') : undefined
const root = realpathSync(mkdtempSync(`/tmp/iap-installed-${runtime}-operators-`)), home = join(root, 'home'), iap = join(root, 'iapeer')
let personality = 'operator-proof', cwd = join(root, personality)
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true })
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const wire: any[] = [], results: any[] = []
let toolAction: 'sleep' | 'self-fresh' | undefined
let contactSent = false
let useSurface = false, busyNext = false, busyReceived = false, releaseBusy: (() => void) | undefined
const surface = surfaceProofServer()
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body: any = await req.json().catch(() => ({})), path = new URL(req.url).pathname
  wire.push({ time: Date.now(), path, body })
  if (path.includes('count_tokens')) return Response.json({ input_tokens: 100 })
  if (!path.endsWith('/messages') && !path.endsWith('/responses')) return Response.json({})
  const id = wire.length
  const contact = process.argv.includes('--limit-resume-only') && !contactSent && JSON.stringify(body).includes('AUTONOMOUS_CONTACT_PROOF')
  if (contact) contactSent = true
  // Telemetry/title requests are not the instructed native turn. Consume an
  // action only when its test input reaches a tool-capable inference request.
  const toolCapable = JSON.stringify(body.tools ?? []).includes(runtime === 'claude' ? '"Bash"' : '"exec_command"')
  if (busyNext && toolCapable && JSON.stringify(body).includes('RELOAD_BUSY_PROOF')) {
    busyNext = false; busyReceived = true
    await new Promise<void>(r => { releaseBusy = r })
  }
  const surfaceTool = useSurface ? findSurfaceTool(body.tools) : undefined
  const surfaceNamespace = surfaceTool ? findSurfaceNamespace(body.tools) : undefined
  if (surfaceTool) useSurface = false
  const action = toolAction && toolCapable && JSON.stringify(body).includes(toolAction === 'sleep' ? 'INTERRUPT_OPERATOR_PROOF' : 'SELF_FRESH_OPERATOR_PROOF') ? toolAction : undefined
  if (action) toolAction = undefined
  const command = contact ? `${JSON.stringify(bin)} send sender --runtime notifier --from ${runtime}-${personality} --message AUTONOMOUS_CONTACT_PROOF` : action === 'sleep' ? `echo $$ > ${JSON.stringify(join(root, 'sleep.pid'))}; exec /bin/sleep 180` : `${JSON.stringify(bin)} self-fresh`
  const text = `PROBE_REPLY_${id}`
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  if (runtime === 'codex') {
    const item = surfaceTool ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: surfaceTool, ...(surfaceNamespace ? { namespace: surfaceNamespace } : {}), arguments: '{}' } : action || contact
      ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: command, yield_time_ms: 10000 }) }
      : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const response = { id: `resp_${id}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } }
    return new Response([
      event('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }),
      event('response.completed', { type: 'response.completed', response }),
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const content = surfaceTool ? [{ type: 'tool_use' as const, id: `toolu_${id}`, name: surfaceTool, input: {} }] : action || contact
    ? [{ type: 'tool_use' as const, id: `toolu_${id}`, name: 'Bash', input: { command, timeout: 300000, description: 'Isolated native operator proof' } }]
    : [{ type: 'text' as const, text }]
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-5', content, stop_reason: action || surfaceTool || contact ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
  if (!body.stream) return Response.json(message)
  let stream = event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
  for (const [index, block] of content.entries()) {
    stream += event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    stream += event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text } })
    stream += event('content_block_stop', { type: 'content_block_stop', index })
  }
  stream += event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
  stream += event('message_stop', { type: 'message_stop' })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
} })
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('reserve') } })
const port = reserve.port!; reserve.stop(true)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), TERM: 'xterm-256color',
  IAPEER_ROOT: iap, IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_SOCK_DIR: join(root, 's'),
  IAPEER_PORT: String(port), IAPEER_DAEMON_SOCKET: join(root, 'router.sock'),
  IAPEER_CLAUDE_BIN: process.argv.includes('--limit-resume-only') ? join(hostHome, '.local/bin/claude') : native, IAPEER_CODEX_BIN: process.argv.includes('--limit-resume-only') ? '/opt/homebrew/bin/codex' : native, IAPEER_IDLE_SECS: ['--unknown-delivery-only', '--death-delivery-only', '--refusal-delivery-only'].some(flag => process.argv.includes(flag)) ? '600' : '15',
  ANTHROPIC_BASE_URL: provider.url.origin, ANTHROPIC_AUTH_TOKEN: 'synthetic-local-only', ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', HOMEBREW_NO_AUTO_UPDATE: '1',
}
env.IAPEER_IDLE_SECS = '600'
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)
const { initPeer } = await import('../../iapeer/src/init/index.ts')
const { upsertPeer } = await import('../../iapeer/src/registry/index.ts')
const { writePeerProfileAtomic } = await import('../../iapeer/src/identity/index.ts')
const { peerLaunchEnvPath } = await import('../../iapeer/src/storage/index.ts')
const { startSupervisorDaemon } = await import('../../iapeer/src/supervisor/index.ts')
const { readPidFile } = await import('../../iapeer/src/supervisor/paths.ts')
const { hostSessionReady } = await import('../../iapeer/src/launch/ptyHost.ts')
const { compactDoneBaseline, compactTranscriptHasDone } = await import('../../iapeer/src/transport/index.ts')
const { transcriptSlug } = await import('../../iapeer/src/launch/adapters/claude.ts')
const runDir = join(iap, 'state/supervisor'), lifecycle = join(iap, 'state/lifecycle')
const identity = () => `${runtime}-${personality}`
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const hosting = () => ({ pid: readPidFile(runDir, identity())?.pid, ready: read(join(runDir, identity() + '.ready')).trim() })
const transcripts = () => files(runtime === 'claude' ? join(home, '.claude/projects', transcriptSlug(cwd)) : join(home, '.codex/sessions')).filter(p => p.endsWith('.jsonl'))
const records = () => transcripts().flatMap(p => read(p).split('\n').flatMap(l => { try { return [{ path: p, ...JSON.parse(l) }] } catch { return [] } }))
  .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0))
const nativeSession = (): string | undefined => {
  const rows = records()
  if (runtime === 'claude') return rows.findLast(r => r.sessionId)?.sessionId
  return rows.findLast(r => r.type === 'session_meta' && r.payload?.cwd && realpathSync(r.payload.cwd) === realpathSync(cwd))?.payload?.id
}
const until = async (what: string, f: () => unknown | Promise<unknown>, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return; await Bun.sleep(100) }
  throw new Error(`timeout: ${what}`)
}
const record = (check: string, details: unknown) => { results.push({ check, time: Date.now(), details }); console.log(`PASS ${check}`) }
const cli = async (...args: string[]) => {
  const t = Date.now(), p = Bun.spawn([cliBin, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  const r = { args, code, stdout, stderr, ms: Date.now() - t }; results.push({ cli: r })
  return r
}
const must = async (...args: string[]) => { const r = await cli(...args); if (r.code) throw new Error(JSON.stringify(r)); return r }
const send = async (message: string) => must('send', personality, '--runtime', runtime, '--from', 'notifier-sender', '--topic', 'operator-proof', '--message', message)
const completedAfter = (start: number) => records().some(r => Date.parse(r.timestamp) >= start && (runtime === 'claude' ? r.type === 'assistant' && r.message?.stop_reason === 'end_turn' : r.type === 'event_msg' && r.payload?.type === 'task_complete'))
const turn = async (message: string) => { const t = Date.now(); await send(message); await until('native completed turn', () => completedAfter(t)); await Bun.sleep(500) }
let daemon: ReturnType<typeof Bun.spawn> | undefined, attached: ReturnType<typeof Bun.spawn> | undefined, success = false
let stoppedChild: number | undefined
const role = arg('--role') ?? 'watcher', scenario = arg('--scenario') ?? 'delivered'
if (!['timer', 'watcher'].includes(role) || !['refusal', 'delivered', 'unresolved'].includes(scenario)) throw new Error('invalid role/scenario')
const notifierBin = resolve(arg('--notifier-bin') ?? join(hostHome, '.local/bin/notifier-runtime'))
const notifierSHA256 = createHash('sha256').update(readFileSync(notifierBin)).digest('hex')
const notifierCwd = join(root, role), notifierLog = join(root, `${role}.log`)
const spoolDir = join(iap, 'state/notifier', role, 'escalation')
const pending = () => files(spoolDir).filter(p => p.endsWith('.json')).map(p => JSON.parse(read(p)))
const marker = `NOTIFIER_${role.toUpperCase()}_${scenario.toUpperCase()}_ONCE`
const task = () => pending().find(e => e.message === marker)
const acceptance = () => files(join(runDir, 'acceptance')).filter(p => p.endsWith('.json')).map(p => JSON.parse(read(p))).find(r => r.message?.includes(marker))
const startNotifier = async () => {
  const startsBefore = read(notifierLog).split('"evt":"start"').length
  const r = await startSupervisorDaemon({ session: `notifier-${role}`, runtime: 'notifier', runDir,
    daemonArgv: [bin, 'supervisor'], serve: { argv: [notifierBin, 'run'], cwd: notifierCwd,
      env: { ...env, PEER_PERSONALITY: role, PEER_RUNTIME: 'notifier', PEER_IDENTITY: `notifier-${role}`, IAP_BIN: bin, NOTIFIER_FALLBACK_TARGET: 'backstop' }, paneLogPath: notifierLog } })
  if (r.state !== 'started') throw new Error(JSON.stringify(r))
  await until('notifier started', () => readPidFile(runDir, `notifier-${role}`)?.pid && read(notifierLog).split('"evt":"start"').length > startsBefore)
  const { markHostReady } = await import('../../iapeer/src/launch/ptyHost.ts')
  markHostReady(`notifier-${role}`, env)
}
try {
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex/config.toml'), `model = "gpt-5.4"\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n[model_providers.probe]\nname = "Loopback proof only"\nbase_url = "${provider.url.origin}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`)
  await initPeer({ cwd, runtime, personality, intelligence: 'artificial', env })
  if (scenario === 'delivered') {
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(join(cwd, '.codex/hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '/bin/sleep 8', timeout: 20 }] }],
    } }))
  }
  writeFileSync(peerLaunchEnvPath(cwd, runtime), "PEER_START_ARGS='--no-daemon -c model_reasoning_effort=low'\n")
  // A canonical /bin/cat tty echoes input once in the terminal driver and a
  // second time from cat. Use a raw stdin sink so pane occurrences count real
  // routed envelopes, not local terminal echo (especially for fallback proof).
  const sinkScript = join(root, 'sink.ts')
  writeFileSync(sinkScript, `if (process.stdin.isTTY) process.stdin.setRawMode(true)\nprocess.stdout.write('SINK_READY\\n')\nprocess.stdin.on('data', d => process.stdout.write(d))\n`)
  for (const name of ['sender', 'relay', 'operator', 'backstop']) {
    const dir = join(root, name)
    writePeerProfileAtomic(dir, { personality: name, runtime: 'notifier', runtimes: ['notifier'], intelligence: 'artificial' })
    await upsertPeer({ personality: name, runtime: 'notifier', intelligence: 'artificial', cwd: dir }, { env })
    const sink = await startSupervisorDaemon({ session: `notifier-${name}`, runtime: 'notifier', runDir, daemonArgv: [bin, 'supervisor'],
      serve: { argv: [process.execPath, sinkScript], env: {}, cwd: root, paneLogPath: join(root, `${name}.log`) } })
    if (sink.state !== 'started') throw new Error(JSON.stringify(sink))
    await until('raw sink ready', () => read(join(root, `${name}.log`)).includes('SINK_READY'))
  }
  writeFileSync(join(iap, 'alerts.json'), JSON.stringify({ peer: 'operator', runtime: 'notifier' }))
  writePeerProfileAtomic(notifierCwd, { personality: role, runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
  await upsertPeer({ personality: role, runtime: 'notifier', intelligence: 'absent', cwd: notifierCwd }, { env })
  await must('version')
  daemon = Bun.spawn([bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
  await until('installed daemon ready', () => read(join(root, 'daemon.err')).includes('daemon READY'))
  if (scenario !== 'delivered') {
    await turn('FIRST_OPERATOR_PROOF')
    if (scenario === 'refusal') await must('stop', personality, runtime)
    else {
      stoppedChild = Number(Bun.spawnSync(['pgrep', '-P', String(hosting().pid)]).stdout.toString().trim().split('\n')[0])
      if (!stoppedChild) throw new Error('native Codex child missing')
      process.kill(stoppedChild, 'SIGSTOP')
    }
  }
  await startNotifier()
  const script = join(root, 'signal.sh'), gate = join(root, 'gate.sh')
  writeFileSync(script, `#!/bin/sh\nif /bin/mkdir '${root}/emitted' 2>/dev/null; then printf '%s\\n' '${marker}'; fi\nexec /bin/sleep 300\n`); chmodSync(script, 0o700)
  writeFileSync(gate, `#!/bin/sh\nexec /bin/mkdir '${root}/emitted' 2>/dev/null\n`); chmodSync(gate, 0o700)
  const config = { ...(role === 'watcher' ? { script } : { when: '@every 1s', check: gate, message: marker }), target: personality, fallback: 'relay', id: 'acceptance-proof', topic: 'operator-proof' }
  await must('send', role, '--runtime', 'notifier', '--from', 'notifier-sender', '--message', JSON.stringify(config))
  if (scenario !== 'refusal') {
    await until('notifier persisted pending deliveryId', () => task()?.delivery?.phase === 'pending' && task()?.delivery?.deliveryId, 90000)
    const before = task(), oldPid = readPidFile(runDir, `notifier-${role}`)?.pid
    record('pending-durable', { before, oldPid, core: acceptance() })
    await must('supervisor', 'kill', `notifier-${role}`, '--run-dir', runDir)
    await until('old notifier hosting exited', () => !readPidFile(runDir, `notifier-${role}`)?.pid && (!oldPid || !alive(oldPid)))
    await startNotifier()
    const after = task(), newPid = readPidFile(runDir, `notifier-${role}`)?.pid
    if (!after || after.delivery?.deliveryId !== before.delivery.deliveryId || oldPid === newPid) throw new Error('restart lost correlation')
    record('notifier-restart-preserves-correlation', { after, oldPid, newPid })
    if (stoppedChild) { process.kill(stoppedChild, 'SIGKILL'); stoppedChild = undefined }
  }
  if (scenario === 'refusal') {
    await until('trigger fallback reached relay', () => read(join(root, 'relay.log')).includes(marker), 100000)
  } else if (scenario === 'delivered') {
    await until('core delivered consumed after notifier restart', () => acceptance()?.status === 'delivered' && acceptance()?.callerNotice === 'sent' && !task(), 100000)
  } else {
    await until('unresolved visible to trigger owner', () => task()?.delivery?.phase === 'unresolved' && read(join(root, 'sender.log')).includes('notifier-unresolved'), 180000)
  }
  await Bun.sleep(2000)
  const nativeUsers = records().filter(r => r.type === 'response_item' && r.payload?.role === 'user' && r.payload.content?.some((c: any) => c.type === 'input_text' && c.text.includes(marker)))
  const relay = read(join(root, 'relay.log')), owner = read(join(root, 'sender.log')), notifier = read(notifierLog)
  const relayCount = relay.split(marker).length - 1
  if (scenario === 'refusal' ? relayCount !== 1 || nativeUsers.length !== 0 : relayCount !== 0 || nativeUsers.length !== (scenario === 'delivered' ? 1 : 0)) throw new Error('wrong native input/fallback count')
  const attempts = notifier.split('\n').filter(l => l.includes('"evt":"deliver-attempt"') && l.includes(`"to":"${personality}"`))
  if (scenario !== 'refusal' && attempts.length !== 1) throw new Error(`task attempted ${attempts.length} times`)
  if (scenario === 'unresolved' && (!owner.includes('acceptance-proof') || owner.includes(marker))) throw new Error('owner notice missing trigger correlation or delegates original task')
  record('installed-notifier-final', { role, scenario, notifierBin, notifierSHA256, nativeUsers: nativeUsers.length, relayCount, taskAttempts: attempts.length,
    core: acceptance(), remainingSpool: pending(), owner, relay, notifier })
  success = true
} finally {
  if (stoppedChild) { try { process.kill(stoppedChild, 'SIGCONT') } catch {} }
  for (const id of [`${runtime}-${personality}`, `notifier-${role}`, ...['sender', 'relay', 'operator', 'backstop'].map(n => `notifier-${n}`)]) await cli('supervisor', 'kill', id, '--run-dir', runDir)
  if (daemon) { daemon.kill(); await daemon.exited }
  provider.stop(true); surface.stop()
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    for (const p of files(root).filter(p => /\.(json|jsonl|log|out|err|toml)$/.test(p) && !p.includes('/node_modules/') && !p.includes('/.tmp/'))) {
      const dest = join(artifacts, p.slice(root.length + 1)); mkdirSync(resolve(dest, '..'), { recursive: true }); cpSync(p, dest)
    }
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, bin, binSHA256, notifierBin, notifierSHA256, role, scenario, results }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ success, role, scenario, results }, null, 2))
  await Bun.sleep(500); rmSync(root, { recursive: true, force: true })
}
