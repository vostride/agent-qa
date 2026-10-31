import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadWorkflow } from '../check-ci-matrix.mjs'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readWorkflow(file = 'release.yml') {
  const workflowPath = join(rootDir, `.github/workflows/${file}`)
  assert.ok(existsSync(workflowPath), 'Release workflow file is missing: .github/workflows/release.yml')
  return readFileSync(workflowPath, 'utf8')
}

function assertBefore(text, before, after) {
  const beforeIndex = text.indexOf(before)
  const afterIndex = text.indexOf(after)
  assert.notEqual(beforeIndex, -1, `Expected workflow to contain ${before}`)
  assert.notEqual(afterIndex, -1, `Expected workflow to contain ${after}`)
  assert.ok(beforeIndex < afterIndex, `Expected ${before} before ${after}`)
}

test('release workflow is manual-only with patch/minor bump choices', () => {
  const workflow = readWorkflow()

  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|release|schedule):/m)
  assert.match(workflow, /bump:/)
  assert.match(workflow, /type:\s*choice/)
  assert.match(workflow, /options:\s*\n(?:\s+-\s+\w+\s*\n)*\s+-\s+patch/)
  assert.match(workflow, /options:\s*\n(?:\s+-\s+\w+\s*\n)*\s+-\s+minor/)
  assert.match(workflow, /subscription_auth_target_version:/)
  assert.match(workflow, /github_release_target_version:/)
  assert.doesNotMatch(workflow, /-\s+major\b/)
})

test('release workflow uses trusted publishing prerequisites without npm tokens', () => {
  const workflow = readWorkflow()

  assert.match(workflow, /runs-on:\s*ubuntu-latest/)
  assert.match(workflow, /permissions:/)
  assert.match(workflow, /contents:\s*write/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /attestations:\s*write/)
  assert.match(workflow, /scripts\/release\/publish\.mjs/)
  assert.match(workflow, /SUBSCRIPTION_AUTH_RELEASE_TOKEN/)
  assert.match(
    workflow,
    /npm:\s*\n\s+name:\s*Publish npm packages[\s\S]*?- name:\s*Checkout\s*\n\s+uses:\s*actions\/checkout@v6\s*\n\s+with:\s*\n\s+fetch-depth:\s*0\s*\n\s+persist-credentials:\s*false\s*\n\s+- name:\s*Validate release push token\s*\n\s+env:\s*\n\s+RELEASE_PUSH_TOKEN:\s*\$\{\{ secrets\.RELEASE_PUSH_TOKEN \}\}/,
  )
  assert.match(workflow, /::error::Set RELEASE_PUSH_TOKEN in the vostride\/agent-qa repository Actions secrets\./)
  assert.match(
    workflow,
    /- name:\s*Push release commit and tag\s*\n\s+env:\s*\n\s+RELEASE_PUSH_TOKEN:\s*\$\{\{ secrets\.RELEASE_PUSH_TOKEN \}\}\s*\n(?:\s+[A-Z_]+:.*\n)*\s+run:/,
  )
  assert.doesNotMatch(workflow, /push origin/)
  assert.doesNotMatch(workflow, /NPM_TOKEN/)
  assert.doesNotMatch(workflow, /docker\/build-push-action|DOCKERHUB_TOKEN/)
})

test('release workflow gates build, staging, commit, tag, push, and publish in order', () => {
  const workflow = readWorkflow()
  const orderedCommands = [
    'uses: ./.github/workflows/ci.yml',
    'name: Publish npm packages',
    'persist-credentials: false',
    'if [ -z "$RELEASE_PUSH_TOKEN" ]; then',
    'name: Install pnpm',
    'uses: actions/setup-node@v6',
    'pnpm install --frozen-lockfile',
    'pnpm audit --prod --audit-level high',
    'pnpm exec node scripts/release/verify.mjs --bump "${{ inputs.bump }}" --stage preflight',
    'pnpm exec node scripts/release/version.mjs --bump "${{ inputs.bump }}" --write',
    'pnpm exec node scripts/release/posthog.mjs --write',
    'pnpm exec turbo build --force',
    'pnpm run validate:skills',
    'pnpm run validate:agents',
    'pnpm run validate:publish',
    'pnpm exec node scripts/release/stage-packages.mjs --target-version "${{ steps.version.outputs.version }}" --out .release/staged-packages',
    'pnpm exec node scripts/release/verify.mjs --bump "${{ inputs.bump }}" --stage postbuild --target-version "${{ steps.version.outputs.version }}" --staged-dir .release/staged-packages',
    'pnpm exec node scripts/release/git.mjs --commit-tag',
    'git -c credential.helper= -c \'credential.helper=!f() { echo username=x-access-token; echo "password=$RELEASE_PUSH_TOKEN"; }; f\' push --atomic https://github.com/${{ github.repository }}.git HEAD:refs/heads/${{ github.ref_name }} "refs/tags/v$RELEASE_VERSION"',
    'pnpm exec node scripts/release/publish.mjs --staged-dir .release/staged-packages',
  ]

  for (const command of orderedCommands) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (let index = 0; index < orderedCommands.length - 1; index += 1) {
    assertBefore(workflow, orderedCommands[index], orderedCommands[index + 1])
  }
})

