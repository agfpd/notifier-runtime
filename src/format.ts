import { existsSync, statSync } from 'fs'
import { NAME_RE } from './constants.ts'
import { parseWhen } from './when.ts'

// ── Registration format — SINGLE SOURCE OF TRUTH ────────────────────────────
//
// One module owns: (1) the wire format for a registration message body,
// (2) `parseRegistration` which validates a body and produces a typed command,
// (3) `describeFormat` which renders the human-facing self-doc (peer.description
// written by the self-config hook, selfConfig.ts), and (4) `EXAMPLES` — canonical
// JSON strings reused BOTH inside describeFormat AND in the invariant test.
//
// The reliability invariant (format.test.ts): every string in EXAMPLES[role]
// parses via parseRegistration to ok:true. Because describeFormat embeds those
// SAME strings, the examples a peer reads in its description are exactly the
// examples the test proves valid — the self-doc can never drift from the parser.
//
// VALIDATION IS FORMAT-ONLY: JSON parses, required fields
// present, `when` parses (timer), the watcher `script` path exists+executable,
// `target` is a resolvable name or "self", `id` is a valid name if present,
// `topic` within the length limit. We NEVER execute the script or run the
// schedule — path existence is a format check, not a behaviour check.

export type Role = 'timer' | 'watcher'

// Cap on the optional `topic` (provenance tag carried on every forwarded
// signal). Generous — it is a short label, not a payload.
export const MAX_TOPIC_LEN = 200

// A parsed `register` command. The trigger config is role-typed; `id` is the
// requester-chosen name (content-hashed downstream when absent). `target` may be
// the literal "self" here — self-resolution to the requester happens in
// registration.ts (which knows who `from` is); format validation only checks
// that target is either "self" or a syntactically-valid peer name.
export interface TimerConfig {
  id?: string
  when: string
  check?: string
  message: string
  target: string
  topic?: string
  // Escalation chain (notifier-alert-escalation): peer(s) to receive the signal
  // when the target stays unreachable after retries. Normalized to an array by
  // the parser (the wire accepts a single name or an array). May contain "self"
  // — resolved to the requester in registration.ts, like target.
  fallback?: string[]
}

export interface WatcherConfig {
  id?: string
  script: string
  target: string
  heartbeatSec?: number
  topic?: string
  // See TimerConfig.fallback — same semantics for watcher signals and alerts.
  fallback?: string[]
}

export type RegisterCommand =
  | { kind: 'register'; role: 'timer'; config: TimerConfig }
  | { kind: 'register'; role: 'watcher'; config: WatcherConfig }

export type Command =
  | RegisterCommand
  | { kind: 'unregister'; id: string }
  | { kind: 'list' }
  | { kind: 'help' }

export type ParseResult = { ok: true; command: Command } | { ok: false; error: string }

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// Bare conversational help token: "help" (any case) or "?". Checked both before
// JSON.parse (a plain "help") and after (a quoted "help" / "?" JSON string).
function isHelpToken(s: string): boolean {
  return s === '?' || s.toLowerCase() === 'help'
}

// A target is valid if it is the literal "self" (resolved to the requester
// later) OR a syntactically-valid peer personality. We do NOT check the registry
// here — registry resolvability for a concrete target is enforced in
// registration.ts where the registry is injected. (Format layer stays pure.)
function isValidTarget(target: string): boolean {
  return target === 'self' || NAME_RE.test(target)
}

// Validate the watcher `script` as a FORMAT check: the script
// is shell-invoked, so a full command line ("tail -F x | grep y") is legal — we
// only hard-validate the leading token WHEN it looks like a filesystem path
// (contains "/"): it must exist, be a file, and be executable. A bare command
// (resolved via PATH at runtime) passes. Injectable fs probes keep it testable
// without touching disk. We NEVER run the script.
export interface ScriptProbe {
  exists: (path: string) => boolean
  // returns the mode (st.mode) and isFile flag, or null if stat throws/missing.
  stat: (path: string) => { mode: number; isFile: boolean } | null
}

