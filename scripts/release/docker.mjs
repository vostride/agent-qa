import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { getPublicPackages } from './packages.mjs'
import { assertSharedPublicVersion } from './version.mjs'

export const dockerImages = [
  {
    id: 'web',
    repo: 'agent-qa-web',
    dockerfile: 'docker/Dockerfile.web',
    platforms: 'linux/amd64',
    title: 'agent-qa Web',
    description: 'Self-improving Agentic QA harness with Memory for browser testing',
  },
  {
    id: 'android',
    repo: 'agent-qa-android',
    dockerfile: 'docker/Dockerfile.android',
    platforms: 'linux/amd64',
    title: 'agent-qa Android',
    description: 'Self-improving Agentic QA harness with Memory for browser and mobile testing',
  },
  {
    id: 'hooks-node',
    repo: 'agent-qa-hook-runner-node',
    dockerfile: 'docker/Dockerfile.hooks-node',
    platforms: 'linux/amd64,linux/arm64',
    title: 'agent-qa Hook Runner Node',
    description: 'Node 24 hook sandbox runtime for agent-qa',
  },
  {
    id: 'hooks-bun',
    repo: 'agent-qa-hook-runner-bun',
    dockerfile: 'docker/Dockerfile.hooks-bun',
    platforms: 'linux/amd64,linux/arm64',
    title: 'agent-qa Hook Runner Bun',
    description: 'Bun hook sandbox runtime for agent-qa',
  },
  {
    id: 'hooks-python',
    repo: 'agent-qa-hook-runner-python',
    dockerfile: 'docker/Dockerfile.hooks-python',
    platforms: 'linux/amd64,linux/arm64',
    title: 'agent-qa Hook Runner Python',
    description: 'Python hook sandbox runtime for agent-qa',
  },
  {
    id: 'hooks-bash',
    repo: 'agent-qa-hook-runner-bash',
    dockerfile: 'docker/Dockerfile.hooks-bash',
    platforms: 'linux/amd64,linux/arm64',
    title: 'agent-qa Hook Runner Bash',
    description: 'Bash hook sandbox runtime for agent-qa',
  },
]

export function normalizeDockerNamespace(namespace = 'vostride') {
  const value = String(namespace ?? '').trim()
  if (value !== 'vostride') throw new Error(`Docker namespace must be vostride, got: ${value || 'empty'}`)
  return value
}

export function normalizeDockerVersion(version) {
  const raw = String(version ?? '').trim()
  const value = raw.startsWith('v') ? raw.slice(1) : raw
  if (!semver.valid(value) || !value.startsWith('0.')) {
    throw new Error(`Docker release version must be valid 0.x.x semver: ${raw || 'empty'}`)
  }
  return value
}

export function getDockerImageMatrix(options = {}) {
  const namespace = normalizeDockerNamespace(options.namespace ?? 'vostride')
  return dockerImages.map(image => ({
    ...image,
    namespace,
    image: `${namespace}/${image.repo}`,
  }))
}

export function createDockerTags(image, version, options = {}) {
  const normalized = normalizeDockerVersion(version)
  const tags = [`${image}:${normalized}`, `${image}:v${normalized}`]
  if (options.latest) tags.push(`${image}:latest`)
  return tags
}

export function createDockerLabels(options = {}) {
  const version = normalizeDockerVersion(options.version)
  const labels = [
    `org.opencontainers.image.title=${options.title}`,
    `org.opencontainers.image.description=${options.description}`,
    `org.opencontainers.image.version=${version}`,
    `org.opencontainers.image.licenses=SEE LICENSE IN LICENSE.md`,
  ]
  if (options.image) labels.push(`org.opencontainers.image.ref.name=${options.image}`)
  if (options.revision) labels.push(`org.opencontainers.image.revision=${options.revision}`)
  if (options.created) labels.push(`org.opencontainers.image.created=${options.created}`)
  if (options.source) labels.push(`org.opencontainers.image.source=${options.source}`)
  return labels
}

function resolveVersion(rootDir, version) {
  if (version) return normalizeDockerVersion(version)
  const records = getPublicPackages({ rootDir })
  return normalizeDockerVersion(assertSharedPublicVersion(records))
}