test('release workflow writes the PostHog key after CI passed and before a forced build, and validates staged packages before publish', () => {
  const workflow = readWorkflow()
  const npm = loadWorkflow('release.yml').jobs.npm

  assert.match(workflow, /POSTHOG_PROJECT_KEY:\s*\$\{\{ secrets\.POSTHOG_PROJECT_KEY \}\}/)
  assert.ok([npm.needs].flat().includes('ci'))
  assert.match(npm.if, /needs\.ci\.result == 'success'/)
  assert.ok(npm.steps.some((step) => step.run === 'pnpm exec node scripts/release/posthog.mjs --write'))
  assertBefore(workflow, 'pnpm exec node scripts/release/posthog.mjs --write', 'pnpm exec turbo build --force')
  assertBefore(
    workflow,
    'pnpm exec node scripts/release/stage-packages.mjs --target-version "${{ steps.version.outputs.version }}" --out .release/staged-packages',
    'pnpm exec node scripts/release/verify.mjs --bump "${{ inputs.bump }}" --stage postbuild --target-version "${{ steps.version.outputs.version }}" --staged-dir .release/staged-packages',
  )
  assertBefore(
    workflow,
    'pnpm exec node scripts/release/verify.mjs --bump "${{ inputs.bump }}" --stage postbuild --target-version "${{ steps.version.outputs.version }}" --staged-dir .release/staged-packages',
    'pnpm exec node scripts/release/publish.mjs --staged-dir .release/staged-packages',
  )
})

test('release workflow publishes Docker from the release tag after npm publish', () => {
  const workflow = readWorkflow()

  assert.match(workflow, /outputs:\s*\n\s+version:\s*\$\{\{ steps\.version\.outputs\.version \}\}/)
  assert.match(workflow, /npm:\s*\n\s+name:\s*Publish npm packages\s*\n\s+needs:\s*ci\s*\n\s+if:\s*\$\{\{ !cancelled\(\) && inputs\.subscription_auth_target_version == '' && inputs\.github_release_target_version == '' && needs\.ci\.result == 'success' \}\}/)
  assert.match(workflow, /docker:\s*\n\s+name:\s*Publish Docker images/)
  assert.match(workflow, /docker:\s*\n\s+name:\s*Publish Docker images\s*\n\s+if:\s*\$\{\{ inputs\.subscription_auth_target_version == '' && inputs\.github_release_target_version == '' \}\}/)
  assert.match(workflow, /needs:\s*\n\s+- npm\s*\n\s+- subscription-auth/)
  assert.match(workflow, /uses:\s*\.\/\.github\/workflows\/docker-release\.yml/)
  assert.match(workflow, /ref:\s*v\$\{\{ needs\.npm\.outputs\.version \}\}/)
  assert.match(workflow, /move_latest:\s*true/)
  assert.match(workflow, /secrets:\s*inherit/)
  assertBefore(workflow, 'pnpm exec node scripts/release/publish.mjs --staged-dir .release/staged-packages', 'uses: ./.github/workflows/docker-release.yml')
})

