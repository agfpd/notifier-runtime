// npx-self-install — the package's self-deploy. `npx @agfpd/notifier-runtime` (a bare,
// no-subcommand invocation — the foundation's defaultNpxRunner runs `npx -y <pkg>`
// with NO args) IDEMPOTENTLY:
//   (a) puts an executable `notifier-runtime` on PATH (a self-contained `bun build
//       --compile` snapshot — decoupled from the npm-cache source dir, which GC's),
//   (b) writes the runtime manifest at <IAPEER_ROOT>/runtimes/notifier/runtime.json.
//
// This is the npx↔foundation seam: after this, `iapeer install-runtime notifier`
// reads the manifest and provisions timer+watcher. The two ordering invariants that
// guard against the most likely first failure: the manifest lands under the RIGHT root
// (manifest.ts resolves IAPEER_ROOT from env), and the bin is on PATH BEFORE deploy
// (this runs first).
//
// Bin placement: IAPEER_BIN_DIR override → else ~/.local/bin (the standard user-bin,
// same home as the foundation's `iapeer`, and on the launchd-minimal PATH the plist
// bakes — `~/.bun/bin:~/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`). The sandbox
// proof sets IAPEER_BIN_DIR so a test never pollutes the real ~/.local/bin.

import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import pkg from '../package.json'
import { RUNTIME } from './constants.ts'
import { scaffoldHostDocs, type ScaffoldDocsResult } from './hostDocs.ts'
import { buildManifest, resolveIapeerRoot, writeManifestAtomic } from './manifest.ts'
import {
  commandFailure, ensureExecutableSignature, type ExecutableSignatureMode, type InstallCommandRunner,
} from './installSignature.ts'

/** The launcher binary name — `<runtime>-runtime`, matching the foundation's
 *  INFRA_RUNTIME_DEFAULT_BIN.notifier and the notifier adapter's buildArgv fallback. */
export const BIN_NAME = `${RUNTIME}-runtime`

/** The on-host docs dir name = the UNSCOPED npm package name (`notifier-runtime`),
 *  so docs land at <IAPEER_ROOT>/docs/notifier-runtime/ — the FU6 convention path
 *  the foundation injects into the system prompt. */
export const DOCS_PKG = pkg.name.split('/').pop() ?? BIN_NAME

export interface SelfInstallOptions {
  env?: NodeJS.ProcessEnv
  /** The cli.ts source entry to compile (default: this module's sibling cli.ts). When
   *  it is not a real .ts file on disk (running FROM a compiled bin), self-install
   *  falls back to copying the running executable instead of recompiling. */
  sourceEntry?: string
  /** The running interpreter / compiled bin (default process.execPath). When the
   *  source path is real and this is `bun`, it is the compiler we invoke. */
  execPath?: string
  /** Platform/command seams for tests; both compile and signing use this runner. */
  platform?: NodeJS.Platform
  run?: InstallCommandRunner
}

export type SelfInstallBinMode = 'compiled' | 'copied-self'

export interface SelfInstallResult {
  binPath: string
  manifestPath: string
  binMode: SelfInstallBinMode
  signature: ExecutableSignatureMode
  root: string
  binDir: string
  /** FU6 on-host docs scaffolding outcome (best-effort; never blocks install). */
  docs: ScaffoldDocsResult
}

/** Resolve the bin dir: IAPEER_BIN_DIR override → else ~/.local/bin. */
export function resolveBinDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.IAPEER_BIN_DIR?.trim()
  if (override) return override
  const home = env.HOME?.trim() || homedir()
  if (!home) throw new Error('cannot resolve home directory for the bin dir')
  return join(home, '.local', 'bin')
}

/** True when `path` is a real .ts source file we can `bun build --compile`. */
function isCompilableSource(path: string | undefined): path is string {
  if (!path || !path.endsWith('.ts')) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Self-install: place the launcher on PATH + write the manifest. IDEMPOTENT — a
 * repeat run produces the same on-disk bin and a byte-identical manifest (atomic
 * overwrite-in-place; no duplicated or divergent state). Returns what it did.
 */
export function selfInstall(opts: SelfInstallOptions = {}): SelfInstallResult {
  const env = opts.env ?? process.env
  const sourceEntry = opts.sourceEntry ?? join(import.meta.dir, 'cli.ts')
  const execPath = opts.execPath ?? process.execPath
  const binDir = resolveBinDir(env)
  const binPath = join(binDir, BIN_NAME)
  const run = opts.run ?? spawnSync

  mkdirSync(binDir, { recursive: true, mode: 0o755 })

  // Build to a sibling tmp in the SAME dir (rename is atomic only within one FS), then
  // chmod +x, strict signature gate, then rename over the target. A signature
  // failure leaves BOTH the previous bin and manifest untouched.
  const tmp = `${binPath}.tmp.${process.pid}.${randomUUID()}`
  let binMode: SelfInstallBinMode
  let signature: ExecutableSignatureMode

  try {
    if (isCompilableSource(sourceEntry) && isBunInterpreter(execPath)) {
      // PRIMARY: compile a self-contained snapshot, independent of npm cache GC.
      const r = run(execPath, ['build', '--compile', '--outfile', tmp, sourceEntry], {
        encoding: 'utf8',
        env,
      })
      if (r.error || r.signal || r.status !== 0) {
        throw new Error(`self-install: bun build --compile failed: ${commandFailure(r)}`)
      }
      binMode = 'compiled'
    } else {
      // FALLBACK: no source/compiler — copy the running executable instead.
      copyFileSync(execPath, tmp)
      binMode = 'copied-self'
    }

    chmodSync(tmp, 0o755)
    signature = ensureExecutableSignature(tmp, { platform: opts.platform, env, run })
    renameSync(tmp, binPath)
  } finally {
    // Includes partial compile/copy, chmod, signature, and rename failures. Do
    // not leave unsigned/invalid .dead binaries alongside the installed one.
    rmSync(tmp, { force: true })
  }

  // Manifest pins the ABSOLUTE installed bin into the self-config descriptor.
  const manifest = buildManifest(binPath)
  const manifestPath = writeManifestAtomic(manifest, env)

  // FU6: stage this package's docs to <root>/docs/notifier-runtime/ (best-effort,
  // never blocks install). docsSource is the package's docs/ dir resolved from the
  // source entry (<pkgroot>/src/cli.ts → <pkgroot>/docs). When running from a
  // compiled bin (copied-self path) there is no source tree, so the source is
  // absent and scaffoldHostDocs soft-skips — docs are staged on the npx/source
  // install where the version-matched docs/ actually exists.
  const docs = scaffoldHostDocs(DOCS_PKG, join(sourceEntry, '..', '..', 'docs'), env)

  return { binPath, manifestPath, binMode, signature, root: resolveIapeerRoot(env), binDir, docs }
}

/** Is `execPath` a bun interpreter (so `<execPath> build` works)? When running
 *  `bun src/cli.ts`, process.execPath IS the bun binary (basename `bun`). A compiled
 *  notifier-runtime has basename `notifier-runtime` → NOT bun → we must not call
 *  `<it> build` (it would be `notifier-runtime build …`), so we fall back to copy-self. */
function isBunInterpreter(execPath: string): boolean {
  const base = execPath.split('/').pop() ?? execPath
  return base === 'bun' || base === 'bun-debug'
}
