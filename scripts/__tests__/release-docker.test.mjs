import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import semver from 'semver'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertDockerReleaseEnvironment,
  classifyDockerImages,
  createDockerLabels,
  createDockerTags,
  dockerfileManifestDrift,
  getDockerImageMatrix,
  normalizeDockerNamespace,
  normalizeDockerVersion,
  parseDockerArgs,
  readNodeVersion,
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
    description: 'The self-improving Agentic QA harness with Memory',
    image: 'vostride/agent-qa-web',
    version: '0.1.1',
    revision: 'abc123',
    created: '2026-05-07T00:00:00Z',
    source: 'https://github.com/vostride/agent-qa',
  }), [
    'org.opencontainers.image.title=agent-qa Web',
    'org.opencontainers.image.description=The self-improving Agentic QA harness with Memory',
    'org.opencontainers.image.version=0.1.1',
    'org.opencontainers.image.licenses=FSL-1.1-ALv2',
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

test('a release root without .nvmrc reports it among the missing files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-docker-nvmrc-'))
  try {
    writeFileSync(join(tempDir, 'LICENSE.md'), 'license\n')
    mkdirSync(join(tempDir, 'docker'), { recursive: true })
    for (const dockerfile of dockerfiles) writeFileSync(join(tempDir, dockerfile), 'FROM scratch\n')
    assert.throws(
      () => validateDockerReleasePlan({ rootDir: tempDir, version: '0.1.1' }),
      { message: 'Docker release files missing: .nvmrc' },
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('.nvmrc holds an exact Node version and readNodeVersion returns it', () => {
  const text = readFileSync(join(rootDir, '.nvmrc'), 'utf8').trim()
  assert.equal(semver.valid(text), text)
  assert.equal(readNodeVersion(rootDir), text)
})

test('readNodeVersion refuses an .nvmrc that is not an exact version', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-docker-nvmrc-'))
  try {
    for (const value of ['24', 'lts/*', '>=24.1.0', 'v24.22.2']) {
      writeFileSync(join(tempDir, '.nvmrc'), `${value}\n`)
      assert.throws(() => readNodeVersion(tempDir), {
        message: `.nvmrc must hold an exact Node version, got: ${value}`,
      })
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('the Node images build with the .nvmrc version and the other images take no build argument', () => {
  const nodeVersion = readNodeVersion(rootDir)
  const plan = validateDockerReleasePlan({ rootDir, version: '0.1.1', namespace: 'vostride' })
  const buildArgs = Object.fromEntries(plan.images.map(image => [image.id, image.buildArgs]))
  assert.deepEqual(buildArgs, {
    web: `NODE_VERSION=${nodeVersion}`,
    android: `NODE_VERSION=${nodeVersion}`,
    'hooks-node': `NODE_VERSION=${nodeVersion}`,
    'hooks-bun': '',
    'hooks-python': '',
    'hooks-bash': '',
  })
})

test('the Node hook runner description names no Node version', () => {
  const image = getDockerImageMatrix().find(entry => entry.id === 'hooks-node')
  assert.equal(image.description, 'Node hook sandbox runtime for agent-qa')
  const dockerfile = readFileSync(join(rootDir, image.dockerfile), 'utf8')
  assert.match(dockerfile, /org\.opencontainers\.image\.description="Node hook sandbox runtime for agent-qa"/)
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

function hubStatus(statuses) {
  return async url => {
    const match = /\/repositories\/vostride\/([^/]+)\/tags\/([^/]+)$/.exec(url)
    assert.ok(match, `unexpected Docker Hub URL: ${url}`)
    return { status: statuses[`${match[1]}:${match[2]}`] ?? 200 }
  }
}

test('classifies each image as absent, complete or partial from its two version tags', async () => {
  const [web, android, node] = getDockerImageMatrix()
  const result = await classifyDockerImages([web, android, node], '0.1.1', {
    fetchImpl: hubStatus({
      'agent-qa-web:0.1.1': 404,
      'agent-qa-web:v0.1.1': 404,
      'agent-qa-hook-runner-node:v0.1.1': 404,
    }),
  })
  assert.deepEqual(result, [
    { id: 'web', image: 'vostride/agent-qa-web', state: 'absent', present: [], missing: ['0.1.1', 'v0.1.1'] },
    { id: 'android', image: 'vostride/agent-qa-android', state: 'complete', present: ['0.1.1', 'v0.1.1'], missing: [] },
    { id: 'hooks-node', image: 'vostride/agent-qa-hook-runner-node', state: 'partial', present: ['0.1.1'], missing: ['v0.1.1'] },
  ])
})

test('fails closed when Docker Hub answers a tag lookup with anything but 200 or 404', async () => {
  const [image] = getDockerImageMatrix()
  await assert.rejects(
    classifyDockerImages([image], '0.1.1', { fetchImpl: async () => ({ status: 500 }) }),
    /could not verify Docker tag for vostride\/agent-qa-web:0\.1\.1/,
  )
  await assert.rejects(
    classifyDockerImages([image], '0.1.1', { fetchImpl: hubStatus({ 'agent-qa-web:v0.1.1': 429 }) }),
    /could not verify Docker tag for vostride\/agent-qa-web:v0\.1\.1/,
  )
})

test('parses Docker release CLI args', () => {
  assert.deepEqual(parseDockerArgs([
    '--version', '0.1.1',
    '--namespace', 'vostride',
    '--latest',
    '--check-tags',
    '--require-env',
    '--github-output',
  ]), {
    version: '0.1.1',
    namespace: 'vostride',
    latest: true,
    checkTags: true,
    requireEnv: true,
    githubOutput: true,
  })
  assert.throws(() => parseDockerArgs(['--bad']), /invalid args/)
  assert.throws(() => parseDockerArgs(['--version']), /missing --version/)
})

function readGithubOutputs(text) {
  const outputs = {}
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = /^([\w-]+)<<(\w+)$/.exec(lines[index])
    if (heredoc) {
      const end = lines.indexOf(heredoc[2], index + 1)
      outputs[heredoc[1]] = lines.slice(index + 1, end).join('\n')
      index = end
    } else if (lines[index].includes('=')) {
      const at = lines[index].indexOf('=')
      outputs[lines[index].slice(0, at)] = lines[index].slice(at + 1)
    }
  }
  return outputs
}

async function runWithGithubOutput(argv, fetchImpl) {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-docker-output-'))
  try {
    const outputPath = join(tempDir, 'github-output')
    await runDockerCli([...argv, '--github-output'], {
      rootDir,
      env: { GITHUB_OUTPUT: outputPath },
      fetchImpl,
      output: { write: () => {} },
    })
    return readGithubOutputs(readFileSync(outputPath, 'utf8'))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

test('writes GitHub Actions outputs for matrix handoff', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-docker-output-'))
  try {
    const outputPath = join(tempDir, 'github-output')
    const matrix = getDockerImageMatrix()
    writeGithubOutputs({ outputPath, version: '0.1.1', namespace: 'vostride', matrix })
    const outputs = readGithubOutputs(readFileSync(outputPath, 'utf8'))
    assert.equal(outputs.version, '0.1.1')
    assert.equal(outputs.namespace, 'vostride')
    assert.deepEqual(JSON.parse(outputs.images), matrix)
    assert.deepEqual(JSON.parse(outputs.build), matrix)
    assert.deepEqual(JSON.parse(outputs.retag), [])
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('the release outputs carry the .nvmrc Node version', async () => {
  const outputs = await runWithGithubOutput(['--version', '0.1.1', '--namespace', 'vostride'])
  assert.equal(outputs.node_version, readNodeVersion(rootDir))
})

test('a release over half-pushed images builds only the absent ones and retags the partial one', async () => {
  const outputs = await runWithGithubOutput(
    ['--version', '0.1.1', '--namespace', 'vostride', '--check-tags'],
    hubStatus({
      'agent-qa-web:0.1.1': 404,
      'agent-qa-web:v0.1.1': 404,
      'agent-qa-android:v0.1.1': 404,
    }),
  )
  assert.deepEqual(JSON.parse(outputs.build).map(image => image.image), ['vostride/agent-qa-web'])
  assert.equal(JSON.parse(outputs.build)[0].dockerfile, 'docker/Dockerfile.web')
  assert.deepEqual(JSON.parse(outputs.retag), [
    { image: 'vostride/agent-qa-android', present: '0.1.1', missing: 'v0.1.1' },
  ])
  assert.deepEqual(JSON.parse(outputs.images).map(image => image.image), imageNames)
})

test('a release with every version tag already pushed builds and retags nothing', async () => {
  const outputs = await runWithGithubOutput(
    ['--version', '0.1.1', '--namespace', 'vostride', '--check-tags'],
    hubStatus({}),
  )
  assert.deepEqual(JSON.parse(outputs.build), [])
  assert.deepEqual(JSON.parse(outputs.retag), [])
  assert.deepEqual(JSON.parse(outputs.images).map(image => image.image), imageNames)
})

test('without a tag check every image is built and none is retagged', async () => {
  const outputs = await runWithGithubOutput(['--version', '0.1.1', '--namespace', 'vostride'], async () => {
    throw new Error('Docker Hub must not be queried without --check-tags')
  })
  assert.deepEqual(JSON.parse(outputs.build).map(image => image.image), imageNames)
  assert.deepEqual(JSON.parse(outputs.retag), [])
})

test('CLI prints a local Docker release plan', async () => {
  let output = ''
  await runDockerCli(['--version', '0.1.1', '--namespace', 'vostride'], {
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

const workspaceDockerfiles = ['docker/Dockerfile.web', 'docker/Dockerfile.android']

function packageDirs() {
  return readdirSync(join(rootDir, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => existsSync(join(rootDir, 'packages', entry.name, 'package.json')))
    .map(entry => entry.name)
}

function readDockerfile(dockerfile) {
  return readFileSync(join(rootDir, dockerfile), 'utf8')
}

test('workspace Dockerfiles copy the manifest of every package and nothing else under packages', () => {
  const dirs = packageDirs()
  for (const dockerfile of workspaceDockerfiles) {
    const drift = dockerfileManifestDrift(readDockerfile(dockerfile), dirs)
    assert.deepEqual(
      drift,
      { missing: [], extra: [] },
      `${dockerfile} manifest COPY lines drift from packages/: ${JSON.stringify(drift)}`,
    )
  }
})

test('manifest drift names a package whose manifest line is removed', () => {
  const text = readDockerfile('docker/Dockerfile.web')
    .split('\n')
    .filter(line => line.trim() !== 'COPY packages/web/package.json packages/web/')
    .join('\n')
  assert.deepEqual(dockerfileManifestDrift(text, packageDirs()).missing, ['web'])
})

test('manifest drift names an unknown package whose manifest is copied', () => {
  const text = readDockerfile('docker/Dockerfile.web').replace(
    'COPY packages/web/package.json packages/web/',
    'COPY packages/web/package.json packages/web/\nCOPY packages/ghost/package.json packages/ghost/',
  )
  assert.deepEqual(dockerfileManifestDrift(text, packageDirs()), { missing: [], extra: ['ghost'] })
})

test('manifest drift names any other copy from packages by its directory', () => {
  const text = readDockerfile('docker/Dockerfile.web').replace(
    'COPY packages/web/package.json packages/web/',
    'COPY packages/web/package.json packages/web/\nCOPY packages/core/src packages/core/src',
  )
  assert.deepEqual(dockerfileManifestDrift(text, packageDirs()), { missing: [], extra: ['core'] })
})

const nodeDockerfiles = ['docker/Dockerfile.web', 'docker/Dockerfile.android', 'docker/Dockerfile.hooks-node']

test('the Node Dockerfiles take Node from a NODE_VERSION argument with no default', () => {
  for (const dockerfile of nodeDockerfiles) {
    const lines = readDockerfile(dockerfile).split('\n').map(line => line.trim())
    const firstFrom = lines.findIndex(line => line.startsWith('FROM '))
    const arg = lines.findIndex(line => line.startsWith('ARG NODE_VERSION'))
    assert.ok(arg !== -1 && arg < firstFrom, `${dockerfile} declares ARG NODE_VERSION before its first FROM`)
    assert.equal(lines[arg], 'ARG NODE_VERSION', `${dockerfile} gives NODE_VERSION no default`)
    for (const from of lines.filter(line => line.startsWith('FROM '))) {
      assert.match(from, /^FROM node:\$\{NODE_VERSION\}-slim( AS builder)?$/, `${dockerfile}: ${from}`)
    }
  }
})

test('the workspace Dockerfiles install pnpm at the packageManager version with npm', () => {
  for (const dockerfile of workspaceDockerfiles) {
    const text = readDockerfile(dockerfile)
    assert.doesNotMatch(text, /corepack/)
    assertInstallsPnpmAfterRootManifests(text, dockerfile)
  }
})

function assertInstallsPnpmAfterRootManifests(text, dockerfile) {
  const install = `RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.replace(/^pnpm@/, '').split('+')[0]")"`
  const lines = text.split('\n').map(line => line.trim())
  const rootCopy = lines.indexOf('COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json NOTICE.md ./')
  assert.notEqual(rootCopy, -1, `${dockerfile} copies the root manifests`)
  assert.equal(lines[rootCopy + 1], install, `${dockerfile} installs pnpm right after the root manifests`)
}
