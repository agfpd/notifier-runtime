import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { NAME_RE } from './constants.ts'
import { parseWhen } from './when.ts'

// Triggers projected from a requesting peer's profile. The canonical storage
// lives in `<peer-cwd>/.iapeer/peer-profile.json` under `notifier.triggers[]`;
// the runtime is a self-heal projection across all peers (registration-by-
// message). Two roles share the array, discriminated by `role`:
//   - time  → the TIME primitive: cron/interval schedule, consumed by the
//     Scheduler when this session's personality is `timer`.
//   - event → the EVENT primitive: a long-lived watcher script whose stdout
//     lines are forwarded verbatim, consumed by the Supervisor when this
//     session's personality is `watcher`.
// `loadTriggers` returns BOTH; the CLI filters by role under the resolved
// personality (one session = one primitive).
export interface TimeTrigger {
  role: 'time'
  // Stable identity within an owner: the requester-chosen name, or an
  // auto content-hash when the profile entry omits `id`. Used as the reload diff
  // key (owner:id) by the Scheduler so a live add/remove preserves surviving
  // slots, and as the unregister handle.
  id: string
  when: string
  check?: string
  message: string
  target: string
  topic?: string
  // Escalation chain (notifier-alert-escalation): peers to receive the signal
  // when `target` stays unreachable after retries. The Escalator appends the
  // owner and the global backstop; this is only the author-declared part.
  // Normalized to an array; profile may hold a single string (hand-edited).
  fallback?: string[]
  owner: string // personality of the peer that owns this trigger
}

// An event/watcher trigger. `script` is a long-lived command; each non-empty
// stdout LINE becomes a message to `target` (verbatim; no
// prefix, provenance via `topic`). `message` is NOT required (the payload IS the
// line). `heartbeatSec` is the author-declared cadence: if no line is forwarded
// within that window the supervisor kills+restarts+alerts the owner (hang
// detection). `owner` (the script author) receives alerts on
// restart-failure / crashloop / hang.
export interface EventTrigger {
  role: 'event'
  // See TimeTrigger.id — same reload-diff-key / unregister-handle semantics.
  id: string
  script: string
  target: string
  topic?: string
  heartbeatSec?: number
  // See TimeTrigger.fallback — same escalation semantics for forwarded lines
  // and owner alerts.
  fallback?: string[]
  owner: string
}

export type Trigger = TimeTrigger | EventTrigger

export interface ParseTriggersResult {
  ok: Trigger[]
  errors: string[]
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// Auto content-hash id for a trigger entry that omits `id`. Deterministic
// over the trigger's semantic fields so the SAME config always maps to the SAME
// key — that is what makes a reload diff stable for legacy/unnamed triggers (no
// `id` in the profile) and lets re-projecting the same profile preserve slots.
// 12 hex chars of sha256 is collision-safe for the per-owner scale here.
function contentHashId(prefix: string, fields: unknown): string {
  const h = createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 12)
  return `${prefix}-${h}`
}

// Validate an optional `fallback` on a profile trigger entry: one peer name or
// an array of names; "self" resolves to the OWNER (the trigger lives in the
// owner's profile — same resolution registration.ts applies on the way in, so a
// hand-edited profile behaves identically). Returns the normalized array (or
// undefined when absent/empty) or {error}.
function resolveOptionalFallback(
  entry: any,
  label: string,
  owner: string,
): { fallback?: string[] } | { error: string } {
  if (entry.fallback === undefined) return {}
  const raw = Array.isArray(entry.fallback) ? entry.fallback : [entry.fallback]
  if (raw.length === 0) return {}
  const out: string[] = []
  for (const f of raw) {
    if (typeof f !== 'string' || f.length === 0 || (f !== 'self' && !NAME_RE.test(f))) {
      return { error: `${label}: invalid fallback ${JSON.stringify(f)} (each must be a peer name or "self")` }
    }
    out.push(f === 'self' ? owner : f)
  }
  return { fallback: out }
}

