// Per-peer self-config hook — the shared contract BOTH provision modes call. The
// foundation invokes
// it per peer as `<command> self-config` with cwd = the peer's cwd and the peer context
// in NAMESPACED env (IAPEER_PEER_PERSONALITY/_CWD/_RUNTIME/_INTELLIGENCE + IAPEER_ROOT —
// NOT the bare PEER_* the identity gate keys on). Our job is the runtime-specific state
// — here: writing the ≤450 single-line registry blurb (PEER_BLURB) into the local peer
// profile `description` so the peer is self-documenting on disk.
//
// WHY THE BLURB, NOT describeFormat: the foundation PROJECTS this local
// `description` into the shared registry (peers-profiles.json), clamping it to 450
// chars. describeFormat is a MULTI-LINE ~1KB teaching doc — projecting it truncated the
// registry entry mid-word ("• message arrives …"). PEER_BLURB is the one string BOTH
// the manifest and this hook emit (see manifest.ts), so the projected registry entry is
// always the complete ≤450 blurb. describeFormat stays the LIVE help/teach reply
// (registration.ts) — the blurb tells the reader to send "help" to get it.
//
// IDEMPOTENT ("ensure runtime state for peer X"): read-merge-write, byte-stable. exit 0
// = configured, ≠0 = failed (the foundation is fail-closed — a failed hook means the
// plist is written but NOT bootstrapped).
//
// IDENTITY IS THE FOUNDATION'S DOMAIN: the hook PRESERVES every field the foundation
// provisioned (especially `intelligence`=absent and `personality`) — it only sets the
// rich `description`. Identity is the foundation's to provision; the hook must not clobber it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { type Role } from './format.ts'
import { resolvePersonality } from './identity.ts'
import { PEER_BLURB } from './manifest.ts'

export interface SelfConfigOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface SelfConfigOutcome {
  role: Role
  personality: string
  profilePath: string
}

/** Resolve the peer's role for this hook invocation. The contract env is the
 *  NAMESPACED IAPEER_PEER_PERSONALITY; we prefer it, then fall back through the bare
 *  PEER_PERSONALITY → cwd profile → 'timer' chain (resolvePersonality) for robustness
 *  (a manual `notifier-runtime self-config` run in a provisioned cwd still resolves). */
export function resolveRole(env: NodeJS.ProcessEnv, cwd: string): { role: Role; personality: string } {
  const namespaced = env.IAPEER_PEER_PERSONALITY?.trim()
  const personality = namespaced && namespaced.length > 0 ? namespaced : resolvePersonality({ env, cwd })
  return { role: personality === 'watcher' ? 'watcher' : 'timer', personality }
}

/**
 * Configure runtime state for ONE peer (idempotent). Writes the role's ≤450 single-line
 * registry blurb (PEER_BLURB) into <cwd>/.iapeer/peer-profile.json `description`,
 * preserving every other field. That `description` is the field the foundation projects
 * (clamped to 450) into the shared registry, so it must be the blurb, not the multi-line
 * describeFormat doc. Atomic tmp+rename. Returns what was configured.
 */
export function runSelfConfig(opts: SelfConfigOptions = {}): SelfConfigOutcome {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const { role, personality } = resolveRole(env, cwd)
  const profilePath = join(cwd, '.iapeer', 'peer-profile.json')

  let profile: Record<string, unknown> = {}
  if (existsSync(profilePath)) {
    try {
      const raw = JSON.parse(readFileSync(profilePath, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) profile = raw as Record<string, unknown>
    } catch {
      // Malformed profile → write a clean one (nothing to preserve).
    }
  }

  // Merge: set the ≤450 single-line registry blurb; PRESERVE everything else
  // (intelligence, personality, and any foundation/unknown fields). Identity stays the
  // foundation's domain. This is the field the foundation projects into the registry.
  const merged: Record<string, unknown> = { ...profile, description: PEER_BLURB[role] }

  mkdirSync(dirname(profilePath), { recursive: true, mode: 0o700 })
  const tmp = `${profilePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, profilePath)

  return { role, personality, profilePath }
}
