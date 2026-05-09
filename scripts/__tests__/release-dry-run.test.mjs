import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildReleaseDryRunPlan,
  parseDryRunArgs,
  runCli as runDryRunCli,
} from '../release/dry-run.mjs'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const releaseGuide = 'agent-qa-subscription-auth/RELEASE.md'

test('builds a non-mutating patch release dry-run plan', () => {
  const plan = buildReleaseDryRunPlan({
    rootDir,
    bump: 'patch',
    projectKey: 'POSTHOG_TEST_PROJECT_KEY_PLACEHOLDER',
  })

  assert.equal(plan.dryRun, true)
  assert.equal(plan.mutatesExternalState, false)
  assert.equal(plan.writesFiles, false)
  assert.equal(plan.currentVersion, '0.1.0')
  assert.equal(plan.targetVersion, '0.1.1')
  assert.ok(plan.releaseGatePlan.includes('release preflight'))
  assert.ok(plan.releaseGatePlan.includes('npm publish'))
  assert.ok(plan.localValidation.some(command => command.includes('npm pack') || command.includes('verify.mjs --bump patch --stage postbuild')))
  assert.equal(plan.npm.trustedPublishing, true)
  assert.equal(plan.npm.usesNpmToken, false)
  assert.equal(plan.npm.publishCommands.at(-1).package, 'agent-qa')
  assert.equal(plan.npm.publishCommands.at(-1).command, 'npm publish --access public')
  assert.equal(plan.posthog.requiredSecret, 'POSTHOG_PROJECT_KEY')
  assert.match(plan.posthog.preview, /\[redacted POSTHOG_PROJECT_KEY\]/)
  assert.doesNotMatch(plan.posthog.preview, /POSTHOG_TEST_PROJECT_KEY_PLACEHOLDER/)
  assert.equal(plan.docker.images.length, 6)
  assert.ok(plan.docker.images.every(image => image.tags.includes(`${image.image}:0.1.1`)))
  assert.ok(plan.docker.images.every(image => image.tags.includes(`${image.image}:v0.1.1`)))
  assert.equal(plan.subscriptionAuth.package, '@vostride/agent-qa-subscription-auth')
  assert.equal(plan.subscriptionAuth.status, 'standalone_workflow_documented')
  assert.ok(plan.subscriptionAuth.note.includes(releaseGuide))
})

test('supports minor dry-run plans and optional latest Docker preview', () => {
  const plan = buildReleaseDryRunPlan({
    rootDir,
    bump: 'minor',
    latest: true,
  })

  assert.equal(plan.targetVersion, '0.2.0')
  assert.ok(plan.docker.images.every(image => image.tags.includes(`${image.image}:latest`)))
})

test('parses dry-run CLI args', () => {
  assert.deepEqual(parseDryRunArgs(['--bump', 'patch']), {
    bump: 'patch',
    json: false,
    latest: false,
  })
  assert.deepEqual(parseDryRunArgs(['--', '--bump', 'patch']), {
    bump: 'patch',
    json: false,
    latest: false,
  })
  assert.deepEqual(parseDryRunArgs(['--bump', 'minor', '--namespace', 'vostride', '--json', '--latest']), {
    bump: 'minor',
    namespace: 'vostride',
    json: true,
    latest: true,
  })
  assert.throws(() => parseDryRunArgs([]), /missing --bump/)
  assert.throws(() => parseDryRunArgs(['--bad']), /invalid args/)
  assert.throws(() => buildReleaseDryRunPlan({ rootDir, bump: 'major' }), /patch or minor/)
})

test('CLI renders human-readable and JSON dry-run output without leaking secrets', async () => {
  let textOutput = ''
  const textPlan = await runDryRunCli(['--bump', 'patch'], {
    rootDir,
    projectKey: 'POSTHOG_SECRET_FROM_TEST',
    output: { write: chunk => { textOutput += chunk } },
  })
  assert.equal(textPlan.targetVersion, '0.1.1')
  assert.match(textOutput, /agent-qa release dry-run/)
  assert.match(textOutput, /Mutates external state: no/)
  assert.match(textOutput, /npm publish --access public/)
  assert.match(textOutput, /standalone_workflow_documented/)
  assert.ok(textOutput.includes(releaseGuide))
  assert.doesNotMatch(textOutput, /POSTHOG_SECRET_FROM_TEST/)

  let jsonOutput = ''
  await runDryRunCli(['--bump', 'patch', '--json'], {
    rootDir,
    projectKey: 'POSTHOG_SECRET_FROM_TEST',
    output: { write: chunk => { jsonOutput += chunk } },
  })
  const parsed = JSON.parse(jsonOutput)
  assert.equal(parsed.targetVersion, '0.1.1')
  assert.equal(parsed.mutatesExternalState, false)
  assert.doesNotMatch(jsonOutput, /POSTHOG_SECRET_FROM_TEST/)
})