// Validate an optional `id` on a profile trigger entry. A present id must be a
// non-empty valid peer-grammar name (same NAME_RE the ecosystem uses); absent →
// undefined (the caller content-hashes). Returns {error} on a bad value.
function resolveOptionalId(entry: any, label: string): { id?: string } | { error: string } {
  if (entry.id === undefined) return {}
  const id = asString(entry.id)
  if (!id || id.length === 0) return { error: `${label}: "id" must be a non-empty string when present` }
  if (!NAME_RE.test(id)) return { error: `${label}: invalid id "${id}" (must match ${NAME_RE})` }
  return { id }
}

// Parse and validate `profile.notifier.triggers[]` for one owner. A single bad
// trigger is collected into `errors` and skipped — it never aborts the whole
// profile (one peer's typo must not silence every other trigger).
export function parseTriggersFromProfile(profile: any, owner: string): ParseTriggersResult {
  const ok: Trigger[] = []
  const errors: string[] = []

  const notifier = profile?.notifier
  const triggers = notifier?.triggers
  if (triggers === undefined) return { ok, errors }
  if (!Array.isArray(triggers)) {
    errors.push(`${owner}: notifier.triggers must be an array`)
    return { ok, errors }
  }

  triggers.forEach((entry: any, index: number) => {
    const label = `${owner}[${index}]`
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label}: trigger must be an object`)
      return
    }
    // Dispatch by the `role` discriminator. Both roles are parsed now; a
    // session later filters by role for its primitive. An unknown role is an
    // error (a typo'd role would otherwise silently disappear).
    if (entry.role === 'time') {
      parseTimeEntry(entry, label, owner, ok, errors)
    } else if (entry.role === 'event') {
      parseEventEntry(entry, label, owner, ok, errors)
    } else {
      errors.push(`${label}: unknown role "${entry.role}" (expected "time" or "event")`)
    }
  })

  return { ok, errors }
}

// Validate one `role: 'time'` entry. `when` must parse; `target` must be a valid
// peer name; `check` (if present) must be a non-empty path. A failure pushes to
// `errors` and returns without adding to `ok`.
function parseTimeEntry(
  entry: any,
  label: string,
  owner: string,
  ok: Trigger[],
  errors: string[],
): void {
  const when = asString(entry.when)
  if (!when) {
    errors.push(`${label}: missing "when"`)
    return
  }
  try {
    parseWhen(when)
  } catch (err) {
    errors.push(`${label}: invalid when "${when}": ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const target = asString(entry.target)
  if (!target) {
    errors.push(`${label}: missing "target"`)
    return
  }
  if (!NAME_RE.test(target)) {
    errors.push(`${label}: invalid target "${target}" (must match ${NAME_RE})`)
    return
  }

  const message = asString(entry.message)
  if (!message || message.length === 0) {
    errors.push(`${label}: missing non-empty "message"`)
    return
  }

  let check: string | undefined
  if (entry.check !== undefined) {
    const c = asString(entry.check)
    if (!c || c.length === 0) {
      errors.push(`${label}: "check" must be a non-empty path when present`)
      return
    }
    check = c
  }

  let topic: string | undefined
  if (entry.topic !== undefined) {
    const t = asString(entry.topic)
    if (t && t.length > 0) topic = t
  }

  const fbR = resolveOptionalFallback(entry, label, owner)
  if ('error' in fbR) {
    errors.push(fbR.error)
    return
  }
  const fallback = fbR.fallback

  const idR = resolveOptionalId(entry, label)
  if ('error' in idR) {
    errors.push(idR.error)
    return
  }
  // No id in the profile → derive a stable content-hash so the reload diff key
  // (owner:id) is well-defined for unnamed/legacy triggers too. `fallback` is
  // hashed LAST and only when present (JSON.stringify drops undefined) — legacy
  // entries without it keep their pre-0.2.0 ids. Field order mirrors
  // registration.ts autoId — the two MUST stay in lockstep.
  const id =
    idR.id ?? contentHashId('time', { when, check, message, target, topic, fallback })

  ok.push({
    role: 'time',
    id,
    when,
    ...(check ? { check } : {}),
    message,
    target,
    ...(topic ? { topic } : {}),
    ...(fallback ? { fallback } : {}),
    owner,
  })
}

// Validate one `role: 'event'` entry. `script` non-empty; `target` a valid peer
// name; `topic`/`heartbeatSec` optional (heartbeatSec must be a positive
// number). `message` is NOT required — the forwarded payload is each stdout
// line.
function parseEventEntry(
  entry: any,
  label: string,
  owner: string,
  ok: Trigger[],
  errors: string[],
): void {
  const script = asString(entry.script)
  if (!script || script.length === 0) {
    errors.push(`${label}: missing non-empty "script"`)
    return
  }

  const target = asString(entry.target)
  if (!target) {
    errors.push(`${label}: missing "target"`)
    return
  }
  if (!NAME_RE.test(target)) {
    errors.push(`${label}: invalid target "${target}" (must match ${NAME_RE})`)
    return
  }

  let topic: string | undefined
  if (entry.topic !== undefined) {
    const t = asString(entry.topic)
    if (t && t.length > 0) topic = t
  }

  let heartbeatSec: number | undefined
  if (entry.heartbeatSec !== undefined) {
    const h = entry.heartbeatSec
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) {
      errors.push(`${label}: "heartbeatSec" must be a positive number when present`)
      return
    }
    heartbeatSec = h
  }

  const fbR = resolveOptionalFallback(entry, label, owner)
  if ('error' in fbR) {
    errors.push(fbR.error)
    return
  }
  const fallback = fbR.fallback

  const idR = resolveOptionalId(entry, label)
  if ('error' in idR) {
    errors.push(idR.error)
    return
  }
  // `fallback` hashed last, only when present — see the time-entry comment.
  const id =
    idR.id ?? contentHashId('event', { script, target, topic, heartbeatSec, fallback })

  ok.push({
    role: 'event',
    id,
    script,
    target,
    ...(topic ? { topic } : {}),
    ...(heartbeatSec !== undefined ? { heartbeatSec } : {}),
    ...(fallback ? { fallback } : {}),
    owner,
  })
}