test('release workflow publishes subscription auth from the main release version before Docker', () => {
  const workflow = readWorkflow()
  const orderedCommands = [
    'gh workflow run release.yml',
    '--repo vostride/agent-qa-subscription-auth',
    '-f target_version="$SUBSCRIPTION_AUTH_TARGET_VERSION"',
    'gh run list',
    'gh run watch "$run_id"',
    'uses: ./.github/workflows/docker-release.yml',
  ]

  assert.match(workflow, /subscription-auth:\s*\n\s+name:\s*Publish subscription auth/)
  assert.match(workflow, /if:\s*\$\{\{ always\(\) && inputs\.github_release_target_version == '' && \(inputs\.subscription_auth_target_version != '' \|\| needs\.npm\.result == 'success'\) \}\}/)
  assert.match(workflow, /SUBSCRIPTION_AUTH_TARGET_VERSION:\s*\$\{\{ inputs\.subscription_auth_target_version \|\| needs\.npm\.outputs\.version \}\}/)
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ secrets\.SUBSCRIPTION_AUTH_RELEASE_TOKEN \}\}/)
  assert.match(workflow, /Actions: read and write/)
  assert.doesNotMatch(workflow, /working-directory:\s*agent-qa-subscription-auth/)
  assert.match(workflow, /docker:\s*\n\s+name:\s*Publish Docker images\s*\n\s+if:\s*\$\{\{ inputs\.subscription_auth_target_version == '' && inputs\.github_release_target_version == '' \}\}\s*\n\s+needs:\s*\n\s+- npm\s*\n\s+- subscription-auth/)
  for (const command of orderedCommands) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (let index = 0; index < orderedCommands.length - 1; index += 1) {
    assertBefore(workflow, orderedCommands[index], orderedCommands[index + 1])
  }
})

test('release workflow publishes the GitHub Release after package and subscription-auth release', () => {
  const workflow = readWorkflow()
  const jobStart = workflow.indexOf('github-release:')
  assert.notEqual(jobStart, -1, 'expected github-release job')
  const job = workflow.slice(jobStart)

  assert.match(job, /github-release:\s*\n\s+name:\s*Publish GitHub release/)
  assert.match(job, /if:\s*\$\{\{ always\(\) && \(inputs\.github_release_target_version != '' \|\| \(inputs\.subscription_auth_target_version == '' && needs\.npm\.result == 'success' && needs\.subscription-auth\.result == 'success'\)\) \}\}/)
  assert.match(job, /needs:\s*\n\s+- npm\s*\n\s+- subscription-auth/)
  assert.doesNotMatch(job, /needs:\s*\n\s+- npm\s*\n\s+- subscription-auth\s*\n\s+- docker/)
  assert.match(job, /contents:\s*write/)
  assert.match(job, /uses:\s*actions\/checkout@v6/)
  assert.match(job, /ref:\s*v\$\{\{ inputs\.github_release_target_version \|\| needs\.npm\.outputs\.version \}\}/)
  assert.match(job, /node-version-file:\s*\.nvmrc/)
  assert.match(job, /pnpm install --frozen-lockfile/)
  assert.match(job, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/)
  assert.match(job, /GITHUB_RELEASE_TARGET_VERSION:\s*\$\{\{ inputs\.github_release_target_version \|\| needs\.npm\.outputs\.version \}\}/)
  assert.match(job, /node scripts\/release\/github-release\.mjs --version "\$GITHUB_RELEASE_TARGET_VERSION" --repo "\$\{\{ github\.repository \}\}"/)
  assert.doesNotMatch(job, /GITHUB_RELEASE_TOKEN|PAT|secrets\./)
})

