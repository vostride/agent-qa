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

function fixtureDir(name, pluginNames) {
  const dirName = name === 'agent-qa' ? 'cli' : name.replace('@vostride/agent-qa-', '')
  return join(pluginNames.includes(name) ? 'plugins' : 'packages', dirName)
}

function writePackageFixture(rootDir, version = '0.1.1', pluginNames = []) {
  for (const name of publicPackageNames) {
    const dir = join(rootDir, fixtureDir(name, pluginNames))
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
  createReleaseCommitAndTag('0.1.1', ['packages/cli/package.json', 'plugins/acme/package.json'], {
    execFileSync: (cmd, args) => calls.push([cmd, args]),
  })

  assert.deepEqual(calls, [
    ['git', ['config', 'user.name', 'github-actions[bot]']],
    ['git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']],
    ['git', ['add', '--', 'packages/cli/package.json', 'plugins/acme/package.json']],
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

test('commit-tag stages the manifest of every public package from packages/ and plugins/', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-qa-release-git-roots-'))
  try {
    const pluginNames = [publicPackageNames[0]]
    writePackageFixture(fixtureRoot, '0.1.1', pluginNames)
    const calls = []
    await runGitCli(['--commit-tag'], {
      rootDir: fixtureRoot,
      execFileSync: (cmd, args) => calls.push([cmd, args]),
    })

    const add = calls.find(([, args]) => args[0] === 'add')
    assert.deepEqual(add, [
      'git',
      ['add', '--', ...publicPackageNames.map(name => join(fixtureDir(name, pluginNames), 'package.json'))],
    ])
    assert.ok(add[1].includes(join('plugins', 'ids', 'package.json')))
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
