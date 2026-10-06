// Local equivalent of the iapeer runtime-package install-signature contract.
// Verify the STAGED executable before publishing either the bin or manifest.
// A valid signature must not be replaced (its identity may carry TCC grants).
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process'

export interface InstallCommandResult {
  status: number | null
  stdout?: string | null
  stderr?: string | null
  error?: Error
  signal?: NodeJS.Signals | null
}

/** Injectable for sandbox tests; production always invokes argv without a shell. */
export type InstallCommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => InstallCommandResult

export interface ExecutableSignatureOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  run?: InstallCommandRunner
}

export type ExecutableSignatureMode = 'valid' | 'repaired' | 'skipped'

export function commandFailure(result: InstallCommandResult): string {
  return result.error?.message || (result.signal ? `signal ${result.signal}` : '') ||
    result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`
}

/** macOS: strict verify → repair only invalid/unsigned code → strict reverify.
 *  Launch errors, signals, missing exit status, and failed repair/reverify abort.
 *  Other platforms don't require codesign. The caller owns tmp cleanup. */
export function ensureExecutableSignature(
  path: string,
  opts: ExecutableSignatureOptions = {},
): ExecutableSignatureMode {
  if ((opts.platform ?? process.platform) !== 'darwin') return 'skipped'
  const run = opts.run ?? spawnSync
  const invoke = (action: string, args: string[]): InstallCommandResult => {
    let result: InstallCommandResult
    try {
      result = run('/usr/bin/codesign', args, {
        encoding: 'utf8',
        env: opts.env ?? process.env,
        timeout: 30_000,
        killSignal: 'SIGKILL',
      })
    } catch (error) {
      throw new Error(`self-install: codesign ${action} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // An inability to verify is NOT proof that a signature is invalid. Fail
    // closed without replacing a possibly valid signature in that case.
    if (result.error || result.signal || result.status == null) {
      throw new Error(`self-install: codesign ${action} failed: ${commandFailure(result)}`)
    }
    return result
  }
  const verifyArgs = ['--verify', '--deep', '--strict', path]
  if (invoke('verify', verifyArgs).status === 0) return 'valid'

  const signed = invoke('ad-hoc sign', ['--force', '--sign', '-', path])
  if (signed.status !== 0) {
    throw new Error(`self-install: codesign ad-hoc sign failed: ${commandFailure(signed)}`)
  }
  const verified = invoke('verify after repair', verifyArgs)
  if (verified.status !== 0) {
    throw new Error(`self-install: codesign verify after repair failed: ${commandFailure(verified)}`)
  }
  return 'repaired'
}
