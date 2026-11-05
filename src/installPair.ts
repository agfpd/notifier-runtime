// Ported from web-runtime's accepted installer pair-publication guard.
import { randomUUID } from 'crypto'
import { linkSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { runtimeManifestPath, type RuntimeManifest } from './manifest.ts'

/** Publish an already signature-verified executable and its manifest.
 * All preparation is fallible BEFORE publication. If the manifest rename fails,
 * restore the old binary inode/signature (or symlink), or remove a first install.
 * Two paths are NOT crash-atomic: no power-loss/SIGKILL or concurrent-writer claim.
 * No lifecycle operations belong here; running processes keep their old inode. */
export function publishInstallPair(
  stagedBin: string,
  binPath: string,
  manifest: RuntimeManifest,
  env: NodeJS.ProcessEnv,
  // Narrow test seam; production always calls the real synchronous rename.
  rename: typeof renameSync = renameSync,
): string {
  const manifestPath = runtimeManifestPath(env)
  const suffix = `${process.pid}.${randomUUID()}`
  const stagedManifest = `${manifestPath}.${suffix}.tmp`
  const backupBin = `${binPath}.${suffix}.rollback`
  let hadBin = false
  let publishedBin = false
  let retainBackup = false
  // Cleanup cannot turn a completed new pair into a reported publication failure.
  // If cleanup itself is denied, an unused uniquely named file can remain.
  const cleanup = (path: string) => { try { rmSync(path, { force: true }) } catch {} }
  try {
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o755 })
    writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, flag: 'wx' })
    let symlink = false
    try {
      const stat = lstatSync(binPath)
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`self-install: binary is not a file or symlink: ${binPath}`)
      symlink = stat.isSymbolicLink()
      hadBin = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (hadBin) {
      // macOS link(2) follows symlinks. Preserve link text explicitly, including
      // dangling/relative links. Hard-link regular files: no copy or re-signing.
      if (symlink) symlinkSync(readlinkSync(binPath), backupBin)
      else linkSync(binPath, backupBin)
    }
    rename(stagedBin, binPath)
    publishedBin = true
    rename(stagedManifest, manifestPath)
    return manifestPath // no fallible contract operation after the second rename
  } catch (error) {
    if (publishedBin) {
      try {
        if (hadBin) rename(backupBin, binPath)
        else rmSync(binPath)
      } catch (rollbackError) {
        retainBackup = true
        throw new AggregateError([error, rollbackError],
          `self-install: pair publication AND rollback failed; ${hadBin ? `previous binary retained at ${backupBin}` : `could not remove first-install binary ${binPath}`}`)
      }
    }
    throw error
  } finally {
    cleanup(stagedManifest)
    if (!retainBackup) cleanup(backupBin)
  }
}
