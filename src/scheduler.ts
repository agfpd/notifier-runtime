import { RUN_LOOP_CAP_MS } from './constants.ts'
import type { CheckResult } from './checkGate.ts'
import type { EscalationJob } from './escalation.ts'
import type { TimeTrigger } from './triggers.ts'
import { nextFire, parseWhen, type ParsedWhen } from './when.ts'

export interface SchedulerDeps {
  now: () => Date
  // Escalating delivery (notifier-alert-escalation): the scheduler hands the
  // signal to the Escalator and moves on — retries/fallbacks/dead-letter happen
  // there, asynchronously. A fire NEVER blocks the tick on a wake and a
  // send-failure is never terminal here.
  deliver: (job: EscalationJob) => void
  runCheck: (check: string | undefined) => CheckResult
  log: (evt: string, fields?: Record<string, unknown>) => void
}

interface SchedulerSlot {
  trigger: TimeTrigger
  parsed: ParsedWhen
  // Interval anchor (run start). cron ignores it. nextFire(parsed, now, anchor)
  // keeps the interval grid aligned to the start instant across advances.
  anchor: Date
  nextAt: Date
}

// Reload diff key: a trigger's identity within the running set is
// owner:id. Two triggers from different owners can share an id; the owner
// prefix disambiguates. Stable across reloads so a surviving slot is matched
// (not re-created) and its anchor/nextAt are preserved.
function slotKey(trigger: TimeTrigger): string {
  return `${trigger.owner}:${trigger.id}`
}

export class Scheduler {
  private slots: SchedulerSlot[] = []
  private deps: SchedulerDeps
  // Set while the run loop is sleeping; calling it resolves that sleep early so
  // the loop re-evaluates nextWakeup. reload() uses it to make a just-registered
  // trigger fire on time instead of waiting out the cap. null when not sleeping.
  private sleepWaker: (() => void) | null = null

  // anchor = now() at construction; nextAt = first fire strictly after now.
  // A trigger whose `when` fails to parse here is dropped with a loud log
  // (loadTriggers should have caught it, but the scheduler is the last gate and
  // must not crash on one bad expression).
  constructor(triggers: TimeTrigger[], deps: SchedulerDeps) {
    this.deps = deps
    const start = deps.now()
    for (const trigger of triggers) {
      const slot = this.makeSlot(trigger, start)
      if (slot) this.slots.push(slot)
    }
  }

