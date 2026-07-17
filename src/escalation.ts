import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  DEFAULT_FALLBACK_TARGET,
  ESCALATION_ATTEMPTS_PER_LINK,
  ESCALATION_RETRY_DELAY_MS,
} from './constants.ts'
import type { AsyncTransport, SendResult } from './transport.ts'

// ── Delivery escalation ─────────────────────────────────────────────────────
//
// A watcher-detected alarm once died silently when delivery to its target
// failed (the target's wake never became ready) and the alarm collapsed into a
// single send-error log line. The notifier is the alarm circuit of the farm —
// a send-error must never be terminal.
//
// Contract:
//   • Every outgoing signal (timer fire, watcher line forward, owner alert)
//     goes through the Escalator, never through a bare transport.send.
//   • Chain: target ×R → per-trigger fallback(s) ×R → trigger owner ×R →
//     global backstop ×R (env NOTIFIER_FALLBACK_TARGET). R attempts per
//     link with a delay between attempts.
//   • Write-ahead spool: the signal is persisted to disk BEFORE the first
//     attempt and removed ONLY on a successful delivery to anyone in the
//     chain. A crash/restart mid-chain re-drains the spool on start. Silent
//     loss is impossible by construction: a signal is either delivered, or it
//     sits in the spool as a dead-letter (status "lost") behind a loud
//     `delivery-lost` log event.
//   • Semantics: "delivered to someone alive" beats "delivered exactly to
//     target"; at-least-once (a duplicate alert is better than a lost one —
//     a re-drain after a crash may re-send an already-delivered signal).
//   • Storm-proofing (2026-07-17 escalation-storm incident): a byte-identical
//     copy of a signal that is still IN FLIGHT carries no new information —
//     it is coalesced onto the in-flight entry (counter, no second chain) both
//     at deliver() time and when merging duplicates on the re-drain. And a
//     flood breaker (supervisor) may cancelPending() a watcher's queued
//     forwards mid-storm: cancelled entries become durable dead-letters
//     (status "flooded") behind a loud log — never a silent drop.
//   • Delivery is async (AsyncTransport: spawn + hard timeout): retries and
//     wakes never block the scheduler tick or the watcher forward path, and a
//     hung `iapeer send` can no longer wedge the notifier (the old spawnSync
//     path had no timeout at all).

export type SignalKind = 'fire' | 'forward' | 'alert'

// What an engine (scheduler/supervisor) hands the escalator per signal.
export interface EscalationJob {
  kind: SignalKind
  target: string
  message: string
  topic?: string
  // Per-trigger declared fallback chain (triggers.ts `fallback`), already
  // normalized to an array. The owner and the global backstop are appended by
  // the escalator itself.
  fallbacks?: string[]
  owner: string
  // Logging context merged into the success event so the 0.1.3 log-attribution
  // shape is preserved: fire → {owner, when, reason}, forward → {id}.
  meta?: Record<string, unknown>
}

export interface AttemptRecord {
  target: string
  at: string
  error: string
}

// The durable form of one in-flight signal — exactly what the spool persists.
export interface SpoolEntry {
  v: 1
  id: string
  createdAt: string
  kind: SignalKind
  target: string
  message: string
  topic?: string
  owner: string
  chain: string[]
  attempts: AttemptRecord[]
  // pending — in flight; lost — chain exhausted (dead-letter); flooded —
  // cancelled by the flood breaker mid-storm (dead-letter, never re-drained).
  status: 'pending' | 'lost' | 'flooded'
  // How many byte-identical duplicates were coalesced onto this entry while it
  // was in flight (deliver-time dedup + re-drain merge). Absent = 0.
  coalesced?: number
  meta?: Record<string, unknown>
}

// ── Spool ────────────────────────────────────────────────────────────────────

