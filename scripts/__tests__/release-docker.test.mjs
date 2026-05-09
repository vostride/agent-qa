import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertDockerReleaseEnvironment,
  checkDockerTagsAbsent,
  createDockerLabels,
  createDockerTags,
  getDockerImageMatrix,
  normalizeDockerNamespace,
  normalizeDockerVersion,
  parseDockerArgs,
  runCli as runDockerCli,
  validateDockerReleasePlan,
  writeGithubOutputs,
} from '../release/docker.mjs'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const imageNames = [
  'vostride/agent-qa-web',
  'vostride/agent-qa-android',
  'vostride/agent-qa-hook-runner-node',
  'vostride/agent-qa-hook-runner-bun',
  'vostride/agent-qa-hook-runner-python',
  'vostride/agent-qa-hook-runner-bash',
]
const dockerfiles = [
  'docker/Dockerfile.web',
  'docker/Dockerfile.android',
  'docker/Dockerfile.hooks-node',
  'docker/Dockerfile.hooks-bun',
  'docker/Dockerfile.hooks-python',
  'docker/Dockerfile.hooks-bash',
]
const dockerPlatforms = [
  'linux/amd64',
  'linux/amd64',
  'linux/amd64,linux/arm64',
  'linux/amd64,linux/arm64',
  'linux/amd64,linux/arm64',
  'linux/amd64,linux/arm64',
]

test('defines the six Docker release images under the vostride namespace', () => {
  const matrix = getDockerImageMatrix()
  assert.deepEqual(matrix.map(image => image.image), imageNames)
  assert.deepEqual(matrix.map(image => image.dockerfile), dockerfiles)
  assert.deepEqual(matrix.map(image => image.platforms), dockerPlatforms)
})

test('normalizes namespace and version inputs for Docker releases', () => {
  assert.equal(normalizeDockerNamespace('vostride'), 'vostride')
  assert.throws(() => normalizeDockerNamespace('agent-qa'), /Docker namespace must be vostride/)
  assert.equal(normalizeDockerVersion('0.1.1'), '0.1.1')
  assert.equal(normalizeDockerVersion('v0.1.1'), '0.1.1')
  assert.throws(() => normalizeDockerVersion('1.0.0'), /0\.x\.x/)
  assert.throws(() => normalizeDockerVersion('bad'), /valid 0\.x\.x/)
})

test('creates immutable version tags and optional latest tag', () => {
  assert.deepEqual(createDockerTags('vostride/agent-qa-web', '0.1.1'), [
    'vostride/agent-qa-web:0.1.1',
    'vostride/agent-qa-web:v0.1.1',
  ])
  assert.deepEqual(createDockerTags('vostride/agent-qa-web', '0.1.1', { latest: true }), [
    'vostride/agent-qa-web:0.1.1',
    'vostride/agent-qa-web:v0.1.1',
    'vostride/agent-qa-web:latest',
  ])
})

test('creates OCI labels for Docker metadata action', () => {
  assert.deepEqual(createDockerLabels({
    title: 'agent-qa Web',
    description: 'AI-powered testing framework',
    image: 'vostride/agent-qa-web',
    version: '0.1.1',
    revision: 'abc123',
    created: '2026-05-07T00:00:00Z',
    source: 'https://github.com/vostride/agent-qa',
  }), [
    'org.opencontainers.image.title=agent-qa Web',
    'org.opencontainers.image.description=AI-powered testing framework',
    'org.opencontainers.image.version=0.1.1',
    'org.opencontainers.image.licenses=SEE LICENSE IN LICENSE.md',
    'org.opencontainers.image.ref.name=vostride/agent-qa-web',
    'org.opencontainers.image.revision=abc123',
    'org.opencontainers.image.created=2026-05-07T00:00:00Z',
    'org.opencontainers.image.source=https://github.com/vostride/agent-qa',
  ])
})

test('validates real Docker release files in the repository', () => {
  const plan = validateDockerReleasePlan({ rootDir, version: '0.1.1', namespace: 'vostride' })
  assert.equal(plan.version, '0.1.1')
  assert.equal(plan.namespace, 'vostride')
  assert.equal(plan.images.length, 6)
  assert.ok(plan.images.every(image => image.tags.includes(`${image.image}:0.1.1`)))
  assert.ok(plan.images.every(image => image.labels.some(label => label === 'org.opencontainers.image.version=0.1.1')))
})