  // Build a fresh slot for `trigger`, anchored at `anchor` (the run/reload
  // instant). A trigger whose `when` fails to parse is dropped with a loud log
  // (loadTriggers should have caught it, but the scheduler is the last gate and
  // must not crash on one bad expression). Returns undefined on a parse failure.
  private makeSlot(trigger: TimeTrigger, anchor: Date): SchedulerSlot | undefined {
    try {
      const parsed = parseWhen(trigger.when)
      const nextAt = nextFire(parsed, anchor, anchor)
      return { trigger, parsed, anchor, nextAt }
    } catch (err) {
      this.deps.log('trigger-skip', {
        owner: trigger.owner,
        target: trigger.target,
        when: trigger.when,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  // Live reload: apply a fresh projection WITHOUT a
  // restart. Diff by key owner:id:
  //   • a key present in both old and new with the SAME `when` → PRESERVE the
  //     existing slot (keep its anchor + nextAt — do NOT reset the interval grid
  //     or re-arm cron). The trigger object itself is refreshed so an edited
  //     message/target/topic/check takes effect, but the firing schedule is
  //     untouched.
  //   • a surviving key with a CHANGED `when` (same-id replace) → RE-ARM: build a
  //     fresh slot anchored at now. The old grid belongs to the old expression —
  //     preserving it would keep firing on the stale schedule until a daemon
  //     restart (parsed/anchor were never recomputed: the trigger-replace-
  //     live-state defect, scheduler flavor).
  //   • a new key → add a fresh slot anchored at now (its first fire is computed
  //     from this instant, so a just-registered interval does not back-date).
  //   • a gone key → drop the slot (it stops firing).
  // This is what lets a sleeping requester register a trigger and have it fire
  // without bouncing the notifier (and without the surviving triggers losing
  // their place in the grid).
  reload(triggers: TimeTrigger[]): void {
    const now = this.deps.now()
    const bySurviving = new Map<string, SchedulerSlot>()
    for (const slot of this.slots) bySurviving.set(slotKey(slot.trigger), slot)

    const next: SchedulerSlot[] = []
    const seen = new Set<string>()
    let added = 0
    let preserved = 0
    let replaced = 0
    for (const trigger of triggers) {
      const key = slotKey(trigger)
      // De-dupe a key appearing twice in the new set (first wins) so the running
      // set never holds two slots for the same owner:id. A duplicate owner:id in
      // one projection is a profile bug; we keep the first deterministically.
      if (seen.has(key)) continue
      seen.add(key)
      const existing = bySurviving.get(key)
      if (existing && existing.trigger.when === trigger.when) {
        // Preserve schedule (anchor/nextAt/parsed); refresh the trigger payload.
        existing.trigger = trigger
        next.push(existing)
        preserved++
      } else {
        // New key, or surviving key whose `when` changed (same-id replace) —
        // either way the schedule is (re)computed from this instant.
        const slot = this.makeSlot(trigger, now)
        if (slot) {
          next.push(slot)
          if (existing) replaced++
          else added++
        }
      }
    }
    // A replaced slot is neither preserved nor removed; a failed re-parse on
    // replace falls into `removed` (the old slot is gone, no new one took over).
    const removed = this.slots.length - preserved - replaced
    this.slots = next
    this.deps.log('reload', { added, removed, preserved, replaced, total: next.length })
    // Wake the sleeping run loop so the new projection takes effect NOW. Without
    // this a trigger registered while the loop sleeps would not fire until the
    // current sleep (up to the 60s cap) elapses — too late for "live" reload
    // No-op when the loop is not currently sleeping.
    this.wake()
  }

  // Interrupt the current run-loop sleep (if any) so run() re-evaluates
  // nextWakeup against the freshly-reloaded slots. No-op when not sleeping.
  private wake(): void {
    this.sleepWaker?.()
  }

  // Earliest nextAt across all live slots, or null when there are no triggers.
  nextWakeup(_now?: Date): Date | null {
    let earliest: Date | null = null
    for (const slot of this.slots) {
      if (earliest === null || slot.nextAt.getTime() < earliest.getTime()) {
        earliest = slot.nextAt
      }
    }
    return earliest
  }

  // Fire every due slot (nextAt <= now): gate → send → log → advance. Advance
  // is computed strictly after `now`, so a slot can fire at most once per tick
  // and the new nextAt is always in the future (no double-fire, no busy-spin).
  // Each slot is independently try/caught — one throwing trigger never stops the
  // rest of the tick.
  tick(now: Date): void {
    for (const slot of this.slots) {
      if (slot.nextAt.getTime() > now.getTime()) continue
      try {
        this.fireSlot(slot, now)
      } catch (err) {
        this.deps.log('trigger-error', {
          owner: slot.trigger.owner,
          target: slot.trigger.target,
          when: slot.trigger.when,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        // ALWAYS advance, even if firing threw — otherwise a slot that throws on
        // every tick would busy-spin (nextAt stuck in the past) and re-fire on
        // the very next loop iteration. Strictly-after `now` guarantees progress.
        this.advance(slot, now)
      }
    }
  }

  private fireSlot(slot: SchedulerSlot, now: Date): void {
    const { trigger } = slot
    const base = { owner: trigger.owner, target: trigger.target, when: trigger.when }
    this.deps.log('fired', { ...base, at: now.toISOString() })

    const gate = this.deps.runCheck(trigger.check)
    if (!gate.send) {
      // A fail-safe skip (gate error/timeout) carries `error` — log it loudly so
      // a broken gate is visible; a plain exit!=0 skip is quiet/expected.
      if (gate.error) {
        this.deps.log('check-error', { ...base, reason: gate.reason, error: gate.error })
      } else {
        this.deps.log('skipped', { ...base, reason: gate.reason, exitCode: gate.exitCode })
      }
      return
    }

    // Hand off to the Escalator (async, never blocks the tick). Outcome logging
    // lives there: `sent` (with len — the 0.1.3 attribution contract) on
    // success, `deliver-attempt`/`deliver-failed` per attempt, `delivery-lost`
    // + dead-letter after the whole chain is exhausted. The old terminal
    // `send-error` path is gone by design.
    this.deps.deliver({
      kind: 'fire',
      target: trigger.target,
      message: trigger.message,
      ...(trigger.topic ? { topic: trigger.topic } : {}),
      ...(trigger.fallback ? { fallbacks: trigger.fallback } : {}),
      owner: trigger.owner,
      meta: { owner: trigger.owner, when: trigger.when, reason: gate.reason },
    })
  }

  private advance(slot: SchedulerSlot, now: Date): void {
    // cron: recompute strictly after now. interval: skip-to-next off the anchor
    // grid, strictly after now (missed slots during a long tick gap collapse to
    // the next future one — no catch-up).
    slot.nextAt = nextFire(slot.parsed, now, slot.anchor)
  }

  // Run loop: sleep until min(nextWakeup, now+cap) then tick. The cap (60s)
  // bounds every sleep so the loop periodically re-evaluates (seam for
  // trigger reload + resilience to wall-clock jumps). The sleep is cancellable
  // via AbortSignal for graceful shutdown. No busy-spin: when a slot is already
  // due, tick advances it past `now` before the next sleep is computed.
  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const now = this.deps.now()
      const wakeup = this.nextWakeup(now)
      // No triggers → still wake on the cap so a future reload is picked up;
      // never spin tightly.
      const targetMs =
        wakeup === null
          ? now.getTime() + RUN_LOOP_CAP_MS
          : Math.min(wakeup.getTime(), now.getTime() + RUN_LOOP_CAP_MS)
      const sleepMs = Math.max(0, targetMs - now.getTime())

      if (sleepMs > 0) {
        const interrupted = await this.cancellableSleep(sleepMs, signal)
        if (interrupted) return
      }
      if (signal?.aborted) return
      this.tick(this.deps.now())
    }
  }

  // Resolve true if aborted during the wait, false if the timer elapsed. Cleans
  // up both the timer and the abort listener on every exit path.
  private cancellableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      let settled = false
      // settle(true) = aborted (run loop should exit); settle(false) = timer
      // elapsed OR woken by reload (run loop re-evaluates and continues).
      const settle = (aborted: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.sleepWaker = null
        signal?.removeEventListener('abort', onAbort)
        resolve(aborted)
      }
      const onAbort = () => settle(true)
      const timer = setTimeout(() => settle(false), ms)
      // reload() → wake() → this resolves the sleep early as NOT aborted, so the
      // loop loops, recomputes nextWakeup over the new slots, and fires on time.
      this.sleepWaker = () => settle(false)
      if (signal) {
        if (signal.aborted) {
          settle(true)
          return
        }
        signal.addEventListener('abort', onAbort)
      }
    })
  }
}
