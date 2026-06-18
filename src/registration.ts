import { createHash } from 'crypto'
import {
  describeFormat,
  parseRegistration,
  type Command,
  type Role,
  type RegisterCommand,
  type ScriptProbe,
} from './format.ts'
import { PeerProfileStore, type StoredTrigger } from './peerProfileStore.ts'
import type { Transport } from './transport.ts'

// ── Registration handler ────────────────────────────────────────────────────
//
// handleEnvelope is the dispatch point for a registration message that arrived
// on the notifier's pane (parsed into an IapEnvelope by envelope.ts). It:
//   1. format-validates the body against the session role (timer/watcher) via
//      the single-source parser (format.ts). Invalid → TEACHING reply (the error
//      already embeds the format + an example) and STOP.
//   2. for register: resolves target "self" → the requester, resolves the
//      requester's cwd via the registry, and writes the trigger into ONLY the
//      requester's profile (owner = from-personality — the SECURITY INVARIANT: a
//      peer can never write a trigger into another peer's profile). id absent →
//      auto content-hash. Same id → REPLACE.
//   3. for unregister/list: mutates/reads ONLY the requester's profile.
//   4. replies to the requester through the transport (OK / info / teaching).
//   5. calls reloadCb after any mutation so the running engine picks the change
//      up live (no restart).

// The minimal envelope shape handleEnvelope consumes. Mirrors IapEnvelope from
// envelope.ts; declared structurally so registration.ts does not depend on the
// envelope module's concrete type (looser coupling, easier to fake in tests).
export interface RegistrationEnvelope {
  fromPersonality: string
  message: string
  topic?: string
}

export interface RegistrationDeps {
  store: PeerProfileStore
  transport: Transport
  // Re-project + live-reload the running engine. Called once after every
  // successful MUTATION (register/unregister), never after a pure list or a
  // validation failure. Errors here are caught + logged, never thrown back.
  reloadCb?: () => void
  log?: (evt: string, fields?: Record<string, unknown>) => void
  // Injected by tests for deterministic script-existence checks; passed straight
  // through to parseRegistration.
  scriptProbe?: ScriptProbe
}

export interface HandleResult {
  // What the handler did — surfaced for logging/tests. 'rejected' = teaching
  // error sent; 'registered'/'unregistered'/'listed'/'helped' = success.
  outcome: 'registered' | 'replaced' | 'unregistered' | 'not-found' | 'listed' | 'helped' | 'rejected'
  // The reply text actually sent to the requester (so tests assert on it without
  // re-deriving).
  reply: string
  reloaded: boolean
}

function noopLog(): void {}

// Auto content-hash id for a register without an explicit id. Deterministic
// over the trigger's semantic fields (same discipline as triggers.ts) so the
// same config always lands on the same id → re-registering is idempotent.
function autoId(role: Role, fields: unknown): string {
  const prefix = role === 'timer' ? 'time' : 'event'
  const h = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 12)
  return `${prefix}-${h}`
}

// Build the StoredTrigger to persist from a validated register command. `owner`
// is ALWAYS the requester (security invariant). `target` "self" has already been
// resolved to the requester by the caller; `fallback` "self" elements resolve
// the same way (and the RESOLVED array is what gets stored AND hashed, matching
// the loadTriggers projection — hash lockstep with triggers.ts contentHashId:
// same field order, fallback last, dropped when absent).
function toStoredTrigger(cmd: RegisterCommand, owner: string, resolvedTarget: string): StoredTrigger {
  const fallback = cmd.config.fallback?.map(f => (f === 'self' ? owner : f))
  if (cmd.role === 'timer') {
    const c = cmd.config
    const id = c.id ?? autoId('timer', { when: c.when, check: c.check, message: c.message, target: resolvedTarget, topic: c.topic, fallback })
    return {
      role: 'time',
      id,
      owner,
      target: resolvedTarget,
      when: c.when,
      ...(c.check ? { check: c.check } : {}),
      message: c.message,
      ...(c.topic ? { topic: c.topic } : {}),
      ...(fallback ? { fallback } : {}),
    }
  }
  const c = cmd.config
  const id = c.id ?? autoId('watcher', { script: c.script, target: resolvedTarget, topic: c.topic, heartbeatSec: c.heartbeatSec, fallback })
  return {
    role: 'event',
    id,
    owner,
    target: resolvedTarget,
    script: c.script,
    ...(c.heartbeatSec !== undefined ? { heartbeatSec: c.heartbeatSec } : {}),
    ...(c.topic ? { topic: c.topic } : {}),
    ...(fallback ? { fallback } : {}),
  }
}