export interface LoadTriggersOptions {
  // Injectable paths for tests — production reads the real registry.
  peersIndexPath?: string
  // Resolve a peer cwd to its profile path. Defaults to <cwd>/.iapeer/peer-profile.json.
  profilePathFor?: (cwd: string) => string
  readFile?: (path: string) => string
  fileExists?: (path: string) => boolean
}

function defaultProfilePath(cwd: string): string {
  return join(cwd, '.iapeer', 'peer-profile.json')
}

// Project triggers from every registered peer's profile. Reads
// `~/.iapeer/peers-profiles.json` → for each peer.cwd reads its
// peer-profile.json → parseTriggersFromProfile. Missing/invalid files surface
// in `errors` without aborting the whole scan.
export function loadTriggers(opts: LoadTriggersOptions = {}): ParseTriggersResult {
  const peersIndexPath = opts.peersIndexPath ?? join(homedir(), '.iapeer', 'peers-profiles.json')
  const profilePathFor = opts.profilePathFor ?? defaultProfilePath
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p))

  const ok: Trigger[] = []
  const errors: string[] = []

  if (!fileExists(peersIndexPath)) {
    return { ok, errors }
  }

  let index: any
  try {
    index = JSON.parse(readFile(peersIndexPath))
  } catch (err) {
    errors.push(`${peersIndexPath} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return { ok, errors }
  }

  const peers = Array.isArray(index?.peers) ? index.peers : []
  for (const peer of peers) {
    const cwd = asString(peer?.cwd)
    const owner = asString(peer?.personality)
    if (!cwd || !owner) continue
    const profilePath = profilePathFor(cwd)
    if (!fileExists(profilePath)) continue
    let profile: any
    try {
      profile = JSON.parse(readFile(profilePath))
    } catch (err) {
      errors.push(`${profilePath} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const result = parseTriggersFromProfile(profile, owner)
    ok.push(...result.ok)
    errors.push(...result.errors)
  }

  return { ok, errors }
}