test('release workflow can repair a missing GitHub Release for an existing version', () => {
  const workflow = readWorkflow()

  assert.match(workflow, /github_release_target_version:\s*\n\s+description:\s*Existing agent-qa version to publish only the GitHub Release/)
  assert.match(workflow, /npm:\s*\n\s+name:\s*Publish npm packages\s*\n\s+needs:\s*ci\s*\n\s+if:\s*\$\{\{ !cancelled\(\) && inputs\.subscription_auth_target_version == '' && inputs\.github_release_target_version == '' &&/)
  assert.match(workflow, /subscription-auth:\s*\n\s+name:\s*Publish subscription auth\s*\n\s+needs:\s*npm\s*\n\s+if:\s*\$\{\{ always\(\) && inputs\.github_release_target_version == ''/)
  assert.match(workflow, /docker:\s*\n\s+name:\s*Publish Docker images\s*\n\s+if:\s*\$\{\{ inputs\.subscription_auth_target_version == '' && inputs\.github_release_target_version == '' \}\}/)
  assert.match(workflow, /github-release:\s*\n\s+name:\s*Publish GitHub release\s*\n\s+if:\s*\$\{\{ always\(\) && \(inputs\.github_release_target_version != ''/)
  assert.match(workflow, /github-release:\s*\n\s+name:\s*Publish GitHub release[\s\S]*?needs:\s*\n\s+- npm\s*\n\s+- subscription-auth/)
  assert.match(workflow, /ref:\s*v\$\{\{ inputs\.github_release_target_version \|\| needs\.npm\.outputs\.version \}\}/)
  assert.match(workflow, /GITHUB_RELEASE_TARGET_VERSION:\s*\$\{\{ inputs\.github_release_target_version \|\| needs\.npm\.outputs\.version \}\}/)
})

test('release npm and GitHub release jobs take Node from .nvmrc and pnpm from a commit-pinned pnpm/action-setup, with no cache', () => {
  const workflow = readWorkflow()
  const { jobs } = loadWorkflow('release.yml')

  for (const id of ['npm', 'github-release']) {
    const steps = jobs[id].steps
    const pnpmIndex = steps.findIndex((step) => String(step.uses ?? '').startsWith('pnpm/action-setup@'))
    const nodeIndex = steps.findIndex((step) => String(step.uses ?? '').startsWith('actions/setup-node@'))
    assert.ok(pnpmIndex !== -1 && nodeIndex !== -1 && pnpmIndex < nodeIndex, `${id} installs pnpm before Node`)
    assert.match(steps[pnpmIndex].uses, /^pnpm\/action-setup@[0-9a-f]{40}$/)
    assert.equal(steps[pnpmIndex].with, undefined)
    assert.equal(steps[nodeIndex].with['node-version-file'], '.nvmrc')
    assert.equal(steps[nodeIndex].with['node-version'], undefined)
    assert.equal(steps[nodeIndex].with.cache, undefined)
    assert.ok(steps.every((step) => !String(step.uses ?? '').startsWith('actions/cache')), `${id} restores no cache`)
  }
  for (const line of workflow.split('\n').filter((text) => text.includes('pnpm/action-setup@'))) {
    assert.match(line, /pnpm\/action-setup@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  }
  assert.doesNotMatch(workflow, /corepack/i)
})

test('a release calls CI with read-only contents and no secrets, and publishes npm only after CI succeeded', () => {
  const release = loadWorkflow('release.yml')
  const ci = loadWorkflow('ci.yml')

  assert.equal(release.jobs.ci.uses, './.github/workflows/ci.yml')
  assert.deepEqual(release.jobs.ci.permissions, { contents: 'read' })
  assert.equal(release.jobs.ci.secrets, undefined)
  assert.ok('workflow_call' in ci.on)
  assert.deepEqual(ci.permissions, { contents: 'read' })
  for (const [id, job] of Object.entries(ci.jobs)) {
    assert.ok(!job.permissions || !('id-token' in job.permissions), `ci.yml job ${id} asks for no id-token`)
  }
  assert.ok([release.jobs.npm.needs].flat().includes('ci'))
  assert.match(release.jobs.npm.if, /needs\.ci\.result == 'success'/)
})

test('no release job runs a test, a typecheck or a browser install, and none downloads a build artifact', () => {
  const release = loadWorkflow('release.yml')
  const forbidden = /\b(pnpm|turbo)\b[^\n]*\b(test|typecheck)\b|playwright(-core)? install|apt-get install/

  for (const [id, job] of Object.entries(release.jobs)) {
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(String(step.run ?? ''), forbidden, `${id}: ${step.name}`)
      assert.ok(!String(step.uses ?? '').startsWith('actions/download-artifact'), `${id}: ${step.name}`)
    }
  }
})

test('docker release workflow is manual and reusable with Docker Hub preflight', () => {
  const workflow = readWorkflow('docker-release.yml')

  assert.match(workflow, /name:\s*Docker Release/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /workflow_call:/)
  assert.match(workflow, /ref:/)
  assert.match(workflow, /move_latest:/)
  assert.match(workflow, /default:\s*true/)
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|release|schedule):/m)
  assert.match(workflow, /contents:\s*read/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /attestations:\s*write/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /scripts\/release\/docker\.mjs --check-tags --require-env --github-output/)
  assert.match(workflow, /DOCKERHUB_USERNAME:\s*\$\{\{ vars\.DOCKERHUB_USERNAME \}\}/)
  assert.match(workflow, /DOCKERHUB_NAMESPACE:\s*\$\{\{ vars\.DOCKERHUB_NAMESPACE \}\}/)
  assert.match(workflow, /DOCKERHUB_TOKEN:\s*\$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/)
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.ref \|\| github\.ref \}\}/)
})

test('docker release workflow uses official Docker actions with metadata and attestations', () => {
  const workflow = readWorkflow('docker-release.yml')

  assert.match(workflow, /docker\/login-action@v4/)
  assert.match(workflow, /docker\/setup-qemu-action@v4/)
  assert.match(workflow, /docker\/setup-buildx-action@v4/)
  assert.match(workflow, /docker\/metadata-action@v6/)
  assert.match(workflow, /docker\/build-push-action@v7/)
  assert.match(workflow, /file:\s*\$\{\{ matrix\.image\.dockerfile \}\}/)
  assert.match(workflow, /platforms:\s*\$\{\{ matrix\.image\.platforms \}\}/)
  assert.match(workflow, /type=raw,value=\$\{\{ needs\.preflight\.outputs\.version \}\}/)
  assert.match(workflow, /type=raw,value=v\$\{\{ needs\.preflight\.outputs\.version \}\}/)
  assert.match(workflow, /org\.opencontainers\.image\.title=\$\{\{ matrix\.image\.title \}\}/)
  assert.match(workflow, /org\.opencontainers\.image\.description=\$\{\{ matrix\.image\.description \}\}/)
  assert.match(workflow, /org\.opencontainers\.image\.version=\$\{\{ needs\.preflight\.outputs\.version \}\}/)
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/)
  assert.match(workflow, /org\.opencontainers\.image\.source=\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}/)
  assert.match(workflow, /org\.opencontainers\.image\.licenses=FSL-1\.1-ALv2/)
  assert.match(workflow, /provenance:\s*mode=max/)
  assert.match(workflow, /sbom:\s*true/)
  assert.match(workflow, /build-args:\s*\$\{\{ matrix\.image\.buildArgs \}\}/)
  assert.doesNotMatch(workflow, /secret-envs:|secret-files:/)
})

