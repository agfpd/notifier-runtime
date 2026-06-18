// FU6 — on-host docs per-package (ecosystem convention, foundation-owned).
//
// Each ecosystem package copies its OWN public docs to the STABLE, versioned,
// per-package host path <IAPEER_ROOT>/docs/<pkg>/ on its OWN install/update, so
// an agent can read the contract OFFLINE and the on-host docs ALWAYS match the
// installed version. This is necessary because the compiled launcher embeds no
// docs, and the npm tarball's docs/ is discarded right after install (the npx
// cache is transient and not findable) — only a copy under ~/.iapeer survives.
//
// This mirrors the foundation reference impl `scaffoldHostDocs` (iapeer
// src/install/index.ts): an atomic temp-dir swap, the internals/ subtree
// excluded (matching the npm `files` exclusion), a fail-closed sandbox guard,
// and BEST-EFFORT semantics — a missing source or a copy hiccup NEVER fails the
// install (the runtime works without on-host docs; the caller just logs the
// outcome).

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join, relative, sep } from 'path'
import { resolveIapeerRoot } from './manifest.ts'

export interface ScaffoldDocsResult {
  copied: boolean
  dest: string
  reason?: string
}

/**
 * Copy `docsSource` → <IAPEER_ROOT>/docs/<pkg>/ EXCLUDING the internals/ subtree,
 * via an atomic temp-dir swap (so a reader never sees a half-copied tree).
 * BEST-EFFORT: returns `{copied:false, reason}` on a missing source or any copy
 * error instead of throwing — the install must not fail because docs could not
 * be staged. The ONE hard failure is the sandbox guard: under
 * IAPEER_TEST_SANDBOX=1 a root resolving to the REAL ~/.iapeer throws, so a test
 * that forgot IAPEER_ROOT can never scribble on the live machine docs.
 */
export function scaffoldHostDocs(
  pkg: string,
  docsSource: string,
  env: NodeJS.ProcessEnv = process.env,
): ScaffoldDocsResult {
  const root = resolveIapeerRoot(env)
  const dest = join(root, 'docs', pkg)
  // Fail-closed sandbox guard — compared against the ACTUAL OS home (homedir()),
  // not env.HOME: the root IS the docs isolation, so an env.HOME-based check would
  // false-trip when a test legitimately points IAPEER_ROOT at <tmp>/.iapeer.
  if (env.IAPEER_TEST_SANDBOX === '1' && root === join(homedir(), '.iapeer')) {
    throw new Error(
      `refusing to scaffold docs into the REAL ${join(root, 'docs')} under IAPEER_TEST_SANDBOX=1 — set IAPEER_ROOT`,
    )
  }
  if (!existsSync(docsSource)) return { copied: false, dest, reason: `docs source not found: ${docsSource}` }
  const tmp = `${dest}.tmp-${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(join(dest, '..'), { recursive: true })
    cpSync(docsSource, tmp, {
      recursive: true,
      // Skip the internals/ subtree (matches package.json files exclusion).
      // Returning false for a directory skips its whole subtree.
      filter: src => {
        const rel = relative(docsSource, src)
        return rel !== 'internals' && !rel.startsWith(`internals${sep}`)
      },
    })
    // Atomic swap: drop the old tree only after the fresh copy is fully staged,
    // so stale (removed-in-newer-version) docs are pruned and a reader never sees
    // a partial tree.
    rmSync(dest, { recursive: true, force: true })
    renameSync(tmp, dest)
    return { copied: true, dest }
  } catch (e) {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
    return { copied: false, dest, reason: e instanceof Error ? e.message : String(e) }
  }
}
