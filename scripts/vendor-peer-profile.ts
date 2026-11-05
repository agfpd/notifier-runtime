// Bundle the accepted core leaf, never the core package's runtime dependency graph.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (Bun.version !== '1.3.13') throw new Error('vendor generation requires pinned Bun 1.3.13')
const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const check = process.argv.includes('--check')
const entry = 'node_modules/@agfpd/iapeer/src/identity/patchPeerProfile.ts'
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const dependency = pkg.devDependencies['@agfpd/iapeer'] as string
const installed = JSON.parse(readFileSync('node_modules/@agfpd/iapeer/package.json', 'utf8'))
const manifestPath = 'vendor/peer-profile.provenance.json'
const commitArg = process.argv.indexOf('--core-commit')
const coreCommit = dependency.match(/#([0-9a-f]{40})$/)?.[1]
  ?? (commitArg >= 0 ? process.argv[commitArg + 1] : check ? JSON.parse(readFileSync(manifestPath, 'utf8')).coreCommit : undefined)
if (!coreCommit || !/^[0-9a-f]{40}$/.test(coreCommit)) throw new Error('provide --core-commit <accepted full SHA> for registry generation')
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const work = mkdtempSync(join(tmpdir(), 'notifier-vendor-'))
try {
  const output = join(work, 'peer-profile.js')
  const result = spawnSync(process.execPath, ['build', entry, '--target', 'bun', '--outfile', output], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  const bytes = readFileSync(output)
  const manifest = {
    coreCommit, coreVersion: installed.version, dependency, bunVersion: Bun.version,
    protocol: 1, entrySha256: sha(readFileSync(entry)), bundleSha256: sha(bytes),
  }
  const json = JSON.stringify(manifest, null, 2) + '\n'
  if (check) {
    if (!bytes.equals(readFileSync('vendor/peer-profile.js')) || json !== readFileSync(manifestPath, 'utf8')) {
      throw new Error('vendored core leaf/provenance drift: regenerate and review before committing')
    }
  } else {
    mkdirSync('vendor', { recursive: true })
    writeFileSync('vendor/peer-profile.js', bytes)
    writeFileSync(manifestPath, json)
  }
  console.log(`vendor ${check ? 'verified' : 'generated'}: ${bytes.length} bytes, sha256 ${manifest.bundleSha256}`)
} finally { rmSync(work, { recursive: true, force: true }) }
