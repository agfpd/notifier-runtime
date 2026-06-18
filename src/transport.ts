import { spawn, spawnSync } from 'child_process'
import { SEND_TIMEOUT_MS } from './constants.ts'

// A signal to deliver to one peer, addressed by personality.
export interface Signal {
  target: string
  message: string
  topic?: string
}

export interface SendResult {
  ok: boolean
  error?: string
}

export interface Transport {
  send(sig: Signal): SendResult
}

export interface IapTransportConfig {
  iapBin?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
}

// Production transport: shells out to `iap send <target> --message-file - [--topic <t>]`
// with the message piped on stdin. Mirrors telegram-runtime's runIapSend, except
// the message goes through stdin (`-`) rather than a temp file.
//
// Caller identity is resolved by `iap` itself from the cwd peer-profile + env
// (PEER_PERSONALITY/PEER_RUNTIME/PEER_IDENTITY). In production those are
// inherited from the notifier-timer run session, so we do not stamp them here —
// we pass cwd/env straight through.
export function makeIapTransport(cfg: IapTransportConfig = {}): Transport {
  const iapBin = cfg.iapBin ?? process.env.IAP_BIN ?? 'iapeer'
  return {
    send(sig: Signal): SendResult {
      const args = ['send', sig.target, '--message-file', '-']
      if (sig.topic) {
        args.push('--topic', sig.topic)
      }
      const result = spawnSync(iapBin, args, {
        cwd: cfg.cwd,
        env: cfg.env,
        input: sig.message,
        encoding: 'utf8',
      })
      if (result.error) {
        return { ok: false, error: result.error.message }
      }
      if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || `exit ${result.status}`).toString().trim()
        return { ok: false, error: detail }
      }
      return { ok: true }
    },
  }
}

// ── Async transport (escalation path) ───────────────────────────────────────
//
// The sync transport above blocks the WHOLE notifier event loop for the full
// duration of a send — and spawnSync carries no timeout, so a hung `iapeer
// send` (e.g. a target stuck mid-wake) wedged the notifier forever. The
// escalation engine (escalation.ts) needs neither property: delivery attempts
// run async (the scheduler tick / watcher forward path never waits on a wake)
// and every attempt is bounded by a hard timeout (SEND_TIMEOUT_MS → SIGKILL →
// the attempt counts as failed and the chain moves on).

export interface AsyncTransport {
  send(sig: Signal): Promise<SendResult>
}

export interface AsyncIapTransportConfig extends IapTransportConfig {
  timeoutMs?: number
}

export function makeAsyncIapTransport(cfg: AsyncIapTransportConfig = {}): AsyncTransport {
  const iapBin = cfg.iapBin ?? process.env.IAP_BIN ?? 'iapeer'
  const timeoutMs = cfg.timeoutMs ?? SEND_TIMEOUT_MS
  return {
    send(sig: Signal): Promise<SendResult> {
      return new Promise<SendResult>(resolve => {
        const args = ['send', sig.target, '--message-file', '-']
        if (sig.topic) args.push('--topic', sig.topic)

        let settled = false
        let timedOut = false
        const settle = (result: SendResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        }

        let child: ReturnType<typeof spawn>
        try {
          child = spawn(iapBin, args, { cwd: cfg.cwd, env: cfg.env, stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (err) {
          resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
          return
        }

        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)

        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', d => (stdout += String(d)))
        child.stderr?.on('data', d => (stderr += String(d)))
        // A spawn failure (ENOENT etc.) emits 'error'; 'close' may not follow.
        child.on('error', err => settle({ ok: false, error: err.message }))
        // On a timeout-kill settle on 'exit', NOT 'close': 'close' waits for the
        // stdio pipes, which a grandchild of the killed process may keep open
        // (the kill would then be reported only when the orphan exits — exactly
        // the hang class this timeout exists to bound). Output is irrelevant on
        // this path: the verdict is the timeout itself.
        child.on('exit', () => {
          if (timedOut) settle({ ok: false, error: `send timed out after ${timeoutMs}ms (killed)` })
        })
        child.on('close', (code, signal) => {
          if (timedOut) {
            settle({ ok: false, error: `send timed out after ${timeoutMs}ms (killed)` })
            return
          }
          if (code === 0) {
            settle({ ok: true })
            return
          }
          const detail = (stderr || stdout || `exit ${code ?? signal}`).trim()
          settle({ ok: false, error: detail })
        })
        // EPIPE on a child that died before reading stdin must not crash the
        // process — 'close' will still deliver the failure.
        child.stdin?.on('error', () => {})
        child.stdin?.write(sig.message)
        child.stdin?.end()
      })
    },
  }
}

// Test double for the async path: scripted per-target results + a recorded
// send order. `script` maps target → a queue of results (shifted per send);
// an exhausted/absent queue falls back to `defaultResult`.
export class FakeAsyncTransport implements AsyncTransport {
  sent: Signal[] = []
  defaultResult: SendResult = { ok: true }
  script = new Map<string, SendResult[]>()

  async send(sig: Signal): Promise<SendResult> {
    this.sent.push(sig)
    const queue = this.script.get(sig.target)
    if (queue && queue.length > 0) return queue.shift()!
    return this.defaultResult
  }
}

// Test double: records every signal and returns a configurable result. Never
// touches the network or a real `iap` binary.
export class FakeTransport implements Transport {
  sent: Signal[] = []
  result: SendResult = { ok: true }

  constructor(result?: SendResult) {
    if (result) this.result = result
  }

  send(sig: Signal): SendResult {
    this.sent.push(sig)
    return this.result
  }
}
