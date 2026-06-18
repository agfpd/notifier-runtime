// Shared constants for the notifier runtime.
//
// The notifier carries two personalities on runtime `notifier` — `timer` (TIME
// primitive: cron/heartbeat) and `watcher` (EVENT primitive: monitor) — giving
// IAP identities `notifier-timer` / `notifier-watcher`. The parser/scheduler
// logic is name-agnostic — only the emitted/displayed identity uses this.

export const RUNTIME = 'notifier'

// The personality this runtime emits under for the TIME primitive.
export const PERSONALITY = 'timer'

// Peer-name grammar — identical to the IAP/telegram ecosystem
// (/^[a-z][a-z0-9-]{0,31}$/). Used to validate trigger `target` personalities.
export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

// check-gate default timeout. A gate command that hangs must not wedge the
// scheduler tick — spawnSync is bounded by this and a timeout counts as a
// fail-safe skip (see checkGate.ts).
export const DEFAULT_CHECK_TIMEOUT_MS = 30_000

// Run-loop sleep cap. The scheduler never sleeps longer than this even when the
// next fire is hours away: periodic re-evaluation is the seam for trigger
// reload (re-reading peer-profiles without a restart) and keeps a wall-clock
// jump (laptop sleep/wake) from stranding the loop on a stale wakeup.
export const RUN_LOOP_CAP_MS = 60_000

// cron nextFire search horizon. Walking minute-by-minute past this many years
// without a match means the expression can never fire (e.g. `0 0 30 2 *` —
// Feb 30th) → throw instead of looping forever.
export const CRON_SEARCH_CAP_YEARS = 4

// --- Watcher / EVENT primitive — supervisor restart policy ------------------
//
// Restart policy: a watcher script that dies is ALWAYS restarted
// (any exit, even code 0 — a long-lived monitor is not supposed to exit), with
// exponential backoff so a script that fails immediately does not hammer the
// system. Delay for the n-th consecutive failure (n starting at 0) is
//   min(BACKOFF_START_MS * 2^n, BACKOFF_CAP_MS)
// → 1s, 2s, 4s, 8s … capped at 60s. A successful run (the process lived past the
// crashloop window, or emitted at least one line) resets the counter and backoff.
export const BACKOFF_START_MS = 1_000
export const BACKOFF_CAP_MS = 60_000

// Crashloop circuit-breaker: if a watcher racks up
// CRASHLOOP_THRESHOLD failures within CRASHLOOP_WINDOW_MS (measured from the
// first failure of the current streak), the supervisor STOPS restarting it,
// alerts the OWNER (the script author) via transport, and logs loudly. This
// stops a hard-broken script (e.g. typo on line 1 → instant exit) from
// respawning forever. K=5 fast failures inside a 60s window is the trip point.
export const CRASHLOOP_THRESHOLD = 5
export const CRASHLOOP_WINDOW_MS = 60_000

// A run that lasts at least this long counts as "healthy" and resets the
// backoff/failure streak even if it never emitted a line. Without this floor a
// watcher that quietly exits after, say, 30s would never reset and would
// eventually trip the breaker; with it, only genuinely rapid death (sub-second
// respawns) accumulates toward the crashloop. Kept below BACKOFF_START_MS so a
// process surviving its own backoff gap is already considered recovered.
export const HEALTHY_RUN_MS = 1_000

// --- Escalation -------------------------------------------------------------
//
// Rationale: a watcher-detected alarm must never die silently when the target's
// wake fails (e.g. the target never becomes ready) — a bare send-error must not
// be terminal. The contract: an undelivered signal is RETRIED and then escalated
// down a
// fallback chain (target → per-trigger fallback(s) → trigger owner → global
// backstop); only after the whole chain is exhausted does it become a loud
// `delivery-lost` + a durable dead-letter file. Semantics: "delivered to
// someone alive" beats "delivered exactly to target"; at-least-once (a
// duplicate alert is better than a lost one).

// Attempts per chain link (R). 2 = one immediate try + one retry, then the next
// link — an emergency circuit must reach a live fallback in minutes, not retry
// a dead target forever.
export const ESCALATION_ATTEMPTS_PER_LINK = 2

// Delay between attempts on the SAME link. Long enough for a transient wake /
// restart gap to clear, short enough that the first fallback hears about an
// alarm within ~minutes.
export const ESCALATION_RETRY_DELAY_MS = 30_000

// Hard timeout for ONE delivery attempt (`iapeer send` child). The old
// spawnSync transport had NO timeout — a hung send wedged the whole notifier
// forever (the quiet mine under the alarm circuit). Generous: a cold
// wake-on-miss legitimately takes tens of seconds.
export const SEND_TIMEOUT_MS = 120_000

// Global backstop — an optional terminal link appended to EVERY escalation chain
// AFTER the trigger owner. Empty by default: the owner is the terminal link, so a
// fresh install needs no team-specific configuration. Set NOTIFIER_FALLBACK_TARGET
// to a peer that should catch any signal the owner could not be reached for (e.g.
// a team-wide on-call peer).
export const DEFAULT_FALLBACK_TARGET = ''
