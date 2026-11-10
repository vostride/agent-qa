import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

export function parseSentryArgs(argv = []) {
  if (argv.length === 0) throw new Error('missing --write')
  if (argv.length !== 1 || argv[0] !== '--write') {
    throw new Error('invalid args: node scripts/release/sentry.mjs --write')
  }
  return { mode: 'write' }
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  parseSentryArgs(argv)
  return writeSentryProjectFile({
    rootDir: options.rootDir,
    env: options.env,
    dsn: options.dsn,
    log: options.log,
  })
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
