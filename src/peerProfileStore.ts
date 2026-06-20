import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join } from 'path'

// ── Peer-profile trigger store ──────────────────────────────────────────────
//
// The canonical home of a peer's triggers is `<peer-cwd>/.iapeer/peer-
// profile.json` under `notifier.triggers[]` — the same array loadTriggers
// projects from. Registration-by-message mutates THIS array, and only ever in
// the REQUESTER's own profile (security invariant: a peer cannot write triggers
// into another peer's profile — see registration.ts).
//
// This module:
//   1. locates a peer's cwd via the registry (~/.iapeer/peers-profiles.json),
//   2. read-merge-writes notifier.triggers[] atomically (tmp+rename), PRESERVING
//      every unknown top-level field of the profile (description, intelligence,
//      interfaces, …) — exactly the round-trip discipline telegram-runtime's
//      writePeerProfile uses. Losing unknown fields would silently corrupt a
//      profile owned by another contract.
//   3. supports add / replace-by-id / remove-by-id / list on the triggers array.
//
// All paths are injectable so tests run against scratch dirs / in-memory maps —
// NEVER a real live peer profile (HARD RULE).

// A stored trigger as it lives in notifier.triggers[]. Mirrors the parsed
// Trigger shape (triggers.ts) but is `Record`-ish here because the store is a
// generic merge layer — it does not re-validate, it persists what registration
// hands it. `id` and `owner` are always present once written by registration.
export type StoredTrigger = {
  role: 'time' | 'event'
  id: string
  owner: string
  target: string
  topic?: string
  // Escalation chain (both roles) — declared fallback peers, "self" already
  // resolved to the owner by registration.
  fallback?: string[]
  // time
  when?: string
  check?: string
  message?: string
  // event
  script?: string
  heartbeatSec?: number
}

export interface PeerProfileStoreDeps {
  // Path to the registry index. Default: ~/.iapeer/peers-profiles.json.
  peersIndexPath?: string
  // Resolve a peer cwd → its profile path. Default: <cwd>/.iapeer/peer-profile.json.
  profilePathFor?: (cwd: string) => string
  readFile?: (path: string) => string
  fileExists?: (path: string) => boolean
  // Atomic write. Default: tmp + rename. Injectable so tests capture writes
  // without touching disk.
  writeFile?: (path: string, content: string) => void
}

class PeerProfileStoreError extends Error {}

function defaultProfilePath(cwd: string): string {
  return join(cwd, '.iapeer', 'peer-profile.json')
}

function defaultPeersIndexPath(): string {
  return join(homedir(), '.iapeer', 'peers-profiles.json')
}

// Atomic write: tmp + rename, so a reader never observes a half-written profile
// (and a crash mid-write leaves the old file intact). Mirrors telegram-runtime's
// writeJsonAtomic.
function defaultWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

export class PeerProfileStore {
  private peersIndexPath: string
  private profilePathFor: (cwd: string) => string
  private readFile: (path: string) => string
  private fileExists: (path: string) => boolean
  private writeFile: (path: string, content: string) => void

  constructor(deps: PeerProfileStoreDeps = {}) {
    this.peersIndexPath = deps.peersIndexPath ?? defaultPeersIndexPath()
    this.profilePathFor = deps.profilePathFor ?? defaultProfilePath
    this.readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
    this.fileExists = deps.fileExists ?? ((p: string) => existsSync(p))
    this.writeFile = deps.writeFile ?? defaultWriteFile
  }