test('docker release preflight takes Node from .nvmrc and pnpm from a commit-pinned pnpm/action-setup', () => {
  const workflow = readWorkflow('docker-release.yml')
  const preflight = workflow.slice(workflow.indexOf('\n  preflight:\n'), workflow.indexOf('\n  docker:\n'))

  assert.match(preflight, /uses: pnpm\/action-setup@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/)
  assert.doesNotMatch(preflight, /pnpm\/action-setup@[^\n]*\n\s+with:/)
  assertBefore(preflight, 'uses: pnpm/action-setup@', 'uses: actions/setup-node@')
  assert.match(preflight, /uses: actions\/setup-node@v6\n\s+with:\n\s+node-version-file: \.nvmrc\n/)
  assert.doesNotMatch(workflow, /corepack|node-version:/)
})

test('docker release workflow builds only the images Docker Hub lacks', () => {
  const workflow = readWorkflow('docker-release.yml')

  assert.match(workflow, /build:\s*\$\{\{ steps\.docker\.outputs\.build \}\}/)
  assert.match(workflow, /retag:\s*\$\{\{ steps\.docker\.outputs\.retag \}\}/)
  assert.match(
    workflow,
    /\n  docker:\n[\s\S]*?needs: preflight\n\s+if: \$\{\{ needs\.preflight\.outputs\.build != '\[\]' \}\}\n[\s\S]*?image: \$\{\{ fromJson\(needs\.preflight\.outputs\.build\) \}\}\n/,
  )
})

test('docker release workflow adds a half-pushed image\'s missing version tag from its present one', () => {
  const workflow = readWorkflow('docker-release.yml')

  assert.match(
    workflow,
    /\n  retag:\n\s+name: Add missing version tag for \$\{\{ matrix\.retag\.image \}\}\n[\s\S]*?needs: preflight\n\s+if: \$\{\{ needs\.preflight\.outputs\.retag != '\[\]' \}\}\n[\s\S]*?retag: \$\{\{ fromJson\(needs\.preflight\.outputs\.retag\) \}\}\n/,
  )
  assert.match(workflow, /docker buildx imagetools create -t "\$\{\{ matrix\.retag\.image \}\}:\$\{\{ matrix\.retag\.missing \}\}" "\$\{\{ matrix\.retag\.image \}\}:\$\{\{ matrix\.retag\.present \}\}"/)
})

test('docker release workflow moves latest for all six images once the builds and retags succeeded or were skipped', () => {
  const workflow = readWorkflow('docker-release.yml')
  const latest = workflow.slice(workflow.indexOf('\n  latest:\n'))

  assert.match(latest, /needs:\s*\[preflight, docker, retag\]/)
  assert.ok(
    latest.includes(`if: \${{ !cancelled() && inputs.move_latest && needs.preflight.result == 'success' && contains(fromJSON('["success","skipped"]'), needs.docker.result) && contains(fromJSON('["success","skipped"]'), needs.retag.result) }}`),
    'latest must wait for preflight success and for the docker and retag jobs to succeed or be skipped',
  )
  assert.match(latest, /image: \$\{\{ fromJson\(needs\.preflight\.outputs\.images\) \}\}/)
  assert.match(latest, /docker buildx imagetools create -t "\$\{\{ matrix\.image\.image \}\}:latest" "\$\{\{ matrix\.image\.image \}\}:\$\{\{ needs\.preflight\.outputs\.version \}\}"/)
})
