import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { publicPackageNames } from '../release/packages.mjs'
import {
  buildReleaseGatePlan,
  parseReleaseArgs as parseVerifyArgs,
  runCli as runVerifyCli,
  runReleaseVerification,
  validateStagedPackDryRuns,
} from '../release/verify.mjs'

function createPackage(rootDir, name, version = '0.1.1') {
  const dir = join(rootDir, name.replace('@vostride/', '').replaceAll('/', '-'))
  mkdirSync(dir, { recursive: true })
  const dependencies = name === '@vostride/agent-qa-core' ? { '@vostride/agent-qa-ids': version } : {}
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    private: false,
    files: name === 'agent-qa' ? ['dist', 'skills', 'LICENSE.md', 'NOTICE.md'] : ['dist', 'LICENSE.md', 'NOTICE.md'],
    exports: name === '@vostride/agent-qa-dashboard-ui' ? undefined : { '.': { import: './dist/index.js' } },
    dependencies,
  }, null, 2))
  return dir
}

function createStagedFixture(rootDir, version = '0.1.1') {
  const stagedDir = join(rootDir, '.release/staged-packages')
  const dirs = new Map()
  for (const name of publicPackageNames) dirs.set(name, createPackage(stagedDir, name, version))
  return { stagedDir, dirs }
}

test('builds the fail-closed release gate plan in exact order with no Docker publish', () => {
  assert.deepEqual(buildReleaseGatePlan('patch'), [
    'pnpm install --frozen-lockfile',
    'release preflight',
    'write shared version',
    'write posthog project key',
    'pnpm typecheck',
    'pnpm test',
    'pnpm build',
    'pnpm run validate:skills',
    'pnpm run validate:publish',
    'stage packages',
    'release postbuild verification',
    'create release commit and tag',
    'git push',
    'npm publish',
  ])
  assert.equal(buildReleaseGatePlan('patch').some(label => /docker/i.test(label)), false)
})

test('parses preflight and postbuild verify CLI args', () => {
  assert.deepEqual(parseVerifyArgs(['--bump', 'patch', '--stage', 'preflight']), { bump: 'patch', stage: 'preflight' })
  assert.deepEqual(
    parseVerifyArgs(['--bump', 'patch', '--stage', 'postbuild', '--target-version', '0.1.1', '--staged-dir', '.release/staged-packages']),
    { bump: 'patch', stage: 'postbuild', targetVersion: '0.1.1', stagedDir: '.release/staged-packages' },
  )
  assert.throws(() => parseVerifyArgs(['--bump', 'patch', '--stage', 'publish']), /invalid args/)
  assert.throws(() => parseVerifyArgs(['--stage', 'preflight']), /missing --bump/)
  assert.throws(() => parseVerifyArgs(['--bump', 'patch', '--stage', 'postbuild', '--target-version', '0.1.1']), /missing --staged-dir/)
})

test('validates staged pack dry-runs from .release/staged-packages with exact internal versions', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-verify-pack-'))
  try {
    const { stagedDir } = createStagedFixture(rootDir)
    const calls = []
    validateStagedPackDryRuns({
      stagedDir,
      targetVersion: '0.1.1',
      execFileSync: (cmd, args, options) => {
        calls.push([cmd, args, options.cwd])
        const manifest = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8'))
        const files = [
          { path: 'package.json' },
          { path: 'LICENSE.md' },
          { path: 'NOTICE.md' },
          { path: 'dist/index.js' },
          ...(manifest.name === 'agent-qa' ? [{ path: 'skills/agent-qa-authoring/SKILL.md' }] : []),
        ]
        return JSON.stringify([{ files }])
      },
    })

    assert.equal(calls.length, publicPackageNames.length)
    assert.ok(calls.every(([cmd, args, cwd]) => cmd === 'npm' && args.join(' ') === 'pack --dry-run --json' && cwd.startsWith(stagedDir)))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('postbuild verification runs staged pack dry-runs before any release mutation action', async () => {
  const calls = []
  await runReleaseVerification({
    stage: 'postbuild',
    bump: 'patch',
    targetVersion: '0.1.1',
    stagedDir: '.release/staged-packages',
    validatePublishSurface: () => calls.push('validate publish surface'),
    validateStagedPackageManifests: () => calls.push('validate staged manifests'),
    validatePosthogReleaseArtifacts: () => calls.push('validate posthog'),
    validateStagedPackDryRuns: () => calls.push('npm pack dry-run'),
    assertTrustedPublishEnvironment: () => calls.push('trusted publish env'),
  })

  assert.deepEqual(calls, [
    'validate publish surface',
    'validate staged manifests',
    'validate posthog',
    'npm pack dry-run',
    'trusted publish env',
  ])
  assert.equal(calls.includes('create release commit and tag'), false)
  assert.equal(calls.includes('git push'), false)
  assert.equal(calls.includes('npm publish'), false)
})

test('postbuild verification checks the actual npm version before release mutation', async () => {
  const baseOptions = {
    stage: 'postbuild',
    bump: 'patch',
    targetVersion: '0.1.1',
    stagedDir: '.release/staged-packages',
    env: { POSTHOG_PROJECT_KEY: 'phc_test_key', GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' },
    validatePublishSurface: () => {},
    validateStagedPackageManifests: () => {},
    validatePosthogReleaseArtifacts: () => {},
    validateStagedPackDryRuns: () => {},
  }
  const calls = []
  await runReleaseVerification({
    ...baseOptions,
    execFileSync: (cmd, args) => {
      calls.push([cmd, args])
      return '11.5.1\n'
    },
  })
  assert.deepEqual(calls, [['npm', ['--version']]])

  await assert.rejects(runReleaseVerification({
    ...baseOptions,
    execFileSync: () => '11.4.0\n',
  }), /npm CLI >=11\.5\.1/)
})

test('preflight verification checks bump, git tag, npm registry, and POSTHOG_PROJECT_KEY', async () => {
  const calls = []
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-verify-preflight-'))
  try {
    const packagesRoot = join(rootDir, 'packages')
    for (const name of publicPackageNames) {
      const dirName = name === 'agent-qa' ? 'cli' : name.replace('@vostride/agent-qa-', '')
      const dir = join(packagesRoot, dirName)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.0', private: false }, null, 2))
    }
    await runVerifyCli(['--bump', 'patch', '--stage', 'preflight'], {
      rootDir,
      env: { POSTHOG_PROJECT_KEY: 'phc_test_key' },
      checkGitTagAbsent: (version) => calls.push(`git ${version}`),
      checkNpmVersionsAbsent: (packages, version) => calls.push(`npm ${packages.length} ${version}`),
    })
    assert.deepEqual(calls, ['git 0.1.1', 'npm 9 0.1.1'])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