  // Resolve a personality → its registered cwd via the registry. Returns null
  // when the peer is not in the index (requester unknown → caller emits a
  // teaching error, per spec §Безопасность). A malformed registry throws.
  findCwd(personality: string): string | null {
    if (!this.fileExists(this.peersIndexPath)) return null
    let index: unknown
    try {
      index = JSON.parse(this.readFile(this.peersIndexPath))
    } catch (err) {
      throw new PeerProfileStoreError(
        `${this.peersIndexPath} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const peers = Array.isArray((index as { peers?: unknown })?.peers)
      ? (index as { peers: unknown[] }).peers
      : []
    for (const peer of peers) {
      const p = peer as { personality?: unknown; cwd?: unknown }
      if (typeof p?.personality === 'string' && p.personality === personality && typeof p.cwd === 'string') {
        return p.cwd
      }
    }
    return null
  }

  // True iff the peer at `cwd` is an EPHEMERAL (FaaS) peer — `wake_policy:
  // "ephemeral"` in its peer-profile. Per ADR-006 ANY delivered envelope spawns
  // such a peer a fresh worker session, so registration.ts SUPPRESSES delivery
  // of registration replies to it: an ephemeral registrant verifies success by
  // READING STATE (its durable trigger), never by the reply, and a delivered ack
  // would spawn a spurious session. Missing profile / field / non-string → false
  // (an ordinary durable peer). A malformed profile JSON throws, same as every
  // other profile read here (callers that must not throw guard it).
  isEphemeral(cwd: string): boolean {
    const { profile } = this.readProfile(cwd)
    return profile.wake_policy === 'ephemeral'
  }

  // Read the current notifier.triggers[] for the peer at `cwd`. A missing
  // profile / missing notifier block → empty array. A malformed profile throws.
  list(cwd: string): StoredTrigger[] {
    const { triggers } = this.readProfile(cwd)
    return triggers
  }

  // Read the whole profile object + the current triggers array. The full object
  // is returned so a write can MERGE over it, preserving every unknown field.
  private readProfile(cwd: string): { profile: Record<string, unknown>; triggers: StoredTrigger[] } {
    const path = this.profilePathFor(cwd)
    if (!this.fileExists(path)) return { profile: {}, triggers: [] }
    let raw: unknown
    try {
      raw = JSON.parse(this.readFile(path))
    } catch (err) {
      throw new PeerProfileStoreError(
        `${path} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { profile: {}, triggers: [] }
    }
    const profile = raw as Record<string, unknown>
    const notifier = profile.notifier
    const arr =
      notifier && typeof notifier === 'object' && Array.isArray((notifier as { triggers?: unknown }).triggers)
        ? ((notifier as { triggers: unknown[] }).triggers as StoredTrigger[])
        : []
    return { profile, triggers: arr }
  }

  // Persist a new triggers array into the peer's profile, MERGING over the
  // existing profile so unknown top-level fields survive. Also preserves unknown
  // keys INSIDE the `notifier` block (only `triggers` is rewritten). Atomic.
  private writeTriggers(cwd: string, triggers: StoredTrigger[], profile: Record<string, unknown>): void {
    const existingNotifier =
      profile.notifier && typeof profile.notifier === 'object' && !Array.isArray(profile.notifier)
        ? (profile.notifier as Record<string, unknown>)
        : {}
    const merged: Record<string, unknown> = {
      ...profile,
      notifier: { ...existingNotifier, triggers },
    }
    this.writeFile(this.profilePathFor(cwd), `${JSON.stringify(merged, null, 2)}\n`)
  }

  // Add or REPLACE a trigger by id (re-registering the same id
  // is a replace, not a duplicate). The new entry is matched on id alone within
  // the owner's array (the array is single-owner — it lives in the owner's
  // profile). Returns 'added' | 'replaced' so the caller can report which.
  upsert(cwd: string, trigger: StoredTrigger): 'added' | 'replaced' {
    const { profile, triggers } = this.readProfile(cwd)
    const idx = triggers.findIndex(t => t.id === trigger.id)
    let outcome: 'added' | 'replaced'
    if (idx >= 0) {
      triggers[idx] = trigger
      outcome = 'replaced'
    } else {
      triggers.push(trigger)
      outcome = 'added'
    }
    this.writeTriggers(cwd, triggers, profile)
    return outcome
  }

  // Remove a trigger by id. Returns true if one was removed, false if no trigger
  // with that id existed (caller turns false into a teaching/info reply).
  remove(cwd: string, id: string): boolean {
    const { profile, triggers } = this.readProfile(cwd)
    const next = triggers.filter(t => t.id !== id)
    if (next.length === triggers.length) return false
    this.writeTriggers(cwd, next, profile)
    return true
  }
}