export interface Spool {
  put(entry: SpoolEntry): void
  update(entry: SpoolEntry): void
  remove(id: string): void
  // Entries to re-drain on start: status "pending" only. Dead-letters
  // (status "lost") stay on disk for the operator but are never re-sent.
  loadPending(): SpoolEntry[]
}

type Log = (evt: string, fields?: Record<string, unknown>) => void

// One file per signal: <dir>/<id>.json. Atomic tmp+rename (same discipline as
// peerProfileStore) so a reader/crash never observes a half-written entry.
export function makeFileSpool(dir: string, log?: Log): Spool {
  const pathFor = (id: string) => join(dir, `${id}.json`)
  const writeAtomic = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, path)
  }
  return {
    put(entry: SpoolEntry): void {
      writeAtomic(pathFor(entry.id), `${JSON.stringify(entry, null, 2)}\n`)
    },
    update(entry: SpoolEntry): void {
      writeAtomic(pathFor(entry.id), `${JSON.stringify(entry, null, 2)}\n`)
    },
    remove(id: string): void {
      try {
        unlinkSync(pathFor(id))
      } catch {
        // Already gone — fine (remove is called exactly once per success, but a
        // re-drained duplicate may race its twin).
      }
    },
    loadPending(): SpoolEntry[] {
      let files: string[]
      try {
        files = readdirSync(dir)
      } catch {
        return [] // No spool dir yet → nothing pending.
      }
      const out: SpoolEntry[] = []
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        try {
          const entry = JSON.parse(readFileSync(join(dir, f), 'utf8')) as SpoolEntry
          if (
            entry &&
            entry.status === 'pending' &&
            typeof entry.target === 'string' &&
            typeof entry.message === 'string' &&
            Array.isArray(entry.chain) &&
            Array.isArray(entry.attempts)
          ) {
            out.push(entry)
          }
        } catch (err) {
          // A corrupt entry must not abort the drain of the healthy ones.
          log?.('spool-read-error', { file: f, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return out
    },
  }
}

// Test double: in-memory map with cloned entries (so test assertions see the
// persisted snapshot, not a live mutable reference).
export class InMemorySpool implements Spool {
  entries = new Map<string, SpoolEntry>()
  put(entry: SpoolEntry): void {
    this.entries.set(entry.id, structuredClone(entry))
  }
  update(entry: SpoolEntry): void {
    this.entries.set(entry.id, structuredClone(entry))
  }
  remove(id: string): void {
    this.entries.delete(id)
  }
  loadPending(): SpoolEntry[] {
    return [...this.entries.values()].filter(e => e.status === 'pending').map(e => structuredClone(e))
  }
}

// ── Escalator ────────────────────────────────────────────────────────────────

interface EscalatorDeps {
  transport: AsyncTransport
  spool: Spool
  log: Log
  // Injectable timer (same seam as SupervisorDeps.setTimer): production is
  // setTimeout/clearTimeout, tests fire it deterministically.
  setTimer: (ms: number, cb: () => void) => () => void
  now: () => Date
  // Spool-entry id source — injectable for deterministic tests.
  makeId?: () => string
}

interface EscalatorOpts {
  attemptsPerLink?: number
  retryDelayMs?: number
  backstop?: string
}

// The full chain for one job: target → declared fallbacks → owner → backstop,
// order-preserving dedup (an alert's target IS the owner — the dedup collapses
// it; a fallback that repeats the target adds nothing).
export function buildChain(job: EscalationJob, backstop: string): string[] {
  const chain: string[] = []
  const push = (t: string | undefined) => {
    if (t && !chain.includes(t)) chain.push(t)
  }
  push(job.target)
  for (const f of job.fallbacks ?? []) push(f)
  push(job.owner)
  push(backstop)
  return chain
}

// Success event per kind — keeps the 0.1.3 log-attribution contract: a timer
// fire logs `sent`, a watcher forward logs `forwarded` (both with len). Owner
// alerts gain `alert-sent` (previously success was unlogged).
function successEvt(kind: SignalKind): string {
  return kind === 'fire' ? 'sent' : kind === 'forward' ? 'forwarded' : 'alert-sent'
}

// Wrap the original message for a fallback recipient: who it was for, why it
// escalated (attempt summary), and the verbatim original. The recipient can
// act on it or relay it — that is the whole point of the chain.
export function wrapForFallback(entry: SpoolEntry, linkIndex: number): string {
  const summary: { target: string; n: number; lastError: string }[] = []
  for (const a of entry.attempts) {
    const last = summary[summary.length - 1]
    if (last && last.target === a.target) {
      last.n++
      last.lastError = a.error
    } else {
      summary.push({ target: a.target, n: 1, lastError: a.error })
    }
  }
  const attempted = summary.map(s => `${s.target}×${s.n} (last error: ${s.lastError})`).join('; ')
  const dup = entry.coalesced
    ? `\n${entry.coalesced} byte-identical duplicate signal(s) were coalesced onto this one while it was queued.`
    : ''
  return (
    `notifier-escalation: signal for "${entry.target}" UNDELIVERED — you are fallback ` +
    `link ${linkIndex + 1}/${entry.chain.length} (kind=${entry.kind}, owner=${entry.owner}` +
    `${entry.topic ? `, topic=${entry.topic}` : ''}).\n` +
    `Failed attempts: ${attempted}.${dup}\n` +
    `Act on it or relay it to "${entry.target}". Original signal verbatim:\n` +
    `---\n${entry.message}`
  )
}

// Identity of a signal for coalescing: everything that shapes what the
// recipient would actually receive. Two jobs with the same key are
// indistinguishable on the wire — a second in-flight copy adds nothing.
// The message is hashed (storm lines can be long); kind/owner/trigger-id are
// included so signals of different triggers never merge (log attribution).
function dedupKey(
  kind: SignalKind,
  owner: string,
  metaId: unknown,
  target: string,
  topic: string | undefined,
  message: string,
): string {
  const hash = createHash('sha256').update(message).digest('hex')
  return `${kind}|${owner}|${typeof metaId === 'string' ? metaId : ''}|${target}|${topic ?? ''}|${hash}`
}

function entryKey(entry: SpoolEntry): string {
  return dedupKey(entry.kind, entry.owner, entry.meta?.id, entry.target, entry.topic, entry.message)
}

// One in-flight signal: the live entry (shared with runChain, which mutates
// attempts/coalesced), the dedup key, the cancel latch, and the chain promise
// (returned to a coalesced deliver() so callers can await the real outcome).
interface InflightRec {
  entry: SpoolEntry
  key: string
  cancelled: boolean
  promise: Promise<void>
}

// Per-target delivery lane: at most ONE in-flight `iapeer send` per recipient.
// Preserves per-recipient ordering of watcher lines and prevents a burst from
// stampeding a dead peer with concurrent wake attempts. Different recipients
// proceed in parallel.
class Lanes {
  private tails = new Map<string, Promise<unknown>>()
  run<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(target) ?? Promise.resolve()
    const p = tail.then(fn, fn)
    this.tails.set(
      target,
      p.then(
        () => {},
        () => {},
      ),
    )
    return p
  }
}

export class Escalator {
  private readonly deps: EscalatorDeps
  private readonly attemptsPerLink: number
  private readonly retryDelayMs: number
  private readonly backstop: string
  private readonly lanes = new Lanes()
  private readonly makeId: () => string
  // In-flight index by dedup key — the coalescing seam. An entry lives here
  // from deliver()/start() until its chain settles (delivered/lost/cancelled).
  private readonly inflight = new Map<string, InflightRec>()

  constructor(deps: EscalatorDeps, opts: EscalatorOpts = {}) {
    this.deps = deps
    this.attemptsPerLink = opts.attemptsPerLink ?? ESCALATION_ATTEMPTS_PER_LINK
    this.retryDelayMs = opts.retryDelayMs ?? ESCALATION_RETRY_DELAY_MS
    this.backstop = opts.backstop ?? DEFAULT_FALLBACK_TARGET
    this.makeId =
      deps.makeId ?? (() => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  }

  // Re-drain: re-run the chain for every pending spool entry (signals that were
  // in flight when the previous process died). Attempt history is preserved and
  // appended to. Call once at process start, before the engines begin firing.
  //
  // Byte-identical duplicates among the pending set are MERGED before the
  // chains launch (first entry runs, the rest fold into its coalesced counter
  // and leave the spool) — without this, a restart right after a storm would
  // re-detonate the whole storm from disk.
  start(): void {
    const pending = this.deps.spool.loadPending()
    for (const entry of pending) {
      const key = entryKey(entry)
      const existing = this.inflight.get(key)
      if (existing) {
        existing.entry.coalesced = (existing.entry.coalesced ?? 0) + 1 + (entry.coalesced ?? 0)
        this.deps.spool.update(existing.entry)
        this.deps.spool.remove(entry.id)
        this.deps.log('spool-merge', {
          sig: entry.id,
          into: existing.entry.id,
          kind: entry.kind,
          intendedTarget: entry.target,
          coalesced: existing.entry.coalesced,
        })
        continue
      }
      this.deps.log('spool-redrain', {
        sig: entry.id,
        kind: entry.kind,
        intendedTarget: entry.target,
        attemptsSoFar: entry.attempts.length,
      })
      this.launch(entry, key)
    }
  }

  // Persist (write-ahead) then run the chain. The returned promise settles when
  // the chain settles (delivered or lost) — production callers fire-and-forget
  // (`void escalator.deliver(...)`), tests await it. NEVER rejects: every
  // failure path is a log event + spool state, not an exception.
  //
  // Coalescing: a job byte-identical to a signal still in flight starts NO new
  // chain — it bumps the in-flight entry's counter and returns that entry's
  // chain promise. At-least-once holds: the one in-flight copy either reaches
  // someone in the chain or dead-letters loudly; a second identical copy could
  // add nothing but noise (the 2026-07-17 storm hammered the fallback with
  // hundreds of copies of one line).
  deliver(job: EscalationJob): Promise<void> {
    const key = dedupKey(job.kind, job.owner, job.meta?.id, job.target, job.topic, job.message)
    const existing = this.inflight.get(key)
    if (existing && !existing.cancelled) {
      existing.entry.coalesced = (existing.entry.coalesced ?? 0) + 1
      this.deps.spool.update(existing.entry)
      this.deps.log('signal-coalesced', {
        sig: existing.entry.id,
        kind: job.kind,
        intendedTarget: job.target,
        coalesced: existing.entry.coalesced,
      })
      return existing.promise
    }
    const entry: SpoolEntry = {
      v: 1,
      id: this.makeId(),
      createdAt: this.deps.now().toISOString(),
      kind: job.kind,
      target: job.target,
      message: job.message,
      ...(job.topic ? { topic: job.topic } : {}),
      owner: job.owner,
      chain: buildChain(job, this.backstop),
      attempts: [],
      status: 'pending',
      ...(job.meta ? { meta: job.meta } : {}),
    }
    this.deps.spool.put(entry)
    return this.launch(entry, key)
  }

  // Cancel every in-flight signal matching `pred` (flood-breaker seam — the
  // supervisor cancels a flooding watcher's queued forwards). Cancelled entries
  // become durable dead-letters (status "flooded"): the file stays on disk, is
  // never re-drained, and the count is returned for the breaker's owner alert.
  // A signal whose send is already on the wire may still land — at-least-once
  // semantics tolerate that; the latch stops every subsequent attempt.
  cancelPending(pred: (entry: Readonly<SpoolEntry>) => boolean): number {
    let count = 0
    for (const rec of this.inflight.values()) {
      if (rec.cancelled || rec.entry.status !== 'pending') continue
      if (!pred(rec.entry)) continue
      rec.cancelled = true
      rec.entry.status = 'flooded'
      this.deps.spool.update(rec.entry)
      count++
    }
    if (count > 0) this.deps.log('escalation-cancelled', { count })
    return count
  }

  // Register the in-flight record and start the chain. The record leaves the
  // index when the chain settles — however it settles.
  private launch(entry: SpoolEntry, key: string): Promise<void> {
    const rec: InflightRec = { entry, key, cancelled: false, promise: Promise.resolve() }
    rec.promise = this.runChain(rec).finally(() => {
      if (this.inflight.get(key) === rec) this.inflight.delete(key)
    })
    this.inflight.set(key, rec)
    return rec.promise
  }

  private async runChain(rec: InflightRec): Promise<void> {
    const entry = rec.entry
    try {
      for (let li = 0; li < entry.chain.length; li++) {
        const to = entry.chain[li]!
        const isPrimary = li === 0
        const message = isPrimary ? entry.message : wrapForFallback(entry, li)
        for (let attempt = 1; attempt <= this.attemptsPerLink; attempt++) {
          // Flood-breaker latch: checked before every attempt (and implicitly
          // after every sleep/lane wait). The entry is already a "flooded"
          // dead-letter — just stop the chain.
          if (rec.cancelled) return
          this.deps.log('deliver-attempt', {
            sig: entry.id,
            kind: entry.kind,
            to,
            link: li + 1,
            attempt,
            ...(isPrimary ? {} : { intendedTarget: entry.target }),
          })
          const result = await this.lanes.run(to, () =>
            // The cancel latch may flip while this send waits in the lane queue —
            // short-circuit instead of firing a doomed/unwanted attempt.
            rec.cancelled
              ? Promise.resolve<SendResult>({ ok: false, error: 'cancelled by flood breaker' })
              : this.deps.transport.send({
                  target: to,
                  message,
                  ...(entry.topic ? { topic: entry.topic } : {}),
                }),
          )
          if (rec.cancelled) return
          if (result.ok) {
            // len = correlation handle against the iapeer delivery log (0.1.3
            // attribution contract) — the length of what was ACTUALLY sent
            // (wrapped for a fallback link).
            this.deps.log(successEvt(entry.kind), {
              ...(entry.meta ?? {}),
              target: to,
              len: message.length,
              sig: entry.id,
              ...(entry.coalesced ? { coalesced: entry.coalesced } : {}),
              ...(isPrimary ? {} : { via: 'fallback', intendedTarget: entry.target, link: li + 1 }),
            })
            this.deps.spool.remove(entry.id)
            return
          }
          entry.attempts.push({
            target: to,
            at: this.deps.now().toISOString(),
            error: result.error ?? 'unknown error',
          })
          // Persist progress after EVERY failed attempt — a crash mid-chain
          // re-drains with full history.
          this.deps.spool.update(entry)
          this.deps.log('deliver-failed', {
            sig: entry.id,
            kind: entry.kind,
            to,
            link: li + 1,
            attempt,
            error: result.error,
          })
          if (attempt < this.attemptsPerLink) await this.sleep(this.retryDelayMs)
        }
      }
      // Whole chain exhausted → dead-letter. The entry STAYS on disk (status
      // "lost") — the loud log line plus the durable file are the loud record;
      // nothing is ever silently dropped.
      entry.status = 'lost'
      this.deps.spool.update(entry)
      this.deps.log('delivery-lost', {
        sig: entry.id,
        kind: entry.kind,
        intendedTarget: entry.target,
        owner: entry.owner,
        chain: entry.chain.join('→'),
        attempts: entry.attempts.length,
      })
    } catch (err) {
      // Defensive: a bug in the chain must not vanish a signal. The entry stays
      // "pending" in the spool → re-drained on next start.
      this.deps.log('escalation-error', {
        sig: entry.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.deps.setTimer(ms, resolve)
    })
  }
}
