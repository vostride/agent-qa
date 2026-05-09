import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { derivePublishOrder } from './packages.mjs'
import { discoverStagedRecords } from './stage-packages.mjs'

export function assertTrustedPublishEnvironment(options = {}) {
  const env = options.env ?? process.env
  const npmVersion = options.npmVersion
  if (env.NPM_TOKEN) throw new Error('NPM_TOKEN is not allowed for trusted publishing')
  if (env.GITHUB_ACTIONS !== 'true') throw new Error('GitHub Actions trusted publishing environment is required')
  if (!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('ACTIONS_ID_TOKEN_REQUEST_TOKEN is required for npm trusted publishing')
  const parsedNpmVersion = npmVersion ? semver.coerce(npmVersion) : null
  if (!parsedNpmVersion || !semver.gte(parsedNpmVersion, '11.5.1')) {
    throw new Error('npm CLI >=11.5.1 is required for trusted publishing')
  }
}

export function createPublishCommands(options = {}) {
  const records = derivePublishOrder(options.stagedRecords)
  const version = options.version
  return records.map(record => {
    if (version && record.pkg.version !== version) {
      throw new Error(`${record.pkg.name} staged version must be ${version}`)
    }
    return {
      command: 'npm',
      args: ['publish', '--access', 'public'],
      cwd: record.dir,
      env: {},
    }
  })
}

function npmVersion(execFileSync) {
  return execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

export async function publishPackages(options = {}) {
  const rootDir = options.rootDir ?? process.cwd()
  const stagedDir = resolve(rootDir, options.stagedDir ?? '.release/staged-packages')
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const env = options.env ?? process.env
  const resolvedNpmVersion = options.npmVersion ?? npmVersion(execFileSync)
  assertTrustedPublishEnvironment({ env, npmVersion: resolvedNpmVersion })

  const stagedRecords = discoverStagedRecords(stagedDir)
  const commands = createPublishCommands({
    stagedRecords,
    version: stagedRecords[0]?.pkg.version,
  })
  const publishEnv = { ...env }
  delete publishEnv.NPM_CONFIG_PROVENANCE

  for (const command of commands) {
    execFileSync(command.command, command.args, {
      cwd: command.cwd,
      env: publishEnv,
      stdio: options.stdio ?? 'inherit',
    })
  }

  return commands
}

export function parseReleaseArgs(argv = []) {
  if (argv.length === 0) throw new Error('missing --staged-dir')
  if (argv.length !== 2 || argv[0] !== '--staged-dir' || !argv[1]) {
    throw new Error(`invalid args: node scripts/release/publish.mjs --staged-dir .release/staged-packages`)
  }
  return { stagedDir: argv[1] }
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseReleaseArgs(argv)
  return publishPackages({ ...options, stagedDir: parsed.stagedDir })
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
