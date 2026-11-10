import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

// The DSN file lives in `packages/analytics/`; writing it anywhere else ships a CLI that reports
// nothing.
const dsnFilePath = 'packages/analytics/src/sentry-project.ts'
const analyticsRuntimeArtifacts = ['dist/index.js', 'dist/index.cjs']
const reporterSourcePath = 'packages/cli/src/composition/error-reporting.ts'
const cliEntryArtifacts = ['dist/cli.js', 'dist/cli.cjs']
const shebang = '#!/usr/bin/env node'
const debugIdComment = /^\/\/# debugId=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/im
const environmentRead = /\bprocess\.env(?:\?\.|\.|\[\s*['"`])SENTRY_DSN\b/
const uploadVariables = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']
const uploadSkipped = '::warning::Source maps were not uploaded to Sentry'
const usage = 'node scripts/release/sentry.mjs --write | --inject | --upload --release <name>'

export function renderSentryProjectFile(dsn) {
  if (!dsn?.trim()) throw new Error('SENTRY_DSN is required')
  return `export const AGENT_QA_SENTRY_DSN = ${JSON.stringify(dsn)}\n`
}

export function redactDsn(value) {
  return value ? '[redacted SENTRY_DSN]' : ''
}

export async function writeSentryProjectFile(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const dsn = options.dsn ?? options.env?.SENTRY_DSN ?? process.env.SENTRY_DSN
  const target = join(rootDir, dsnFilePath)
  const content = renderSentryProjectFile(dsn)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
  ;(options.log ?? console.log)(`Wrote ${dsnFilePath} with ${redactDsn(dsn)}`)
  return target
}

function readArtifact(path) {
  if (!existsSync(path)) throw new Error(`Sentry release artifact is missing: ${path}`)
  return readFileSync(path, 'utf8')
}

// Tests are not runtime source, and one may name the read it forbids.
function analyticsRuntimeSources(rootDir) {
  const sourceDir = join(rootDir, 'packages/analytics/src')
  return readdirSync(sourceDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !relative(sourceDir, path).split(sep).includes('__tests__'))
    .filter((path) => !/\.test\.[cm]?[jt]s$/.test(path))
}

export function validateSentryReleaseArtifacts(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const dsn = options.dsn ?? options.env?.SENTRY_DSN ?? process.env.SENTRY_DSN
  if (!dsn?.trim()) throw new Error('SENTRY_DSN is required')

  const analyticsRoots = [join(rootDir, 'packages/analytics')]
  if (options.stagedDir) analyticsRoots.push(join(options.stagedDir, 'analytics'))
  for (const packageRoot of analyticsRoots) {
    for (const artifact of analyticsRuntimeArtifacts) {
      const path = join(packageRoot, artifact)
      // The bundler inlines the DSN constant, so only the value itself proves what shipped.
      if (!readArtifact(path).includes(dsn)) {
        throw new Error(`Sentry DSN in the analytics dist does not match SENTRY_DSN: ${path}`)
      }
    }
  }

  for (const path of [...analyticsRuntimeSources(rootDir), join(rootDir, reporterSourcePath)]) {
    if (environmentRead.test(readFileSync(path, 'utf8'))) {
      throw new Error(`runtime source reads process.env.SENTRY_DSN: ${path}`)
    }
  }

  if (!options.stagedDir) return
  for (const artifact of cliEntryArtifacts) {
    const path = join(options.stagedDir, 'cli', artifact)
    const text = readArtifact(path)
    if (!text.startsWith(`${shebang}\n`)) {
      throw new Error(`staged cli entry does not start with ${shebang}: ${path}`)
    }
    if (!debugIdComment.test(text)) throw new Error(`staged cli entry has no debug ID: ${path}`)
  }
}

// Every package's dist but the dashboard UI's browser bundles. Plugins report nothing.
export function debugIdTargets(rootDir) {
  return readdirSync(join(rootDir, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'dashboard-ui')
    .map((entry) => `packages/${entry.name}/dist`)
    .filter((target) => statSync(join(rootDir, target), { throwIfNoEntry: false })?.isDirectory())
    .sort()
}

// sentry-cli reads a .env file in its folder unless told not to, and inject needs no token.
export function injectDebugIds(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const env = options.env ?? process.env
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const targets = debugIdTargets(rootDir)
  if (targets.length === 0) throw new Error('no package dist folder to inject debug IDs into')
  execFileSync('sentry-cli', ['sourcemaps', 'inject', ...targets], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { PATH: env.PATH, SENTRY_LOAD_DOTENV: '0' },
  })
  ;(options.log ?? console.log)(`Injected debug IDs into ${targets.join(' ')}`)
  return targets
}

// A release never waits on Sentry. The warning is a fixed sentence, because sentry-cli's own
// output can repeat what it was given.
export function uploadSourceMaps(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const env = options.env ?? process.env
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const log = options.log ?? console.log
  const missing = uploadVariables.filter((name) => !env[name]?.trim())
  if (missing.length > 0) {
    log(`${uploadSkipped}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`)
    return { uploaded: false }
  }
  try {
    const targets = debugIdTargets(rootDir)
    if (targets.length === 0) throw new Error('no package dist folder to upload')
    execFileSync('sentry-cli', ['sourcemaps', 'upload', '--release', options.release, ...targets], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: 'pipe',
      // Nothing else reaches sentry-cli, so no SENTRY_URL moves it off its default endpoint.
      env: {
        PATH: env.PATH,
        SENTRY_AUTH_TOKEN: env.SENTRY_AUTH_TOKEN,
        SENTRY_ORG: env.SENTRY_ORG,
        SENTRY_PROJECT: env.SENTRY_PROJECT,
        SENTRY_LOAD_DOTENV: '0',
      },
    })
  } catch (error) {
    const status = Number.isInteger(error?.status) ? ` (exit status ${error.status})` : ''
    log(`${uploadSkipped}: the upload failed${status}`)
    return { uploaded: false }
  }
  log(`Uploaded source maps for ${options.release}`)
  return { uploaded: true }
}

export function parseSentryArgs(argv = []) {
  const [mode, ...rest] = argv
  if (mode === '--write' && rest.length === 0) return { mode: 'write' }
  if (mode === '--inject' && rest.length === 0) return { mode: 'inject' }
  const [flag, release = ''] = rest
  const namesRelease = rest.length === 2 && flag === '--release' && /^[^-\s]/.test(release)
  if (mode === '--upload' && namesRelease) return { mode: 'upload', release }
  throw new Error(`invalid args: ${usage}`)
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const { mode, release } = parseSentryArgs(argv)
  const { rootDir, env, log, execFileSync } = options
  if (mode === 'inject') return injectDebugIds({ rootDir, env, log, execFileSync })
  if (mode === 'upload') return uploadSourceMaps({ rootDir, env, log, execFileSync, release })
  return writeSentryProjectFile({ rootDir, env, log, dsn: options.dsn })
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
