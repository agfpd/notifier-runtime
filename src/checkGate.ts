import { spawnSync } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import { delimiter, isAbsolute } from 'path'
import { DEFAULT_CHECK_TIMEOUT_MS } from './constants.ts'

// Registration preflight only: inspect the whole literal name, never execute it
// or split it into shell tokens. Resolve in the TIMER's environment, like spawn.
// This cannot prove the interpreter/dependencies/condition will work at fire time.
export function validateCheck(check: string, opts: { cwd?: string; path?: string } = {}): string | undefined {
  const hint = 'check must name one executable file (no arguments or shell expressions); put the condition in a chmod +x script with a shebang. Paths with spaces are literal, without extra shell quotes.'
  if (!check || check.includes('\0')) return `invalid check: ${JSON.stringify(check)}; ${hint}`
  const cwd = opts.cwd ?? process.cwd()
  // Do not normalize '..': the OS traverses it AFTER following symlinks.
  // Lexical path.resolve/join could probe a different file than spawn executes.
  const inCwd = (path: string) => isAbsolute(path) ? path : `${cwd}/${path}`
  const candidates = check.includes('/')
    ? [inCwd(check)]
    : (opts.path ?? process.env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => `${inCwd(dir || '.')}/${check}`)
  let problem = 'not found'
  for (const path of candidates) {
    try {
      if (!statSync(path).isFile()) {
        problem = 'not a regular file'
        continue
      }
      accessSync(path, constants.X_OK)
      return undefined
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') problem = code ?? 'inaccessible'
    }
  }
  return `check ${JSON.stringify(check)} is not executable by timer (${problem}); ${hint}`
}

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
}

// Evaluate a literal executable name, without arguments or a shell. No check → unconditional send.
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
    shell: false,
    timeout: timeoutMs,
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
