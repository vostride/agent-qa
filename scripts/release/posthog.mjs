import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const host = 'https://us.i.posthog.com'
const coreRuntimeArtifacts = [
  'dist/index.js',
  'dist/index.cjs',
]

function renderStringLiteral(value) {
  return JSON.stringify(value)
}

export function renderPosthogProjectFile(projectKey) {
  if (!projectKey?.trim()) throw new Error('POSTHOG_PROJECT_KEY is required')
  return `export const AGENT_QA_POSTHOG_KEY = ${renderStringLiteral(projectKey)}\nexport const AGENT_QA_POSTHOG_HOST = ${renderStringLiteral(host)}\n`
}

export function redactSecret(value) {
  return value ? '[redacted POSTHOG_PROJECT_KEY]' : ''
}

export async function writePosthogProjectFile(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const projectKey = options.projectKey ?? options.env?.POSTHOG_PROJECT_KEY ?? process.env.POSTHOG_PROJECT_KEY
  const target = join(rootDir, 'packages/core/src/analytics/posthog-project.ts')
  const content = renderPosthogProjectFile(projectKey)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  ;(options.log ?? console.log)(`Wrote packages/core/src/analytics/posthog-project.ts with ${redactSecret(projectKey)}`)
  return target
}

function validateRuntimeArtifact(path, projectKey) {
  if (!existsSync(path)) throw new Error(`PostHog dist key artifact is missing: ${path}`)
  const distText = readFileSync(path, 'utf8')
  if (!distText.includes('AGENT_QA_POSTHOG_KEY')) throw new Error(`PostHog dist key export is missing: ${path}`)
  if (/AGENT_QA_POSTHOG_KEY\s*=\s*["']{2}/.test(distText)) throw new Error(`PostHog dist key is empty: ${path}`)
  if (!distText.includes(projectKey)) throw new Error(`PostHog dist key does not match POSTHOG_PROJECT_KEY: ${path}`)
}

function corePackageRoots(rootDir, stagedDir) {
  const roots = [join(rootDir, 'packages/core')]
  if (stagedDir) roots.push(join(stagedDir, 'core'))
  return roots
}

export function validatePosthogReleaseArtifacts(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const projectKey = options.projectKey ?? options.env?.POSTHOG_PROJECT_KEY ?? process.env.POSTHOG_PROJECT_KEY
  if (!projectKey?.trim()) throw new Error('POSTHOG_PROJECT_KEY is required')

  for (const packageRoot of corePackageRoots(rootDir, options.stagedDir)) {
    for (const artifact of coreRuntimeArtifacts) {
      validateRuntimeArtifact(join(packageRoot, artifact), projectKey)
    }
  }
  if ((options.logText ?? '').includes(projectKey)) throw new Error('raw POSTHOG_PROJECT_KEY leaked in logs')

  const servicePath = join(rootDir, 'packages/core/src/analytics/service.ts')
  if (!existsSync(servicePath)) throw new Error('analytics service source is missing')
  const serviceText = readFileSync(servicePath, 'utf8')
  if (!serviceText.includes('NoopAnalyticsTransport')) throw new Error('analytics service must preserve NoopAnalyticsTransport')
  if (serviceText.includes('process.env.AGENT_QA_POSTHOG_KEY')) {
    throw new Error('analytics runtime must not read process.env.AGENT_QA_POSTHOG_KEY')
  }
}

export function parseReleaseArgs(argv = []) {
  if (argv.length === 0) throw new Error('missing --write')
  if (argv.length !== 1 || argv[0] !== '--write') {
    throw new Error(`invalid args: node scripts/release/posthog.mjs --write`)
  }
  return { mode: 'write' }
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  parseReleaseArgs(argv)
  return writePosthogProjectFile({
    rootDir: options.rootDir,
    env: options.env,
    projectKey: options.projectKey,
    log: options.log,
  })
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
