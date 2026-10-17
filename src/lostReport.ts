import type { Spool, SpoolEntry } from './escalation.ts'
import type { AsyncTransport } from './transport.ts'

// ── Lost-digest: a dead-letter must SURFACE, not just exist ─────────────────
//
// Incident 26.08–17.10.2026: 2335 timer fires became "lost" dead-letters (the
// whole chain, backstop included, failed to wake). The escalator did its job by
// the letter — loud `delivery-lost` log + durable file — but a log line and a
// file nobody reads are not a signal: the loss stayed invisible for 7 weeks.
//
// The LostReporter closes that hole. Periodically it collects every "lost"
// spool entry not yet surfaced (`reportedAt` absent), folds them into ONE
// digest grouped by trigger, and sends it to a RELAY — a telegram-faced agent
// that can tell the human (the notifier itself has no telegram face and cannot
// reach a human directly). Contract:
//   • durable: entries are marked `reportedAt` ONLY after a relay accepted the
//     digest; until then every tick retries — a fleet-wide wake outage delays
//     the digest, never drops it;
//   • storm-proof: one digest per tick at most (counts, not copies), one
//     attempt per relay per tick, relays capped — no amplification;
//   • not through the Escalator: a digest that itself dead-lettered would feed
//     the very loop it reports on. Its durable state is the unreported set.

export interface LostReporterDeps {
  spool: Spool
  transport: AsyncTransport
  // Relays in priority order, resolved per tick (registry may change).
  relays: () => string[]
  log: (evt: string, fields?: Record<string, unknown>) => void
  now: () => Date
  // notifier-<personality> — named in the digest so the relay knows the source.
  identity: string
  spoolDir: string
}

export const LOST_DIGEST_MAX_RELAYS = 3
const MAX_GROUPS = 15

interface Group {
  kind: string
  owner: string
  trigger: string
  target: string
  topic?: string
  chain: string
  count: number
  first: string
  last: string
  lastError: string
}

function triggerLabel(e: SpoolEntry): string {
  const id = e.meta?.id
  return typeof id === 'string' ? id : '?'
}

export function buildLostDigest(entries: SpoolEntry[], identity: string, spoolDir: string): string {
  const groups = new Map<string, Group>()
  for (const e of entries) {
    const trigger = triggerLabel(e)
    const key = `${e.kind}|${e.owner}|${trigger}|${e.target}|${e.topic ?? ''}`
    const lastAttempt = e.attempts[e.attempts.length - 1]
    const n = 1 + (e.coalesced ?? 0)
    const g = groups.get(key)
    if (!g) {
      groups.set(key, {
        kind: e.kind,
        owner: e.owner,
        trigger,
        target: e.target,
        ...(e.topic ? { topic: e.topic } : {}),
        chain: e.chain.join('→'),
        count: n,
        first: e.createdAt,
        last: e.createdAt,
        lastError: lastAttempt ? `${lastAttempt.target}: ${lastAttempt.error}` : 'no attempts',
      })
      continue
    }
    g.count += n
    if (e.createdAt < g.first) g.first = e.createdAt
    if (e.createdAt >= g.last) {
      g.last = e.createdAt
      if (lastAttempt) g.lastError = `${lastAttempt.target}: ${lastAttempt.error}`
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count)
  const total = sorted.reduce((s, g) => s + g.count, 0)
  const short = (s: string) => (s.length > 160 ? `${s.slice(0, 157)}...` : s)
  const lines = sorted.slice(0, MAX_GROUPS).map(
    g =>
      `  • ${g.count}× ${g.kind} owner=${g.owner} trigger=${g.trigger} → ${g.target}` +
      `${g.topic ? ` topic=${g.topic}` : ''} | ${g.first} … ${g.last} | chain ${g.chain} | last error ${short(g.lastError)}`,
  )
  if (sorted.length > MAX_GROUPS) lines.push(`  • … and ${sorted.length - MAX_GROUPS} more group(s)`)
  const owners = [...new Set(sorted.map(g => g.owner))]
  return (
    `notifier LOST-DIGEST from ${identity}: ${total} signal(s) could NOT be delivered to anyone in their ` +
    `escalation chain and are now dead-letters (status "lost").\n` +
    `ACTION: relay this to arthur (send_to_peer arthur) — ${identity} has no telegram face and cannot reach him — ` +
    `and to the owner(s): ${owners.join(', ')}. Usually it means the target and every fallback failed to wake.\n` +
    `${lines.join('\n')}\n` +
    `Dead-letters on disk: ${spoolDir}`
  )
}

export class LostReporter {
  private running = false
  constructor(private readonly deps: LostReporterDeps) {}

  // One pass. Returns how it ended (for logs/tests). Never throws.
  async tick(): Promise<'idle' | 'busy' | 'sent' | 'failed'> {
    if (this.running) return 'busy'
    this.running = true
    try {
      const entries = this.deps.spool.loadUnreportedLost()
      if (entries.length === 0) return 'idle'
      const message = buildLostDigest(entries, this.deps.identity, this.deps.spoolDir)
      const relays = this.deps.relays().slice(0, LOST_DIGEST_MAX_RELAYS)
      const errors: string[] = []
      for (const to of relays) {
        const r = await this.deps.transport.send({ target: to, message, topic: 'notifier-lost' })
        if (r.ok) {
          const at = this.deps.now().toISOString()
          for (const e of entries) this.deps.spool.update({ ...e, reportedAt: at })
          this.deps.log('lost-digest-sent', { to, entries: entries.length, len: message.length })
          return 'sent'
        }
        errors.push(`${to}: ${r.error ?? 'unknown error'}`)
      }
      // Nobody reachable — entries stay unreported, the next tick retries.
      this.deps.log('lost-digest-failed', {
        entries: entries.length,
        relays: relays.join(','),
        errors: errors.join(' | ') || 'no relays configured',
      })
      return 'failed'
    } catch (err) {
      this.deps.log('lost-digest-error', { error: err instanceof Error ? err.message : String(err) })
      return 'failed'
    } finally {
      this.running = false
    }
  }
}