test('fails local validation when release files are missing', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-docker-missing-'))
  try {
    assert.throws(() => validateDockerReleasePlan({ rootDir: tempDir, version: '0.1.1' }), /Docker release files missing/)
    mkdirSync(join(tempDir, 'docker'), { recursive: true })
    writeFileSync(join(tempDir, 'LICENSE.md'), 'license\n')
    writeFileSync(join(tempDir, 'docker/Dockerfile.web'), 'FROM scratch\n')
    assert.throws(() => validateDockerReleasePlan({ rootDir: tempDir, version: '0.1.1' }), /Dockerfile\.android/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('requires Docker Hub environment for publishing', () => {
  const goodEnv = {
    DOCKERHUB_USERNAME: 'vostride-bot',
    DOCKERHUB_NAMESPACE: 'vostride',
    DOCKERHUB_TOKEN: 'token',
  }
  assert.deepEqual(assertDockerReleaseEnvironment({ env: goodEnv }), {
    namespace: 'vostride',
    username: 'vostride-bot',
  })
  assert.throws(() => assertDockerReleaseEnvironment({ env: { ...goodEnv, DOCKERHUB_TOKEN: '' } }), /DOCKERHUB_TOKEN/)
  assert.throws(() => assertDockerReleaseEnvironment({ env: { ...goodEnv, DOCKERHUB_NAMESPACE: 'agent-qa' } }), /vostride/)
})

test('checks immutable Docker Hub tags and fails closed on collisions or ambiguity', async () => {
  const [image] = getDockerImageMatrix()
  const urls = []
  await checkDockerTagsAbsent([image], '0.1.1', {
    fetchImpl: async url => {
      urls.push(url)
      return { status: 404 }
    },
  })
  assert.equal(urls.length, 2)
  assert.ok(urls.every(url => url.includes('hub.docker.com/v2/repositories/vostride/agent-qa-web/tags/')))
  await assert.rejects(
    checkDockerTagsAbsent([image], '0.1.1', { fetchImpl: async () => ({ status: 200 }) }),
    /docker tag already exists/,
  )
  await assert.rejects(
    checkDockerTagsAbsent([image], '0.1.1', { fetchImpl: async () => ({ status: 500 }) }),
    /could not verify Docker tag absence/,
  )
})

test('parses Docker release CLI args', () => {
  assert.deepEqual(parseDockerArgs([
    '--version', '0.1.1',
    '--namespace', 'vostride',
    '--latest',
    '--check-local',
    '--check-tags',
    '--require-env',
    '--github-output',
  ]), {
    version: '0.1.1',
    namespace: 'vostride',
    latest: true,
    checkLocal: true,
    checkTags: true,
    requireEnv: true,
    githubOutput: true,
  })
  assert.throws(() => parseDockerArgs(['--bad']), /invalid args/)
  assert.throws(() => parseDockerArgs(['--version']), /missing --version/)
})

test('writes GitHub Actions outputs for matrix handoff', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-docker-output-'))
  try {
    const outputPath = join(tempDir, 'github-output')
    const matrix = getDockerImageMatrix()
    writeGithubOutputs({ outputPath, version: '0.1.1', namespace: 'vostride', matrix })
    const text = readFileSync(outputPath, 'utf8')
    assert.match(text, /^version=0\.1\.1/m)
    assert.match(text, /^namespace=vostride/m)
    assert.match(text, /images<<EOF/)
    assert.match(text, /"image":"vostride\/agent-qa-web"/)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('CLI prints a local Docker release plan', async () => {
  let output = ''
  await runDockerCli(['--check-local', '--version', '0.1.1', '--namespace', 'vostride'], {
    rootDir,
    output: { write: chunk => { output += chunk } },
  })
  assert.match(output, /"version": "0\.1\.1"/)
  assert.match(output, /"image": "vostride\/agent-qa-web"/)
})

test('Dockerfiles include license metadata and avoid secret build args', () => {
  for (const dockerfile of dockerfiles) {
    const text = readFileSync(join(rootDir, dockerfile), 'utf8')
    assert.match(text, /COPY LICENSE\.md \/licenses\/agent-qa\/LICENSE\.md/)
    assert.match(text, /org\.opencontainers\.image\.licenses/)
    assert.match(text, /org\.opencontainers\.image\.vendor="Vostride"/)
    assert.doesNotMatch(text, /ARG .*TOKEN|ARG .*SECRET|build-arg|DOCKERHUB_TOKEN/)
  }
})
