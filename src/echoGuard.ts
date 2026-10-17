import { ECHO_WINDOW_MS } from './constants.ts'
import type { AsyncTransport, SendResult, Signal, Transport } from './transport.ts'

// EchoGuard — breaks the watcher echo loop (incidents 26.08, 29.09, 06.10,
// 16.10.2026; each ended in a flood-stop).
//
// The loop: a watcher tails the iapeer delivery log
// (~/.iapeer/logs/iapeer/delivery.log, e.g. `tail -F … | grep ok=false`). Every
// delivery THIS notifier makes is itself logged there — the core writes one
// line per `iapeer send`, of the shape
//
//   ts=… ev=delivery path=cli caller=notifier-watcher to=<T> ok=<bool> … err="…"
//
// so a forward of a failed-delivery line to an offline target produces a new
// failed-delivery line, which the watcher reads and forwards again (gain ≥ 1;
// the escalation fallback `to=boris` echoes too, so per-target grep -v filters
// in the script do not close the class). With a live target the ok=true echo
// loops just the same if the script does not filter ok=false.
//
// Guard: the process records every outbound send per recipient (in flight, and
// the wall-clock it finished). A watcher stdout line is an ECHO when it carries
// BOTH our own identity token (`notifier-<personality>`) AND the token of a
// recipient we were sending to at that moment or ≤ ECHO_WINDOW_MS ago. The
// supervisor drops echoes before the flood counter. Tokens are matched on word
// boundaries over [a-z0-9-] (peer-name alphabet), so `notifier-watcher` does
// not match `notifier-watcher2` and `boris` does not match `claude-boris`.
//
// Coupling: this relies on the delivery-log carrying the caller identity and
// the recipient personality verbatim. If the core changes that format (e.g.
// drops `caller=` or writes `to=claude-boris`), echoes stop being recognized
// and the flood breaker becomes the only backstop again — re-check here.
export class EchoGuard {
  private inFlight = new Map<string, number>()
  private lastEnd = new Map<string, number>()
  private readonly identityRe: RegExp

  constructor(
    readonly identity: string,
    private readonly now: () => number = () => Date.now(),
    private readonly windowMs: number = ECHO_WINDOW_MS,
  ) {
    this.identityRe = tokenRe(identity)
  }

  begin(target: string): void {
    this.inFlight.set(target, (this.inFlight.get(target) ?? 0) + 1)
  }

  end(target: string): void {
    const n = (this.inFlight.get(target) ?? 1) - 1
    if (n <= 0) this.inFlight.delete(target)
    else this.inFlight.set(target, n)
    this.lastEnd.set(target, this.now())
  }

  // The recipient this line echoes, or null when it is not an echo.
  echoOf(line: string): string | null {
    if (!this.identityRe.test(line)) return null
    const now = this.now()
    for (const [target, at] of [...this.lastEnd]) {
      if (now - at > this.windowMs && !this.inFlight.has(target)) this.lastEnd.delete(target)
    }
    const candidates = new Set([...this.inFlight.keys(), ...this.lastEnd.keys()])
    for (const target of candidates) {
      if (tokenRe(target).test(line)) return target
    }
    return null
  }

  wrapAsync(t: AsyncTransport): AsyncTransport {
    return {
      send: async (sig: Signal): Promise<SendResult> => {
        this.begin(sig.target)
        try {
          return await t.send(sig)
        } finally {
          this.end(sig.target)
        }
      },
    }
  }

  wrapSync(t: Transport): Transport {
    return {
      send: (sig: Signal): SendResult => {
        this.begin(sig.target)
        try {
          return t.send(sig)
        } finally {
          this.end(sig.target)
        }
      },
    }
  }
}

function tokenRe(token: string): RegExp {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![a-z0-9-])${esc}(?![a-z0-9-])`)
}
