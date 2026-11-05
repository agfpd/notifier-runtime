import { expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'

const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8')) as any
const steps = workflow.jobs.publish.steps as { name?: string; run?: string; if?: string; env?: Record<string, string> }[]
const gate = steps.find(s => s.name === 'Pack and check the accepted sha256')!

test('publishing is manual, hash-gated, and publishes the checked archive only', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  expect(workflow.on.workflow_dispatch.inputs.sha256.required).toBe(true)
  expect(workflow.on.workflow_dispatch.inputs.dry_run.type).toBe('boolean')
  expect(workflow.env.NODE_VERSION).toBe('26.4.0')
  expect(workflow.env.NPM_VERSION).toBe('11.17.0')
  const publish = steps.find(s => s.name === 'Publish exactly the checked archive')!
  expect(steps.indexOf(publish)).toBeGreaterThan(steps.indexOf(gate))
  expect(publish.run).toBe('npm publish "$ARCHIVE" --access public --ignore-scripts')
  expect(publish.if).toBe('${{ !inputs.dry_run }}')
  const proof = steps.find(s => s.name === 'Native proof from the archive, outside the checkout')!
  expect(steps.indexOf(proof)).toBeGreaterThan(steps.indexOf(gate))
  expect(steps.indexOf(proof)).toBeLessThan(steps.indexOf(publish))
  expect(proof.run).toContain('bun install --production --ignore-scripts')
  expect(proof.run).toContain('bun scripts/proof-maintenance.ts')
  const dependencyGate = steps.find(s => s.name === 'Release core dependency is an exact registry version')!
  expect(steps.indexOf(dependencyGate)).toBeLessThan(steps.indexOf(gate))
  expect(dependencyGate.run).toContain('release requires exact registry @agfpd/iapeer')
  expect(steps.find(s => s.name === 'Registry integrity equals the published archive')!.if).toBe(publish.if)
})

for (const variant of ['matching', 'mismatched', 'malformed'] as const) {
  test(`actual workflow bash gate: ${variant} SHA256`, () => {
    const root = mkdtempSync(join(tmpdir(), 'notifier-publish-'))
    try {
      const archive = join(root, 'fixture.tgz'), output = join(root, 'github-env')
      writeFileSync(archive, 'immutable test archive bytes')
      const hash = createHash('sha256').update(readFileSync(archive)).digest('hex')
      const npm = join(root, 'npm')
      // Only the packer/version boundary is stubbed; the real workflow's bash
      // and shasum inspect real bytes. No registry command or credentials used.
      writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" fixture.tgz\n')
      chmodSync(npm, 0o755)
      const want = variant === 'matching' ? hash : variant === 'mismatched' ? '0'.repeat(64) : '$(touch forbidden)'
      const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', gate.run!], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, WANT: want, RUNNER_TEMP: root, GITHUB_ENV: output },
      })
      if (variant === 'matching') {
        expect(result.status).toBe(0)
        expect(readFileSync(output, 'utf8')).toBe(`ARCHIVE=${archive}\n`)
      } else {
        expect(result.status).not.toBe(0)
        expect(existsSync(output)).toBe(false)
      }
      expect(existsSync(join(root, 'forbidden'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

test('release dependency gate rejects git/local/range pins and allows exact registry pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'notifier-release-dep-'))
  try {
    const script = steps.find(s => s.name === 'Release core dependency is an exact registry version')!.run!
    for (const pin of [undefined, '0.4.165', 'git+https://github.com/agfpd/iapeer.git#95a0849', 'file:../iapeer', '^0.4.165']) {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: pin ? { '@agfpd/iapeer': pin } : {} }))
      const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: root, encoding: 'utf8' })
      expect(result.status === 0, result.stderr).toBe(pin === undefined || pin === '0.4.165')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
