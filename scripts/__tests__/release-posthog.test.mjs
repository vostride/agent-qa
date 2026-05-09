import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  parseReleaseArgs as parsePosthogArgs,
  redactSecret,
  renderPosthogProjectFile,
  runCli as runPosthogCli,
  validatePosthogReleaseArtifacts,
} from '../release/posthog.mjs'

function createPosthogFixture(rootDir, distKey = 'phc_test_key', packagePath = 'packages/core') {
  const sourceDir = join(rootDir, packagePath, 'src/analytics')
  const distDir = join(rootDir, packagePath, 'dist')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(distDir, { recursive: true })
  writeFileSync(
    join(sourceDir, 'service.ts'),
    'import { NoopAnalyticsTransport } from "./transport.js"\nexport const marker = "noop transport stays local"\n',
  )
  const runtimeText = `var AGENT_QA_POSTHOG_KEY = "${distKey}"\nvar AGENT_QA_POSTHOG_HOST = "https://us.i.posthog.com"\n`
  writeFileSync(join(distDir, 'index.js'), runtimeText)
  writeFileSync(join(distDir, 'index.cjs'), runtimeText)
}

test('renders and redacts POSTHOG_PROJECT_KEY safely', () => {
  assert.equal(
    renderPosthogProjectFile('phc_test_key'),
    'export const AGENT_QA_POSTHOG_KEY = "phc_test_key"\nexport const AGENT_QA_POSTHOG_HOST = "https://us.i.posthog.com"\n',
  )
  const escapedKey = 'phc_"quoted"\\key\nnext'
  assert.equal(
    renderPosthogProjectFile(escapedKey),
    `export const AGENT_QA_POSTHOG_KEY = ${JSON.stringify(escapedKey)}\nexport const AGENT_QA_POSTHOG_HOST = ${JSON.stringify('https://us.i.posthog.com')}\n`,
  )
  assert.throws(() => renderPosthogProjectFile(''), /POSTHOG_PROJECT_KEY is required/)
  assert.equal(redactSecret('phc_test_key'), '[redacted POSTHOG_PROJECT_KEY]')
})

test('validates built PostHog release artifacts and raw secret leakage', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-posthog-'))
  try {
    createPosthogFixture(rootDir)
    assert.doesNotThrow(() => validatePosthogReleaseArtifacts({ rootDir, projectKey: 'phc_test_key', logText: 'safe [redacted POSTHOG_PROJECT_KEY]' }))
    assert.throws(() => validatePosthogReleaseArtifacts({ rootDir, projectKey: 'phc_test_key', logText: 'unsafe phc_test_key' }), /raw POSTHOG_PROJECT_KEY leaked/)

    createPosthogFixture(rootDir, '')
    assert.throws(() => validatePosthogReleaseArtifacts({ rootDir, projectKey: 'phc_test_key' }), /PostHog dist key is empty/)

    createPosthogFixture(rootDir, 'phc_wrong_key')
    assert.throws(() => validatePosthogReleaseArtifacts({ rootDir, projectKey: 'phc_test_key' }), /PostHog dist key does not match/)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('validates staged core package PostHog runtime artifacts', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-posthog-staged-root-'))
  const stagedDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-posthog-staged-packages-'))
  try {
    createPosthogFixture(rootDir)
    createPosthogFixture(stagedDir, 'phc_test_key', 'core')
    assert.doesNotThrow(() => validatePosthogReleaseArtifacts({ rootDir, stagedDir, projectKey: 'phc_test_key' }))

    createPosthogFixture(stagedDir, '', 'core')
    assert.throws(() => validatePosthogReleaseArtifacts({ rootDir, stagedDir, projectKey: 'phc_test_key' }), /PostHog dist key is empty/)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
    await rm(stagedDir, { recursive: true, force: true })
  }
})

test('parses and dispatches node scripts/release/posthog.mjs --write', async () => {
  assert.deepEqual(parsePosthogArgs(['--write']), { mode: 'write' })
  assert.throws(() => parsePosthogArgs([]), /missing --write/)
  assert.throws(() => parsePosthogArgs(['--write', '--bad']), /invalid args/)

  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-posthog-write-'))
  try {
    await runPosthogCli(['--write'], {
      rootDir,
      env: { POSTHOG_PROJECT_KEY: 'phc_test_key' },
      log: () => {},
    })
    const target = join(rootDir, 'packages/core/src/analytics/posthog-project.ts')
    assert.equal(existsSync(target), true)
    assert.match(readFileSync(target, 'utf8'), /AGENT_QA_POSTHOG_KEY = "phc_test_key"/)
    assert.match(readFileSync(target, 'utf8'), /AGENT_QA_POSTHOG_HOST = "https:\/\/us\.i\.posthog\.com"/)

    await assert.rejects(runPosthogCli(['--write'], { rootDir, env: {}, log: () => {} }), /POSTHOG_PROJECT_KEY is required/)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
