import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  assertTrustedPublishEnvironment,
  createPublishCommands,
  parseReleaseArgs as parsePublishArgs,
  publishPackages,
  runCli as runPublishCli,
} from '../release/publish.mjs'
import { publicPackageNames } from '../release/packages.mjs'

function stagedRecord(name, rootDir) {
  const dir = join(rootDir, name.replace('@vostride/', '').replaceAll('/', '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.1', private: false }, null, 2))
  return { name, dir, pkg: { name, version: '0.1.1', private: false } }
}

const trustedEnv = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }

function npmError(stderr) {
  return Object.assign(new Error(`Command failed: npm\n${stderr}`), { status: 1, stderr })
}

function fakeNpm(present) {
  const publishedDirs = []
  const execFileSync = (cmd, args, options) => {
    if (args[0] === 'view') {
      const spec = args[1]
      if (present.has(spec.slice(0, spec.lastIndexOf('@')))) return '"0.1.1"'
      throw npmError('npm error code E404\nnpm error 404 No match found for version 0.1.1')
    }
    if (args[0] === 'publish') {
      publishedDirs.push(options.cwd)
      return null
    }
    throw new Error(`unexpected npm call: ${args.join(' ')}`)
  }
  return { execFileSync, publishedDirs }
}

async function withStagedPackages(run) {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-resume-'))
  try {
    const stagedDir = join(rootDir, '.release/staged-packages')
    const records = publicPackageNames.map(name => stagedRecord(name, stagedDir))
    await run({ rootDir, stagedDir, records })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

test('a partial publish resumes from the first package npm does not have, in publish order', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const present = new Set(publicPackageNames.slice(0, 3))
    const npm = fakeNpm(present)
    const lines = []
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: npm.execFileSync,
      log: line => lines.push(line),
    })

    assert.deepEqual(npm.publishedDirs, records.slice(3).map(record => record.dir))
    assert.deepEqual(result.skipped, publicPackageNames.slice(0, 3))
    assert.deepEqual(result.published, publicPackageNames.slice(3))
    for (const name of present) assert.ok(lines.includes(`already on npm: ${name}@0.1.1`))
  })
})

test('a version npm already has in full publishes nothing and succeeds', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir }) => {
    const npm = fakeNpm(new Set(publicPackageNames))
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: npm.execFileSync,
      log: () => {},
    })

    assert.deepEqual(npm.publishedDirs, [])
    assert.deepEqual(result.skipped, publicPackageNames)
    assert.deepEqual(result.published, [])
  })
})

test('a version npm does not have yet publishes every package in publish order', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const npm = fakeNpm(new Set())
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: npm.execFileSync,
      log: () => {},
    })

    assert.deepEqual(npm.publishedDirs, records.map(record => record.dir))
    assert.deepEqual(result.published, publicPackageNames)
    assert.deepEqual(result.skipped, [])
  })
})

test('creates trusted-publishing npm publish commands for every staged package', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-cmds-'))
  try {
    const stagedRecords = publicPackageNames.map(name => stagedRecord(name, rootDir))
    const commands = createPublishCommands({ stagedRecords, version: '0.1.1' })

    assert.equal(commands.length, publicPackageNames.length)
    assert.deepEqual(commands.map(command => command.cwd), stagedRecords.map(record => record.dir))
    for (const command of commands) {
      assert.equal(command.command, 'npm')
      assert.deepEqual(command.args, ['publish', '--access', 'public'])
      const text = JSON.stringify(command)
      assert.equal(text.includes('NPM_TOKEN'), false)
      assert.equal(text.includes('--tag latest'), false)
      assert.equal(/docker/i.test(text), false)
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('requires GitHub OIDC trusted-publishing environment and rejects token paths', () => {
  assert.doesNotThrow(() => assertTrustedPublishEnvironment({
    env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' },
    npmVersion: '11.5.1',
  }))
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true' }, npmVersion: '11.5.1' }), /ACTIONS_ID_TOKEN_REQUEST_TOKEN/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, npmVersion: '11.4.0' }), /npm CLI >=11\.5\.1/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, npmVersion: 'bad-version' }), /npm CLI >=11\.5\.1/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, npmVersion: '11.5.1' }), /GitHub Actions/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token', NPM_TOKEN: 'token' }, npmVersion: '11.5.1' }), /NPM_TOKEN/)
})

test('publishes from explicit .release/staged-packages and never source package directories', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-'))
  try {
    const stagedDir = join(rootDir, '.release/staged-packages')
    for (const name of publicPackageNames) stagedRecord(name, stagedDir)
    const calls = []
    await publishPackages({
      rootDir,
      stagedDir,
      env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token', NPM_CONFIG_PROVENANCE: 'false' },
      npmVersion: '11.6.1',
      execFileSync: (cmd, args, options) => {
        if (args[0] === 'view') throw npmError('npm error code E404')
        calls.push([cmd, args, options.cwd, options.env])
      },
      log: () => {},
    })

    assert.equal(calls.length, publicPackageNames.length)
    assert.ok(calls.every(([, , cwd]) => cwd.startsWith(stagedDir)))
    assert.ok(calls.every(([, , cwd]) => !cwd.includes('/packages/')))
    assert.ok(calls.every(([, , , env]) => !('NPM_CONFIG_PROVENANCE' in env)))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('parses and dispatches node scripts/release/publish.mjs --staged-dir .release/staged-packages', async () => {
  assert.deepEqual(parsePublishArgs(['--staged-dir', '.release/staged-packages']), { stagedDir: '.release/staged-packages' })
  assert.throws(() => parsePublishArgs([]), /missing --staged-dir/)
  assert.throws(() => parsePublishArgs(['--staged-dir', '.release/staged-packages', '--bad']), /invalid args/)

  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-cli-'))
  try {
    const stagedDir = join(rootDir, '.release/staged-packages')
    for (const name of publicPackageNames) stagedRecord(name, stagedDir)
    const calls = []
    const lines = []
    await runPublishCli(['--staged-dir', '.release/staged-packages'], {
      rootDir,
      env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' },
      npmVersion: '11.6.1',
      execFileSync: (cmd, args, options) => {
        if (args[0] === 'view') throw npmError('npm error code E404')
        calls.push([cmd, args, options.cwd])
      },
      log: line => lines.push(line),
    })
    assert.equal(calls.length, publicPackageNames.length)
    assert.ok(calls.every(([, args]) => args[0] === 'publish'))
    assert.deepEqual(lines, [`published: ${publicPackageNames.join(', ')}`, 'skipped: none'])

    await assert.rejects(
      runPublishCli(['--staged-dir', '.release/staged-packages'], {
        rootDir,
        env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token', NPM_TOKEN: 'token' },
        npmVersion: '11.6.1',
        execFileSync: () => {},
      }),
      /NPM_TOKEN/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
