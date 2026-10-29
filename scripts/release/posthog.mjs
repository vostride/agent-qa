import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The key file lives in `packages/analytics/`; writing it anywhere else ships a keyless binary.
const host = 'https://us.i.posthog.com'
const keyFilePath = 'packages/analytics/src/posthog-project.ts'
const analyticsRuntimeArtifacts = [
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
  const target = join(rootDir, keyFilePath)
  const content = renderPosthogProjectFile(projectKey)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  ;(options.log ?? console.log)(`Wrote ${keyFilePath} with ${redactSecret(projectKey)}`)
  return target
}

function validateRuntimeArtifact(path, projectKey) {
  if (!existsSync(path)) throw new Error(`PostHog dist key artifact is missing: ${path}`)
  const distText = readFileSync(path, 'utf8')
  if (!distText.includes('AGENT_QA_POSTHOG_KEY')) throw new Error(`PostHog dist key export is missing: ${path}`)
  if (/AGENT_QA_POSTHOG_KEY\s*=\s*["']{2}/.test(distText)) throw new Error(`PostHog dist key is empty: ${path}`)
  if (!distText.includes(projectKey)) throw new Error(`PostHog dist key does not match POSTHOG_PROJECT_KEY: ${path}`)
}

function analyticsPackageRoots(rootDir, stagedDir) {
  const roots = [join(rootDir, 'packages/analytics')]
  if (stagedDir) roots.push(join(stagedDir, 'analytics'))
  return roots
}

export function validatePosthogReleaseArtifacts(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const projectKey = options.projectKey ?? options.env?.POSTHOG_PROJECT_KEY ?? process.env.POSTHOG_PROJECT_KEY
  if (!projectKey?.trim()) throw new Error('POSTHOG_PROJECT_KEY is required')

  for (const packageRoot of analyticsPackageRoots(rootDir, options.stagedDir)) {
    for (const artifact of analyticsRuntimeArtifacts) {
      validateRuntimeArtifact(join(packageRoot, artifact), projectKey)
    }
  }
  if ((options.logText ?? '').includes(projectKey)) throw new Error('raw POSTHOG_PROJECT_KEY leaked in logs')

  // Asserted on `compose.ts`, which reads the baked key and builds no transport when opted out.
  const composePath = join(rootDir, 'packages/analytics/src/compose.ts')
  if (!existsSync(composePath)) throw new Error('analytics composition source is missing')
  const composeText = readFileSync(composePath, 'utf8')
  if (!composeText.includes("export type AnalyticsTransportKind = 'none' | 'posthog'")) {
    throw new Error('analytics composition must keep the no-transport arm')
  }
  if (composeText.includes('process.env.AGENT_QA_POSTHOG_KEY')) {
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
