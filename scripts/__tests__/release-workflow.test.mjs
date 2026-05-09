import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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
  assert.doesNotMatch(workflow, /-\s+major\b/)
})

test('release workflow uses trusted publishing prerequisites without npm tokens', () => {
  const workflow = readWorkflow()

  assert.match(workflow, /runs-on:\s*ubuntu-latest/)
  assert.match(workflow, /node-version:\s*'24'/)
  assert.match(workflow, /permissions:/)
  assert.match(workflow, /contents:\s*write/)
  assert.match(workflow, /id-token:\s*write/)
  assert.match(workflow, /attestations:\s*write/)
  assert.match(workflow, /scripts\/release\/publish\.mjs/)
  assert.match(workflow, /SUBSCRIPTION_AUTH_RELEASE_TOKEN/)
  assert.doesNotMatch(workflow, /NPM_TOKEN/)
  assert.doesNotMatch(workflow, /docker\/build-push-action|DOCKERHUB_TOKEN/)
})

test('release workflow gates build, staging, commit, tag, push, and publish in order', () => {
  const workflow = readWorkflow()
  const orderedCommands = [
    'pnpm install --frozen-lockfile',
    'pnpm exec node scripts/release/verify.mjs --bump "${{ inputs.bump }}" --stage preflight',
    'pnpm exec node scripts/release/version.mjs --bump "${{ inputs.bump }}" --write',
    'pnpm exec node scripts/release/posthog.mjs --write',
    'pnpm typecheck',
    'pnpm test',
    'pnpm build',
    'pnpm run validate:skills',
    'pnpm run validate:agents',
    'pnpm run validate:publish',
    'pnpm exec node scripts/release/stage-packages.mjs --target-version "${{ steps.version.outputs.version }}" --out .release/staged-packages',
    'pnpm exec node scripts/release/verify.mjs --bump "${{ inputs.bump }}" --stage postbuild --target-version "${{ steps.version.outputs.version }}" --staged-dir .release/staged-packages',
    'pnpm exec node scripts/release/git.mjs --commit-tag',
    'git push origin HEAD:${{ github.ref_name }} --follow-tags',
    'pnpm exec node scripts/release/publish.mjs --staged-dir .release/staged-packages',
  ]

  for (const command of orderedCommands) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (let index = 0; index < orderedCommands.length - 1; index += 1) {
    assertBefore(workflow, orderedCommands[index], orderedCommands[index + 1])
  }
})

test('release workflow injects PostHog key before build and validates staged packages before publish', () => {
  const workflow = readWorkflow()

  assert.match(workflow, /POSTHOG_PROJECT_KEY:\s*\$\{\{ secrets\.POSTHOG_PROJECT_KEY \}\}/)
  assertBefore(workflow, 'pnpm exec node scripts/release/posthog.mjs --write', 'pnpm build')
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
  assert.match(workflow, /npm:\s*\n\s+name:\s*Publish npm packages\s*\n\s+if:\s*\$\{\{ inputs\.subscription_auth_target_version == '' \}\}/)
  assert.match(workflow, /docker:\s*\n\s+name:\s*Publish Docker images/)
  assert.match(workflow, /docker:\s*\n\s+name:\s*Publish Docker images\s*\n\s+if:\s*\$\{\{ inputs\.subscription_auth_target_version == '' \}\}/)
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
  assert.match(workflow, /if:\s*\$\{\{ always\(\) && \(inputs\.subscription_auth_target_version != '' \|\| needs\.npm\.result == 'success'\) \}\}/)
  assert.match(workflow, /SUBSCRIPTION_AUTH_TARGET_VERSION:\s*\$\{\{ inputs\.subscription_auth_target_version \|\| needs\.npm\.outputs\.version \}\}/)
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ secrets\.SUBSCRIPTION_AUTH_RELEASE_TOKEN \}\}/)
  assert.match(workflow, /Actions: read and write/)
  assert.doesNotMatch(workflow, /working-directory:\s*agent-qa-subscription-auth/)
  assert.match(workflow, /docker:\s*\n\s+name:\s*Publish Docker images\s*\n\s+if:\s*\$\{\{ inputs\.subscription_auth_target_version == '' \}\}\s*\n\s+needs:\s*\n\s+- npm\s*\n\s+- subscription-auth/)
  for (const command of orderedCommands) assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (let index = 0; index < orderedCommands.length - 1; index += 1) {
    assertBefore(workflow, orderedCommands[index], orderedCommands[index + 1])
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
  assert.match(workflow, /node-version:\s*'24'/)
  assert.match(workflow, /pnpm install --frozen-lockfile/)
  assert.match(workflow, /scripts\/release\/docker\.mjs --check-local --check-tags --require-env --github-output/)
  assert.match(workflow, /DOCKERHUB_USERNAME:\s*\$\{\{ vars\.DOCKERHUB_USERNAME \}\}/)
  assert.match(workflow, /DOCKERHUB_NAMESPACE:\s*\$\{\{ vars\.DOCKERHUB_NAMESPACE \}\}/)
  assert.match(workflow, /DOCKERHUB_TOKEN:\s*\$\{\{ secrets\.DOCKERHUB_TOKEN \}\}/)
  assert.match(workflow, /ref:\s*\$\{\{ inputs\.ref \|\| github\.ref \}\}/)
})

test('docker release workflow uses official Docker actions with metadata and attestations', () => {
  const workflow = readWorkflow('docker-release.yml')

  assert.match(workflow, /fromJson\(needs\.preflight\.outputs\.images\)/)
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
  assert.match(workflow, /org\.opencontainers\.image\.licenses=SEE LICENSE IN LICENSE\.md/)
  assert.match(workflow, /provenance:\s*mode=max/)
  assert.match(workflow, /sbom:\s*true/)
  assert.doesNotMatch(workflow, /build-args:|secret-envs:|secret-files:/)
})

test('docker release workflow moves latest only after immutable image matrix succeeds', () => {
  const workflow = readWorkflow('docker-release.yml')

  assert.match(workflow, /latest:/)
  assert.match(workflow, /if:\s*\$\{\{ inputs\.move_latest \}\}/)
  assert.match(workflow, /needs:\s*\[preflight, docker\]/)
  assert.match(workflow, /docker buildx imagetools create -t "\$\{\{ matrix\.image\.image \}\}:latest" "\$\{\{ matrix\.image\.image \}\}:\$\{\{ needs\.preflight\.outputs\.version \}\}"/)
})