// Reply to the requester through the transport. Best-effort: a failed reply is
// logged, never thrown (a registration that wrote the profile but could not
// confirm must not crash the reader loop). Tagged with the inbound topic when
// present so the requester can thread the OK/error back to its request.
// A successful reply is logged with its length: in the iapeer delivery log a
// confirmation and a trigger fire are indistinguishable (both caller=notifier-*,
// no kind marker), so this is the notifier-side correlation handle — match
// `reply-sent`/`sent`/`forwarded` len+ts against a delivery line to tell which
// is which.
//
// `ephemeral`: the requester is a FaaS peer that ANY delivered envelope spawns a
// fresh worker session (ADR-006). A registration reply to such a peer is
// gratuitous (it verifies success by READING STATE, not the reply) and a
// delivered reply would spawn a spurious session — so we DO NOT deliver it. The
// reply text still flows back in HandleResult (logging/tests); only the wire
// delivery is suppressed. A trace line keeps "no ack" explainable in the log.
function reply(deps: RegistrationDeps, to: string, message: string, topic: string | undefined, ephemeral: boolean): void {
  const log = deps.log ?? noopLog
  if (ephemeral) {
    log('reply-suppressed-ephemeral', { to, len: message.length })
    return
  }
  const result = deps.transport.send({ target: to, message, ...(topic ? { topic } : {}) })
  if (result.ok) log('reply-sent', { to, len: message.length })
  else log('reply-error', { to, error: result.error })
}

// Best-effort lifecycle probe (NEVER throws): is the requester an ephemeral
// (FaaS) peer? Any read failure (no registry / not registered / malformed /
// missing profile) → false, i.e. DELIVER the reply. Failing OPEN is the safe
// default: the worst case is the pre-existing behavior (a delivered ack), never
// a swallowed reply to a durable caller and never a crash.
function requesterIsEphemeral(deps: RegistrationDeps, requester: string): boolean {
  try {
    const cwd = deps.store.findCwd(requester)
    return cwd ? deps.store.isEphemeral(cwd) : false
  } catch {
    return false
  }
}

export function handleEnvelope(
  env: RegistrationEnvelope,
  role: Role,
  deps: RegistrationDeps,
): HandleResult {
  const log = deps.log ?? noopLog
  const requester = env.fromPersonality
  const topic = env.topic

  // Lifecycle gate, resolved ONCE for every reply on this envelope: when the
  // requester is an ephemeral (FaaS) peer, a delivered registration reply would
  // spawn a spurious worker session (ADR-006), so all replies below are
  // delivery-suppressed for it (the registration itself still writes state and
  // reloads the engine — only the wire ack is dropped). Non-ephemeral callers
  // keep full interactive feedback. Computed off the SENDER, so it applies
  // uniformly to the parse-error reply too — a durable caller still gets its
  // teaching error; an ephemeral one never spawns on a malformed body.
  const ephemeral = requesterIsEphemeral(deps, requester)

  const parsed = parseRegistration(role, env.message, deps.scriptProbe ? { scriptProbe: deps.scriptProbe } : {})
  if (!parsed.ok) {
    reply(deps, requester, parsed.error, topic, ephemeral)
    log('register-rejected', { requester, role })
    return { outcome: 'rejected', reply: parsed.error, reloaded: false }
  }

  // Locate the requester's cwd. A requester not in the registry cannot have a
  // profile written → teaching error (spec §Безопасность). This is the SAME
  // gate for register and unregister and list — every command mutates/reads the
  // requester's own profile, which requires knowing its cwd.
  let cwd: string | null
  try {
    cwd = deps.store.findCwd(requester)
  } catch (err) {
    // Malformed registry — surface as a teaching error rather than crash.
    const msg = `notifier-${role}: cannot read peer registry: ${err instanceof Error ? err.message : String(err)}`
    reply(deps, requester, msg, topic, ephemeral)
    log('registry-error', { requester, error: err instanceof Error ? err.message : String(err) })
    return { outcome: 'rejected', reply: msg, reloaded: false }
  }
  if (!cwd) {
    const msg =
      `notifier-${role}: requester "${requester}" is not in the peer registry — ` +
      `run IAP from that peer's cwd at least once so it is registered, then retry.\n\n${describeFormat(role)}`
    reply(deps, requester, msg, topic, ephemeral)
    log('register-unknown-requester', { requester })
    return { outcome: 'rejected', reply: msg, reloaded: false }
  }

  return dispatch(parsed.command, role, requester, cwd, topic, deps, ephemeral)
}