export function validateDockerReleasePlan(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const version = resolveVersion(rootDir, options.version)
  const matrix = getDockerImageMatrix({ namespace: options.namespace ?? 'vostride' })
  const missing = []

  if (!existsSync(join(rootDir, 'LICENSE.md'))) missing.push('LICENSE.md')
  for (const image of matrix) {
    if (!existsSync(join(rootDir, image.dockerfile))) missing.push(image.dockerfile)
  }
  if (missing.length > 0) throw new Error(`Docker release files missing: ${missing.join(', ')}`)

  return {
    version,
    namespace: matrix[0]?.namespace ?? normalizeDockerNamespace(options.namespace),
    images: matrix.map(image => ({
      ...image,
      tags: createDockerTags(image.image, version, { latest: options.latest }),
      labels: createDockerLabels({ ...image, version }),
    })),
  }
}

export function assertDockerReleaseEnvironment(options = {}) {
  const env = options.env ?? process.env
  const namespace = normalizeDockerNamespace(options.namespace ?? env.DOCKERHUB_NAMESPACE)
  const required = ['DOCKERHUB_USERNAME', 'DOCKERHUB_TOKEN', 'DOCKERHUB_NAMESPACE']
  const missing = required.filter(name => !String(env[name] ?? '').trim())
  if (missing.length > 0) throw new Error(`Missing Docker release environment: ${missing.join(', ')}`)
  if (env.DOCKERHUB_NAMESPACE !== namespace) {
    throw new Error(`DOCKERHUB_NAMESPACE must be ${namespace}`)
  }
  return { namespace, username: env.DOCKERHUB_USERNAME }
}

function immutableTags(version) {
  const normalized = normalizeDockerVersion(version)
  return [normalized, `v${normalized}`]
}

export async function checkDockerTagsAbsent(matrix, version, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required for Docker Hub tag checks')

  for (const image of matrix) {
    const namespace = normalizeDockerNamespace(image.namespace ?? image.image?.split('/')[0])
    const repo = image.repo ?? image.image?.split('/')[1]
    if (!repo) throw new Error('Docker image record missing repo')
    for (const tag of immutableTags(version)) {
      const url = `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(repo)}/tags/${encodeURIComponent(tag)}`
      const response = await fetchImpl(url)
      if (response.status === 404) continue
      if (response.status === 200) throw new Error(`docker tag already exists: ${namespace}/${repo}:${tag}`)
      throw new Error(`could not verify Docker tag absence for ${namespace}/${repo}:${tag}`)
    }
  }
}

export function writeGithubOutputs(options = {}) {
  const outputPath = options.outputPath
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required for --github-output')
  const version = normalizeDockerVersion(options.version)
  const namespace = normalizeDockerNamespace(options.namespace)
  const images = JSON.stringify(options.matrix)
  appendFileSync(outputPath, `version=${version}\n`, 'utf8')
  appendFileSync(outputPath, `namespace=${namespace}\n`, 'utf8')
  appendFileSync(outputPath, `images<<EOF\n${images}\nEOF\n`, 'utf8')
}

export function parseDockerArgs(argv = []) {
  const parsed = {
    latest: false,
    checkLocal: false,
    checkTags: false,
    requireEnv: false,
    githubOutput: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version') {
      parsed.version = argv[index + 1]
      if (!parsed.version) throw new Error('missing --version value')
      index += 1
    } else if (arg === '--namespace') {
      parsed.namespace = argv[index + 1]
      if (!parsed.namespace) throw new Error('missing --namespace value')
      index += 1
    } else if (arg === '--latest') {
      parsed.latest = true
    } else if (arg === '--check-local') {
      parsed.checkLocal = true
    } else if (arg === '--check-tags') {
      parsed.checkTags = true
    } else if (arg === '--require-env') {
      parsed.requireEnv = true
    } else if (arg === '--github-output') {
      parsed.githubOutput = true
    } else {
      throw new Error(`invalid args: ${argv.join(' ')}`)
    }
  }
  return parsed
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseDockerArgs(argv)
  const env = options.env ?? process.env
  const namespace = normalizeDockerNamespace(parsed.namespace ?? env.DOCKERHUB_NAMESPACE ?? 'vostride')
  const plan = validateDockerReleasePlan({
    rootDir: options.rootDir,
    version: parsed.version,
    namespace,
    latest: parsed.latest,
  })

  if (parsed.requireEnv) assertDockerReleaseEnvironment({ env, namespace })
  if (parsed.checkTags) await checkDockerTagsAbsent(plan.images, plan.version, { fetchImpl: options.fetchImpl })
  if (parsed.githubOutput) {
    writeGithubOutputs({
      outputPath: env.GITHUB_OUTPUT,
      version: plan.version,
      namespace,
      matrix: plan.images.map(({ tags, labels, ...image }) => image),
    })
  }

  const output = options.output ?? process.stdout
  output.write?.(`${JSON.stringify(plan, null, 2)}\n`)
  return plan
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
