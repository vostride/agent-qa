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
      execFileSync: (cmd, args, options) => calls.push([cmd, args, options.cwd, options.env]),
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
    await runPublishCli(['--staged-dir', '.release/staged-packages'], {
      rootDir,
      env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' },
      npmVersion: '11.6.1',
      execFileSync: (cmd, args, options) => calls.push([cmd, args, options.cwd]),
    })
    assert.equal(calls.length, publicPackageNames.length)

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
