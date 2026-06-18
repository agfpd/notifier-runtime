// Runtime MANIFEST — the package-facing contract surface. The package WRITES this
// at npx-install (self-deploy); the foundation only READS it (readRuntimeManifest →
// deployRuntime). The path MUST match byte-for-byte where the foundation looks:
//   <IAPEER_ROOT or ~/.iapeer>/runtimes/notifier/runtime.json
//
// IAPEER_ROOT-aware: we re-implement the foundation's resolveGlobalRoot contract
// HERE (we cannot import from the foundation repo — it is a separate package). The
// rule is the SAME: IAPEER_ROOT env wins, else $HOME/.iapeer. The most likely first
// failure is a manifest written under the wrong root because npx did not inherit
// IAPEER_ROOT — so we always resolve it from the passed env, never hard-code ~/.iapeer.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { dirname, join } from 'path'
import pkg from '../package.json'
import { RUNTIME } from './constants.ts'
import { describeFormat } from './format.ts'

/** The notifier runtime's two FIXED-FUNCTION peers (declared-set, mode a). Both are
 *  intelligence=absent: programmatic sources, no LLM and no human — the runtime's
 *  zone default and exactly what the launch nature-gate expects (nothing to refuse).
 *  The contract froze this on `absent` (the earlier `scripted` is a legacy alias the
 *  foundation normalizes to `absent` anyway — we declare the frozen value directly). */
export const DECLARED_PEERS = ['timer', 'watcher'] as const
export type DeclaredPeer = (typeof DECLARED_PEERS)[number]

/** A self-config hook descriptor (mirror of the foundation's SelfConfigDescriptor):
 *  a bare command (PATH-resolvable / absolute) or {command, args}. We always emit the
 *  OBJECT form — a string descriptor carries no args, but the hook needs the
 *  `self-config` subcommand, and we pin the ABSOLUTE installed bin so the hook is
 *  PATH-independent (the foundation runs it with cwd=peer.cwd + namespaced env). */
export interface SelfConfigDescriptor {
  command: string
  args?: string[]
}

export interface RuntimePeerDecl {
  personality: string
  intelligence?: 'absent' | 'natural' | 'artificial'
  description?: string
  path?: string
  runtimeBin?: string
}

export interface RuntimeManifest {
  runtime: string
  /** The package version that wrote this manifest — the foundation's update-runtime
   *  version-gate compares it to npm latest (stamp == latest → already-latest, skip
   *  re-install; no stamp → gate skipped, every update pays a full idempotent
   *  re-install). Stamping is the package owner's obligation per the foundation's
   *  contract — the owner's stamp obligation closes this once shipped. */
  version?: string
  selfConfig?: string | SelfConfigDescriptor
  peers?: RuntimePeerDecl[]
}

/** Mirror of the foundation's resolveGlobalRoot: IAPEER_ROOT wins, else $HOME/.iapeer.
 *  Re-implemented (not imported) because the foundation is a separate package; kept in
 *  lockstep with its contract on purpose. */
export function resolveIapeerRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IAPEER_ROOT?.trim()
  if (override) return override
  const home = env.HOME?.trim() || homedir()
  if (!home) throw new Error('cannot resolve home directory for ~/.iapeer')
  return join(home, '.iapeer')
}

/** ~/.iapeer/runtimes/notifier/runtime.json (IAPEER_ROOT-aware). */
export function runtimeManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveIapeerRoot(env), 'runtimes', RUNTIME, 'runtime.json')
}

/** The single-line registry description per role — the blurb the foundation copies
 *  verbatim into peers-profiles.json and injects into EVERY peer's known-peers list.
 *  It is a DENSE, self-documenting registration card: a peer-client must be able to
 *  schedule a cron / wire a monitor straight from this injected text — no code read,
 *  no teaching round-trip. EN on purpose: text DECLARED by the runtime package is
 *  universal (team-peer descriptions stay RU; this is package-facing contract).
 *
 *  Length budget: the foundation caps a registry description at 450 chars (iapeer
 *  ea76e6d). Both strings stay ≤450 — the manifest.test.ts invariant enforces it, so
 *  an over-budget edit fails the suite instead of being silently truncated on deploy.
 *  Must remain ONE line (no '\n'): the known-peers list is one line per peer.
 *
 *  describeFormat (format.ts) is a SEPARATE, fuller surface — the multi-line doc the
 *  self-config hook writes into the LOCAL peer-profile and `teach()` returns on a
 *  malformed body. The blurb is now self-sufficient enough that the teaching reply is
 *  a fallback, not the primary path. */
const PEER_BLURB: Record<DeclaredPeer, string> = {
  timer:
    'Scheduler peer: sends `message` on a schedule — arrives in a NEW session: make it self-contained. send_to_peer(timer, JSON): when (cron "0 9 * * *" or "@every 30m"), message, target (peer|"self"), check? (gate: fire only if script exits 0), fallback? (escalates undelivered: there→owner→backstop), id? (none→auto; same id=replace), topic?. New here? Send "help" or any text → format + examples. {"cmd":"list"} → your triggers.',
  watcher:
    'Watcher peer: runs a long-lived script (executable); each stdout line → signal to target verbatim (the line IS the payload). send_to_peer(watcher, JSON): script, target (peer|"self"), heartbeatSec? (longer silence → restart+alert owner: hang detection), fallback? (escalates undelivered: there→owner→backstop), id? (none→auto; same id=replace), topic?. New here? Send "help" or any text → format + examples. {"cmd":"list"} → your triggers.',
}

/**
 * Build the notifier runtime manifest. `binPath` is the ABSOLUTE path the self-
 * installer placed the launcher at — pinned into the self-config descriptor so the
 * hook resolves without any PATH dependency. declared-set: timer + watcher, both
 * intelligence=absent.
 */
export function buildManifest(binPath: string): RuntimeManifest {
  return {
    runtime: RUNTIME,
    // Version stamp from package.json, resolved at build time (bun inlines the JSON
    // import into the compiled snapshot, so the copied-self fallback stamps the
    // version of the RUNNING bin — correct: a re-assert re-installs THAT version).
    version: pkg.version,
    selfConfig: { command: binPath, args: ['self-config'] },
    peers: DECLARED_PEERS.map(personality => ({
      personality,
      intelligence: 'absent' as const,
      description: PEER_BLURB[personality],
    })),
  }
}

/** Write the manifest atomically (tmp+rename) under <root>/runtimes/notifier/. mkdir
 *  -p the runtime dir first. Returns the written path. Idempotent: a repeat write
 *  produces byte-identical content (stable key order, sorted-by-construction). */
export function writeManifestAtomic(manifest: RuntimeManifest, env: NodeJS.ProcessEnv = process.env): string {
  const path = runtimeManifestPath(env)
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  renameSync(tmp, path)
  return path
}

/** Read the manifest, or null when absent. Throws on present-but-malformed JSON (it
 *  is our declared contract — a corruption should surface, not silently degrade). */
export function readManifest(env: NodeJS.ProcessEnv = process.env): RuntimeManifest | null {
  const path = runtimeManifestPath(env)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as RuntimeManifest
}

// describeFormat is re-exported so a caller (self-config) and the manifest builder
// share one source for the format doc, even though the manifest itself only carries
// the short blurb.
export { describeFormat }
