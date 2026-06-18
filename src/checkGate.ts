import { spawnSync } from 'child_process'
import { DEFAULT_CHECK_TIMEOUT_MS } from './constants.ts'

// Result of evaluating a trigger's optional check-gate.
//
// UNIX exit semantics: exit 0 = condition met = SEND; exit != 0 = skip. Like `test`
// / `grep -q`. `error` is set ONLY on a fail-safe skip (gate could not run /
// timed out / killed by signal) — the caller logs those loudly.
export interface CheckResult {
  send: boolean
  reason: string
  exitCode?: number
  error?: string
}

export interface RunCheckOptions {
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

// Evaluate a check command. No check → unconditional send. With a check:
//   exit 0    → send
//   exit != 0 → skip (the condition is simply not met)
// Fail-safe: ENOENT / not-executable / timeout / signal kill → skip + error.
// A broken gate must NEVER send (we cannot prove the condition holds) and the
// caller surfaces `error` in a loud log so a misconfigured gate is visible.
export function runCheck(check: string | undefined, opts: RunCheckOptions = {}): CheckResult {
  if (!check) {
    return { send: true, reason: 'unconditional' }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS

  const result = spawnSync(check, [], {
    timeout: timeoutMs,
    cwd: opts.cwd,
    env: opts.env,
    // We only need the exit status; capturing output as strings keeps any
    // diagnostics available without binary-buffer handling.
    encoding: 'utf8',
  })

  // spawnSync sets `error` for ENOENT / EACCES (not found / not executable) and
  // for a timeout kill (with result.signal). Treat ALL of these as fail-safe
  // skip — we never send on a gate we could not run to a clean exit.
  if (result.error) {
    const isTimeout =
      (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || result.signal != null
    return {
      send: false,
      reason: isTimeout ? 'check-timeout' : 'check-error',
      error: result.error.message,
    }
  }

  // Killed by a signal without spawnSync surfacing an Error (e.g. timeout on
  // some platforms reports status=null + signal). Fail-safe skip.
  if (result.signal != null) {
    return {
      send: false,
      reason: 'check-timeout',
      error: `check killed by signal ${result.signal}`,
    }
  }

  // status can be null if the process neither exited normally nor by a signal
  // we caught — defensively treat a null status as a fail-safe skip too.
  if (result.status == null) {
    return {
      send: false,
      reason: 'check-error',
      error: 'check produced no exit status',
    }
  }

  if (result.status === 0) {
    return { send: true, reason: 'check-passed', exitCode: 0 }
  }
  return { send: false, reason: 'check-failed', exitCode: result.status }
}
