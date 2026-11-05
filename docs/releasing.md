# Maintainer release handoff

Publication is **manual and accepted-archive gated**. A tag push does not publish.
`Publish` requires an existing version tag and the lowercase SHA256 of the accepted
`.tgz`, packs that tag, checks the hash, runs the packaged native proof outside the
checkout, and publishes that exact file. It then checks registry SHA512 integrity.

## Prepare the candidate

Run tests and typecheck, commit, and create a version tag matching package.json.
Use a clean checkout of that tag. Pack with **official Node 26.4.0 and npm 11.17.0**,
matching the pinned workflow tools:

```sh
mkdir -p /absolute/release-dir
npx -y -p node@26.4.0 -p npm@11.17.0 -c \
  'node --version && npm --version && npm pack --ignore-scripts --pack-destination /absolute/release-dir'
shasum -a 256 /absolute/release-dir/*.tgz
```

Homebrew Node can link a different zlib: identical tar contents need not yield
identical gzip bytes. The gate compares the **compressed archive**, not merely
its unpacked content. A mismatch requires investigating/rebuilding and reaccepting
the resulting archive, never bypassing the hash check.

Extract the candidate in a scratch directory and run:

```sh
bun package/scripts/proof-maintenance.ts --receipt /absolute/release-dir/proof.json
```

This proof runs real signed binaries and scripts with isolated runtime state and
a recording CLI, not the host fleet. It does not claim core/native acceptance.
Give the accepting operator the tag/commit, archive path, SHA256 and proof receipt.
Publication and host deployment are separate approvals.

## Verify or publish

After the tag exists on origin, an accepting operator can validate the full
workflow without publishing:

```sh
gh workflow run publish.yml -f tag=v0.6.3 -f sha256=ACCEPTED_SHA256 -F dry_run=true
```

Use the same command with `-F dry_run=false` only when publication is approved.
For mismatch testing, use dry-run and an intentionally wrong 64-digit hash:
the gate must fail before native proof/publication. Do not test by publishing an
unaccepted version. `dry_run` skips both publication and registry-integrity polling.

GitHub documents [manual dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch);
npm documents [publishing a tarball](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