function dispatch(
  command: Command,
  role: Role,
  requester: string,
  cwd: string,
  topic: string | undefined,
  deps: RegistrationDeps,
  ephemeral: boolean,
): HandleResult {
  const log = deps.log ?? noopLog

  // Map the session role (timer/watcher) to the StoredTrigger.role discriminant
  // (time/event). LIST and UNREGISTER are scoped to THIS role's triggers under
  // the one-session=one-primitive model (the requester's triggers for this
  // role only): a notifier-timer session must not
  // see — or be able to delete — the requester's watcher (event) triggers, and
  // vice versa.
  const sessionRole = role === 'timer' ? 'time' : 'event'

  // The owner's triggers for THIS role only (the CLI view every reply ends with).
  const ownTriggers = (): StoredTrigger[] =>
    deps.store.list(cwd).filter(t => t.owner === requester && t.role === sessionRole)

  // help (bare "help" / "?" / {"cmd":"help"}): friendly, NOT an error — your
  // active triggers + the full registration format (describeFormat documents
  // register/unregister/list). The conversational entry point: no prior
  // knowledge of the command format needed.
  if (command.kind === 'help') {
    const msg = `${activeBlock(role, requester, ownTriggers())}\n\n${describeFormat(role)}`
    reply(deps, requester, msg, topic, ephemeral)
    log('register-help', { requester })
    return { outcome: 'helped', reply: msg, reloaded: false }
  }

  if (command.kind === 'list') {
    const triggers = ownTriggers()
    const msg = cliReply(role, requester, triggers)
    reply(deps, requester, msg, topic, ephemeral)
    log('register-list', { requester, count: triggers.length })
    return { outcome: 'listed', reply: msg, reloaded: false }
  }

  if (command.kind === 'unregister') {
    // Role-scope the unregister: a timer session deleting a watcher id (or vice
    // versa) must be a no-op (not-found), not a cross-role delete. Pre-check the
    // stored trigger's role before removing so an id that exists but belongs to
    // the other role is treated as absent (→ not-found reply).
    const existing = deps.store.list(cwd).find(t => t.owner === requester && t.id === command.id)
    if ((existing && existing.role !== sessionRole) || !deps.store.remove(cwd, command.id)) {
      const msg =
        `notifier-${role}: no trigger with id "${command.id}" in your profile (nothing removed).\n\n` +
        cliReply(role, requester, ownTriggers())
      reply(deps, requester, msg, topic, ephemeral)
      log('unregister-not-found', { requester, id: command.id, ...(existing ? { otherRole: existing.role } : {}) })
      return { outcome: 'not-found', reply: msg, reloaded: false }
    }
    const reloaded = runReload(deps, log)
    const msg = `✓ unregistered ${role} trigger "${command.id}".\n\n${cliReply(role, requester, ownTriggers())}`
    reply(deps, requester, msg, topic, ephemeral)
    log('unregistered', { requester, id: command.id })
    return { outcome: 'unregistered', reply: msg, reloaded }
  }

  // register: target "self" → requester. owner is ALWAYS the requester.
  const resolvedTarget = command.config.target === 'self' ? requester : command.config.target
  const stored = toStoredTrigger(command, requester, resolvedTarget)
  const outcome = deps.store.upsert(cwd, stored) // 'added' | 'replaced'
  const reloaded = runReload(deps, log)
  const verb = outcome === 'replaced' ? 'replaced' : 'registered'
  // role-aware liveness clause: timers fire on a schedule, watchers stream now.
  // On a same-id replace, say explicitly that the replace reached the LIVE
  // engine (durable + live both updated — trigger-replace-live-state contract):
  // the scheduler re-arms a changed `when` / retargets in place; the supervisor
  // stops the old script and streams with the new config.
  const live =
    outcome === 'replaced'
      ? role === 'timer'
        ? 'Replace applied live — it fires on the new config, no restart needed.'
        : 'Replace applied live — old script stopped, new config streaming now, no restart needed.'
      : role === 'timer'
        ? 'It fires on schedule — no restart needed.'
        : 'It is streaming now — no restart needed.'
  const header =
    `✓ ${verb} ${role} trigger "${stored.id}" → "${resolvedTarget}"` +
    (stored.topic ? ` (topic "${stored.topic}")` : '') +
    `. ${live}`
  const msg = `${header}\n\n${cliReply(role, requester, ownTriggers())}`
  reply(deps, requester, msg, topic, ephemeral)
  log(outcome === 'replaced' ? 'register-replaced' : 'registered', {
    requester,
    id: stored.id,
    role: stored.role,
    target: resolvedTarget,
  })
  return { outcome: outcome === 'replaced' ? 'replaced' : 'registered', reply: msg, reloaded }
}