const defaultScriptProbe: ScriptProbe = {
  exists: p => existsSync(p),
  stat: p => {
    try {
      const st = statSync(p)
      return { mode: st.mode, isFile: st.isFile() }
    } catch {
      return null
    }
  },
}

function validateScript(script: string, probe: ScriptProbe): string | undefined {
  const firstToken = script.trim().split(/\s+/)[0] ?? ''
  if (firstToken.length === 0) return 'script is empty'
  if (!firstToken.includes('/')) return undefined // bare command, resolved via PATH at runtime
  if (!probe.exists(firstToken)) return `script not found: ${firstToken}`
  const st = probe.stat(firstToken)
  if (!st) return `script not found: ${firstToken}`
  if (!st.isFile) return `script is not a file: ${firstToken}`
  if ((st.mode & 0o111) === 0) return `script not executable: ${firstToken}`
  return undefined
}

export interface ParseOptions {
  // Injectable script existence/exec probe for watcher validation in tests.
  scriptProbe?: ScriptProbe
}

// Parse + format-validate a registration message body for the given session
// role. On any failure returns a TEACHING error: a one-line "what is wrong"
// followed by the full format doc + an example (so the requester self-corrects
// from the reply alone).
//
// Command discriminator: the body is JSON; if
// `cmd` ∈ {unregister, list} → that verb; otherwise → register (the body IS the
// trigger config). A register body is validated against `role`.
export function parseRegistration(role: Role, body: string, opts: ParseOptions = {}): ParseResult {
  // Bare conversational help — NOT JSON. "help" (any case) or "?" → the friendly
  // help command (active triggers + format), rendered by the registration layer.
  // Intercept BEFORE JSON.parse so a bare "help" is help, not a teaching error.
  const trimmed = body.trim()
  if (isHelpToken(trimmed)) {
    return { ok: true, command: { kind: 'help' } }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (err) {
    return teach(role, `body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  // A QUOTED bare help ("help" / "?") also lands here as a JSON string → help.
  if (typeof parsed === 'string') {
    if (isHelpToken(parsed.trim())) return { ok: true, command: { kind: 'help' } }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return teach(role, 'body must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>

  const cmd = asString(obj.cmd)
  if (cmd === 'help') return { ok: true, command: { kind: 'help' } }
  if (cmd === 'unregister') return parseUnregister(role, obj)
  if (cmd === 'list') return { ok: true, command: { kind: 'list' } }
  if (cmd !== undefined && cmd !== 'register') {
    return teach(role, `unknown cmd "${cmd}" (expected "register", "unregister", "list" or "help")`)
  }

  return role === 'timer'
    ? parseTimerRegister(obj)
    : parseWatcherRegister(obj, opts.scriptProbe ?? defaultScriptProbe)
}

function parseUnregister(role: Role, obj: Record<string, unknown>): ParseResult {
  const id = asString(obj.id)
  if (!id || id.length === 0) return teach(role, 'unregister requires a non-empty "id"')
  if (!NAME_RE.test(id)) return teach(role, `invalid id "${id}" (must match ${NAME_RE})`)
  return { ok: true, command: { kind: 'unregister', id } }
}

// Shared optional-field validators. `id`/`topic` rules are identical across both
// roles — a single implementation keeps the teaching messages consistent.
function validateId(role: Role, obj: Record<string, unknown>): { id?: string } | { error: string } {
  if (obj.id === undefined) return {}
  const id = asString(obj.id)
  if (!id || id.length === 0) return { error: '"id" must be a non-empty string when present' }
  if (!NAME_RE.test(id)) return { error: `invalid id "${id}" (must match ${NAME_RE})` }
  return { id }
}

function validateTopic(obj: Record<string, unknown>): { topic?: string } | { error: string } {
  if (obj.topic === undefined) return {}
  const topic = asString(obj.topic)
  if (topic === undefined) return { error: '"topic" must be a string when present' }
  if (topic.length > MAX_TOPIC_LEN) return { error: `"topic" exceeds ${MAX_TOPIC_LEN} chars` }
  return topic.length > 0 ? { topic } : {}
}

// `fallback` accepts one peer name or an array; each element must be a valid
// peer name (or "self", resolved to the requester downstream — same rule as
// target). Normalized to a non-empty array, or absent.
function validateFallback(obj: Record<string, unknown>): { fallback?: string[] } | { error: string } {
  if (obj.fallback === undefined) return {}
  const raw = Array.isArray(obj.fallback) ? obj.fallback : [obj.fallback]
  if (raw.length === 0) return {}
  const out: string[] = []
  for (const f of raw) {
    if (typeof f !== 'string' || f.length === 0 || !isValidTarget(f)) {
      return { error: `invalid fallback ${JSON.stringify(f)} (each must be a peer name or "self")` }
    }
    out.push(f)
  }
  return { fallback: out }
}

function parseTimerRegister(obj: Record<string, unknown>): ParseResult {
  const idR = validateId('timer', obj)
  if ('error' in idR) return teach('timer', idR.error)

  const when = asString(obj.when)
  if (!when || when.length === 0) return teach('timer', 'missing "when" (cron or @every <duration>)')
  try {
    parseWhen(when)
  } catch (err) {
    return teach('timer', `invalid "when" (${when}): ${err instanceof Error ? err.message : String(err)}`)
  }

  const message = asString(obj.message)
  if (!message || message.length === 0) return teach('timer', 'missing non-empty "message"')

  const target = asString(obj.target)
  if (!target || target.length === 0) return teach('timer', 'missing "target" (peer name or "self")')
  if (!isValidTarget(target)) return teach('timer', `invalid target "${target}" (peer name or "self")`)

  let check: string | undefined
  if (obj.check !== undefined) {
    const c = asString(obj.check)
    if (!c || c.length === 0) return teach('timer', '"check" must be a non-empty path when present')
    check = c
  }

  const topicR = validateTopic(obj)
  if ('error' in topicR) return teach('timer', topicR.error)

  const fallbackR = validateFallback(obj)
  if ('error' in fallbackR) return teach('timer', fallbackR.error)

  const config: TimerConfig = {
    ...(idR.id ? { id: idR.id } : {}),
    when,
    ...(check ? { check } : {}),
    message,
    target,
    ...(topicR.topic ? { topic: topicR.topic } : {}),
    ...(fallbackR.fallback ? { fallback: fallbackR.fallback } : {}),
  }
  return { ok: true, command: { kind: 'register', role: 'timer', config } }
}

function parseWatcherRegister(obj: Record<string, unknown>, probe: ScriptProbe): ParseResult {
  const idR = validateId('watcher', obj)
  if ('error' in idR) return teach('watcher', idR.error)

  const script = asString(obj.script)
  if (!script || script.length === 0) return teach('watcher', 'missing non-empty "script"')
  const scriptErr = validateScript(script, probe)
  if (scriptErr) return teach('watcher', scriptErr)

  const target = asString(obj.target)
  if (!target || target.length === 0) return teach('watcher', 'missing "target" (peer name or "self")')
  if (!isValidTarget(target)) return teach('watcher', `invalid target "${target}" (peer name or "self")`)

  let heartbeatSec: number | undefined
  if (obj.heartbeatSec !== undefined) {
    const h = obj.heartbeatSec
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) {
      return teach('watcher', '"heartbeatSec" must be a positive number when present')
    }
    heartbeatSec = h
  }

  const topicR = validateTopic(obj)
  if ('error' in topicR) return teach('watcher', topicR.error)

  const fallbackR = validateFallback(obj)
  if ('error' in fallbackR) return teach('watcher', fallbackR.error)

  const config: WatcherConfig = {
    ...(idR.id ? { id: idR.id } : {}),
    script,
    target,
    ...(heartbeatSec !== undefined ? { heartbeatSec } : {}),
    ...(topicR.topic ? { topic: topicR.topic } : {}),
    ...(fallbackR.fallback ? { fallback: fallbackR.fallback } : {}),
  }
  return { ok: true, command: { kind: 'register', role: 'watcher', config } }
}

// ── Canonical examples (SINGLE SOURCE) ──────────────────────────────────────
// Reused in describeFormat (what a peer reads) AND in the invariant test (what
// is proven to parse). Edit here and both stay in lockstep. Each MUST parse to
// ok:true for its role — that is the format.test.ts invariant.
export const EXAMPLES: Record<Role, string[]> = {
  timer: [
    JSON.stringify({
      id: 'daily-standup',
      when: '0 9 * * *',
      message: 'Time for the daily standup',
      target: 'self',
    }),
    JSON.stringify({
      id: 'heartbeat',
      when: '@every 30m',
      message: 'still alive',
      target: 'ops',
      fallback: 'oncall',
      topic: 'health',
    }),
    JSON.stringify({ cmd: 'list' }),
    JSON.stringify({ cmd: 'unregister', id: 'heartbeat' }),
  ],
  watcher: [
    JSON.stringify({
      id: 'error-watch',
      script: 'tail -F /var/log/app.log | grep ERROR',
      target: 'self',
    }),
    JSON.stringify({
      id: 'disk-watch',
      script: 'monitor-disk',
      target: 'ops',
      fallback: 'oncall',
      heartbeatSec: 60,
      topic: 'infra',
    }),
    JSON.stringify({ cmd: 'list' }),
    JSON.stringify({ cmd: 'unregister', id: 'error-watch' }),
  ],
}

// Render the self-doc for peer.description (written by the self-config hook,
// selfConfig.ts). Embeds EXAMPLES[role] verbatim so the description and the
// invariant test share one source.
export function describeFormat(role: Role): string {
  const lines: string[] = []
  if (role === 'timer') {
    lines.push(
      'notifier-timer — schedule-based trigger registration (TIME).',
      'Send send_to_peer(timer, <JSON>). The body is a JSON object:',
      '',
      'register (default, or {"cmd":"register",...}): a timer-trigger config',
      '  {"id"?: <name>, "when": <cron | @every Nm>, "message": <text>,',
      '   "target": <peer name | "self">, "check"?: <path>, "topic"?: <label>,',
      '   "fallback"?: <peer | [peer,…]>}',
      '  • when: 5-field cron ("0 9 * * *") or interval ("@every 30m").',
      '  • message arrives in a NEW session → keep it self-contained.',
      '  • target "self" → your own profile (the requester). id optional (none → auto content-hash).',
      '  • check: a path gate — fire only if the script exits 0.',
      '  • fallback: escalation chain — if target stays unreachable after retries, the signal',
      '    goes to your fallback peer(s), then to you (owner), then to the global backstop if set. Never silently dropped.',
      '  • re-registering the same id = REPLACE.',
    )
  } else {
    lines.push(
      'notifier-watcher — watcher-trigger registration (EVENT).',
      'Send send_to_peer(watcher, <JSON>). The body is a JSON object:',
      '',
      'register (default, or {"cmd":"register",...}): a watcher-trigger config',
      '  {"id"?: <name>, "script": <command>, "target": <peer name | "self">,',
      '   "heartbeatSec"?: <sec>, "topic"?: <label>, "fallback"?: <peer | [peer,…]>}',
      '  • script: a long-lived command; each non-empty stdout line → a signal to target (the line IS the payload).',
      '  • target "self" → your own profile (the requester). id optional (none → auto content-hash).',
      '  • heartbeatSec: silence longer than it → restart + alert owner (hang detection).',
      '  • fallback: escalation chain — if target stays unreachable after retries, the signal',
      '    goes to your fallback peer(s), then to you (owner), then to the global backstop if set. Never silently dropped.',
      '  • re-registering the same id = REPLACE.',
    )
  }
  lines.push(
    '',
    'unregister: {"cmd":"unregister","id": <name>}  — remove your trigger.',
    'list: {"cmd":"list"}  — show your triggers.',
    '',
    'Examples:',
    ...EXAMPLES[role].map(ex => `  ${ex}`),
  )
  return lines.join('\n')
}

// Build a TEACHING error reply: the concrete problem + the full format doc +
// examples (describeFormat already embeds EXAMPLES). One self-contained message
// the requester can act on without any out-of-band docs.
function teach(role: Role, problem: string): ParseResult {
  return {
    ok: false,
    error: `notifier-${role}: ${problem}\n\n${describeFormat(role)}`,
  }
}
