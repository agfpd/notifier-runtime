import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { PERSONALITY } from './constants.ts'

// Resolve which primitive this notifier session is running as.
//
// One session = one primitive: the timer
// (Scheduler) and the watcher (Supervisor) are DIFFERENT peers/sessions
// with different IAP identities (`notifier-timer` vs `notifier-watcher`). The
// run-session must NOT mix primitives — `cli.run` dispatches on the resolved
// personality. We never default to "do both".
//
// Resolution order (first hit wins):
//   1. env.PEER_PERSONALITY — explicit override, also what launchd/iap inject
//      into the run session so the spawned watcher/timer carries its identity.
//   2. <cwd>/.iapeer/peer-profile.json `personality` — the registered identity
//      of the peer whose cwd this session runs in.
//   3. PERSONALITY constant ('timer') — backward-compatible fallback so a bare
//      `notifier-runtime run` in an un-provisioned cwd behaves like the timer.
//
// Reads are injectable so tests can drive resolution without touching disk.
export interface ResolvePersonalityOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  // <cwd>/.iapeer/peer-profile.json by default.
  profilePathFor?: (cwd: string) => string
  readFile?: (path: string) => string
  fileExists?: (path: string) => boolean
}

function defaultProfilePath(cwd: string): string {
  return join(cwd, '.iapeer', 'peer-profile.json')
}

export function resolvePersonality(opts: ResolvePersonalityOptions = {}): string {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const profilePathFor = opts.profilePathFor ?? defaultProfilePath
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'))
  const fileExists = opts.fileExists ?? ((p: string) => existsSync(p))

  const fromEnv = env.PEER_PERSONALITY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv
  }

  const profilePath = profilePathFor(cwd)
  if (fileExists(profilePath)) {
    try {
      const profile = JSON.parse(readFile(profilePath))
      const fromProfile = profile?.personality
      if (typeof fromProfile === 'string' && fromProfile.length > 0) {
        return fromProfile
      }
    } catch {
      // Unreadable / malformed profile → fall through to the default. The CLI
      // logs its resolved identity at startup, so a wrong fallback is visible
      // there; we do not crash identity resolution on a bad profile file.
    }
  }

  return PERSONALITY
}
