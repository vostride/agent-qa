import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  checkGitTagAbsent,
  createReleaseCommitAndTag,
  parseReleaseArgs as parseGitArgs,
  runCli as runGitCli,
} from '../release/git.mjs'
import { publicPackageNames } from '../release/packages.mjs'

function writePackageFixture(rootDir, version = '0.1.1') {
  for (const name of publicPackageNames) {
    const dirName = name === 'agent-qa' ? 'cli' : name.replace('@vostride/agent-qa-', '')
    const dir = join(rootDir, 'packages', dirName)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, private: false }, null, 2))
  }
}

test('checks deterministic v-prefixed release tags before mutation', () => {
  assert.throws(
    () => checkGitTagAbsent('0.1.1', { execFileSync: () => 'v0.1.1' }),
    /git tag already exists: v0\.1\.1/,
  )

  assert.doesNotThrow(() => checkGitTagAbsent('0.1.1', {
    execFileSync: () => {
      const error = new Error('missing tag')
      error.status = 1
      throw error
    },
  }))

  assert.throws(() => checkGitTagAbsent('0.1.1', {
    execFileSync: () => {
      const error = new Error('not a git repository')
      error.status = 128
      throw error
    },
  }), /could not verify git tag absence: v0\.1\.1/)
})

test('creates deterministic release commit and annotated tag without git push', () => {
  const calls = []
  createReleaseCommitAndTag('0.1.1', {
    execFileSync: (cmd, args) => calls.push([cmd, args]),
  })

  assert.deepEqual(calls, [
    ['git', ['config', 'user.name', 'github-actions[bot]']],
    ['git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']],
    ['git', ['add', '--', 'packages/*/package.json']],
    ['git', ['commit', '-m', 'release: agent-qa v0.1.1']],
    ['git', ['tag', '-a', 'v0.1.1', '-m', 'agent-qa v0.1.1']],
  ])
  assert.equal(JSON.stringify(calls).includes('git push'), false)
})

test('parses and dispatches node scripts/release/git.mjs --commit-tag', async () => {
  assert.deepEqual(parseGitArgs(['--commit-tag']), { mode: 'commit-tag' })
  assert.throws(() => parseGitArgs(['--commit-tag', '--push']), /invalid args/)

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-qa-release-git-'))
  try {
    writePackageFixture(fixtureRoot)
    const calls = []
    await runGitCli(['--commit-tag'], {
      rootDir: fixtureRoot,
      execFileSync: (cmd, args) => calls.push([cmd, args]),
    })

    assert.equal(calls.some(([cmd, args]) => cmd === 'git' && args.includes('push')), false)
    assert.deepEqual(calls.at(-1), ['git', ['tag', '-a', 'v0.1.1', '-m', 'agent-qa v0.1.1']])
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('fails commit-tag dispatch when shared version state is missing', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-qa-release-git-missing-'))
  try {
    await assert.rejects(runGitCli(['--commit-tag'], { rootDir: fixtureRoot, execFileSync: () => {} }), /public package/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