function runReload(deps: RegistrationDeps, log: (evt: string, fields?: Record<string, unknown>) => void): boolean {
  if (!deps.reloadCb) return false
  try {
    deps.reloadCb()
    return true
  } catch (err) {
    // A reload failure must not corrupt the registration outcome — the profile
    // is already written and will be picked up on the next reload / restart.
    log('reload-error', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

// ── CLI-like reply rendering ─────────────────────────────────────────────────
// A notifier reply is a self-contained "screen": the action, then the owner's
// active triggers for this role (so it always SHOWS what is live), then a one-
// line control hint (how to remove / refresh). This replaces the need to load
// the command format up front — the blurb stays about POSTING, the reply teaches
// MANAGEMENT. Owner-/role-scoping is enforced by the caller (ownTriggers).

// The control line: how to remove (with an <id> placeholder the caller fills from
// the list above) and how to refresh. Verbatim per spec.
const CONTROL_HINT = 'Remove: {"cmd":"unregister","id":"<id>"}  ·  Refresh: {"cmd":"list"}'

// One trigger → one line: `id — when|script → target (extras)`. extras = heartbeat
// (watcher) and/or topic, only when present.
function triggerLine(t: StoredTrigger): string {
  const spec = t.role === 'time' ? (t.when ?? '?') : (t.script ?? '?')
  const extras: string[] = []
  if (t.role === 'event' && t.heartbeatSec !== undefined) extras.push(`heartbeat ${t.heartbeatSec}s`)
  if (t.fallback && t.fallback.length > 0) extras.push(`fallback ${t.fallback.join('→')}`)
  if (t.topic) extras.push(`topic ${t.topic}`)
  const tail = extras.length > 0 ? ` (${extras.join(', ')})` : ''
  return `  • ${t.id} — ${spec} → ${t.target}${tail}`
}

// The "active triggers" section (no control line) — reused by help and the CLI
// reply. Empty → a friendly nudge to `help` rather than a bare "none".
function activeBlock(role: Role, requester: string, triggers: StoredTrigger[]): string {
  const head = `Active ${role} triggers for "${requester}"`
  if (triggers.length === 0) return `${head}: none yet. Send "help" for the registration format.`
  return `${head} (${triggers.length}):\n${triggers.map(triggerLine).join('\n')}`
}

// Full CLI reply tail: active triggers + the control line (only when there is at
// least one trigger to act on — a control line over an empty list is noise).
function cliReply(role: Role, requester: string, triggers: StoredTrigger[]): string {
  const block = activeBlock(role, requester, triggers)
  return triggers.length === 0 ? block : `${block}\n${CONTROL_HINT}`
}
