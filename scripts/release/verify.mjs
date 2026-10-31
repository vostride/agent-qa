import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import semver from 'semver'
import { checkGitTagAbsent as defaultCheckGitTagAbsent } from './git.mjs'
import { getPublicPackages } from './packages.mjs'
import { assertTrustedPublishEnvironment as defaultAssertTrustedPublishEnvironment } from './publish.mjs'
import {
  checkNpmVersionsAbsent as defaultCheckNpmVersionsAbsent,
  npmVersionPresent,
} from './registry.mjs'
import { discoverStagedRecords, validateStagedPackageManifests as defaultValidateStagedPackageManifests } from './stage-packages.mjs'
import { assertAllowedBump, assertSharedPublicVersion, computeTargetVersion } from './version.mjs'
import { validatePosthogReleaseArtifacts as defaultValidatePosthogReleaseArtifacts } from './posthog.mjs'

export const subscriptionAuthPackageName = '@vostride/agent-qa-subscription-auth'

function parsePackOutput(output, packageName) {
  const parsed = JSON.parse(output)
  const files = parsed[0]?.files?.map(file => file.path) ?? []
  if (files.length === 0) throw new Error(`${packageName} npm pack --dry-run --json returned no files`)
  return files
}

function validatePackFiles(record, files) {
  const name = record.pkg.name
  if (!files.includes('package.json')) throw new Error(`${name} pack must include package.json`)
  if (!files.includes('LICENSE.md')) throw new Error(`${name} pack must include LICENSE.md`)
  if (!files.includes('NOTICE.md')) throw new Error(`${name} pack must include NOTICE.md`)
  const declaresBuiltOutput = record.pkg.files?.includes('dist') || Boolean(record.pkg.exports)
  if (declaresBuiltOutput && !files.some(file => file.startsWith('dist/'))) {
    throw new Error(`${name} pack must include dist/`)
  }
  if (name === 'agent-qa' && !files.some(file => file.startsWith('skills/'))) {
    throw new Error('agent-qa pack must include skills/')
  }
}

export function validateStagedPackDryRuns(options = {}) {
  const stagedDir = options.stagedDir
  const targetVersion = options.targetVersion
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const npmCommand = options.npmCommand ?? 'npm'
  if (!targetVersion) throw new Error('missing targetVersion')

  const records = defaultValidateStagedPackageManifests({
    stagedDir,
    targetVersion,
  })
  const npmCache = mkdtempSync(join(tmpdir(), 'agent-qa-release-pack-cache-'))
  const npmEnv = {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_cache: npmCache,
    npm_config_logs_dir: join(npmCache, 'logs'),
  }
  delete npmEnv.npm_config_verify_deps_before_run

  try {
    for (const record of records) {
      const output = execFileSync(npmCommand, ['pack', '--dry-run', '--json'], {
        cwd: record.dir,
        encoding: 'utf8',
        env: npmEnv,
        stdio: 'pipe',
      })
      validatePackFiles(record, parsePackOutput(output, record.pkg.name))
    }
  } finally {
    rmSync(npmCache, { recursive: true, force: true })
  }
}

function runPublishSurfaceValidation(rootDir, execFileSync) {
  execFileSync(process.execPath, ['scripts/validate-publish-surface.mjs', '--quick'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
  })
}

function readNpmVersion(execFileSync) {
  return execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

function defaultReadTagCommit(version, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const tag = `v${version}`
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
      cwd: options.rootDir ?? process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim()
  } catch (error) {
    if (error.status === 1) throw new Error(`git tag is missing: ${tag}`)
    throw new Error(`could not read git tag: ${tag}`)
  }
}

function defaultReadHeadCommit(options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: options.rootDir ?? process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim()
}

async function runResumeVerification(options, rootDir, env) {
  const targetVersion = options.targetVersion
  if (!targetVersion) throw new Error('missing resume --target-version')
  if (semver.valid(targetVersion) !== targetVersion || !targetVersion.startsWith('0.')) {
    throw new Error(`invalid resume version: ${targetVersion} (expected 0.x semver)`)
  }
  const tag = `v${targetVersion}`
  const readerOptions = { ...options, rootDir }
  const readTagCommit = options.readTagCommit ?? defaultReadTagCommit
  const readHeadCommit = options.readHeadCommit ?? defaultReadHeadCommit
  const tagCommit = await readTagCommit(targetVersion, readerOptions)
  const headCommit = await readHeadCommit(readerOptions)
  if (!tagCommit || tagCommit !== headCommit) throw new Error(`HEAD is not the commit of ${tag}`)
  const packageVersion = assertSharedPublicVersion(getPublicPackages({ rootDir }))
  if (packageVersion !== targetVersion) {
    throw new Error(`public package version ${packageVersion} does not match ${targetVersion}`)
  }
  const isNpmVersionPresent =
    options.isNpmVersionPresent ??
    ((name, version) => npmVersionPresent(name, version, { execFileSync: options.execFileSync }))
  const subscriptionAuthOnNpm = isNpmVersionPresent(subscriptionAuthPackageName, targetVersion)
  const log = options.log ?? console.log
  if (subscriptionAuthOnNpm) {
    log(`already on npm: ${subscriptionAuthPackageName}@${targetVersion}, so its release is skipped`)
  }
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `version=${targetVersion}\nsubscription_auth_on_npm=${subscriptionAuthOnNpm}\n`,
      'utf8',
    )
  }
  return { targetVersion, subscriptionAuthOnNpm }
}

export async function runReleaseVerification(options = {}) {
  const stage = options.stage
  const bump = options.bump
  const rootDir = options.rootDir ?? process.cwd()
  const env = options.env ?? process.env
  if (stage === 'resume') return runResumeVerification(options, rootDir, env)
  assertAllowedBump(bump)

  if (stage === 'preflight') {
    if (!env.POSTHOG_PROJECT_KEY?.trim()) throw new Error('POSTHOG_PROJECT_KEY is required')
    const records = getPublicPackages({ rootDir })
    const currentVersion = assertSharedPublicVersion(records)
    const targetVersion = computeTargetVersion(currentVersion, bump)
    const releaseRecords = [
      ...records,
      { name: subscriptionAuthPackageName, pkg: { name: subscriptionAuthPackageName } },
    ]
    await (options.checkGitTagAbsent ?? defaultCheckGitTagAbsent)(targetVersion, options)
    await (options.checkNpmVersionsAbsent ?? defaultCheckNpmVersionsAbsent)(releaseRecords, targetVersion, options)
    return { targetVersion }
  }

  if (stage === 'postbuild') {
    const targetVersion = options.targetVersion
    const stagedDir = options.stagedDir
    if (!targetVersion) throw new Error('missing postbuild --target-version')
    if (!stagedDir) throw new Error('missing postbuild --staged-dir')
    const resolvedStagedDir = resolve(rootDir, stagedDir)
    const usesDefaultStagedChecks = !options.validateStagedPackageManifests || !options.validateStagedPackDryRuns
    if (usesDefaultStagedChecks && !existsSync(resolvedStagedDir)) {
      throw new Error(`staged package directory is missing: ${stagedDir}`)
    }

    ;(options.validatePublishSurface ?? (() => runPublishSurfaceValidation(rootDir, options.execFileSync ?? defaultExecFileSync)))()
    ;(options.validateStagedPackageManifests ?? defaultValidateStagedPackageManifests)({
      stagedDir: resolvedStagedDir,
      targetVersion,
    })
    ;(options.validatePosthogReleaseArtifacts ?? defaultValidatePosthogReleaseArtifacts)({
      rootDir,
      stagedDir: resolvedStagedDir,
      projectKey: env.POSTHOG_PROJECT_KEY,
      env,
    })
    ;(options.validateStagedPackDryRuns ?? validateStagedPackDryRuns)({
      stagedDir: resolvedStagedDir,
      targetVersion,
      execFileSync: options.execFileSync,
    })
    const execFileSync = options.execFileSync ?? defaultExecFileSync
    ;(options.assertTrustedPublishEnvironment ?? defaultAssertTrustedPublishEnvironment)({
      env,
      npmVersion: options.npmVersion ?? readNpmVersion(execFileSync),
    })
    return { targetVersion, stagedDir: resolvedStagedDir }
  }

  throw new Error(`invalid args: --stage ${stage}`)
}

export function parseReleaseArgs(argv = []) {
  let bump
  let stage
  let targetVersion
  let stagedDir
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--bump') {
      bump = argv[index + 1]
      index += 1
    } else if (arg === '--stage') {
      stage = argv[index + 1]
      index += 1
    } else if (arg === '--target-version') {
      targetVersion = argv[index + 1]
      index += 1
    } else if (arg === '--staged-dir') {
      stagedDir = argv[index + 1]
      index += 1
    } else {
      throw new Error(`invalid args: ${argv.join(' ')}`)
    }
  }
  if (stage === 'resume') {
    if (bump || stagedDir) throw new Error('invalid args: resume accepts only --target-version')
    if (!targetVersion) throw new Error('missing --target-version')
    return { stage, targetVersion }
  }
  if (!bump) throw new Error('missing --bump')
  assertAllowedBump(bump)
  if (stage !== 'preflight' && stage !== 'postbuild') throw new Error(`invalid args: --stage ${stage}`)
  if (stage === 'preflight' && (targetVersion || stagedDir)) throw new Error('invalid args: preflight does not accept postbuild args')
  if (stage === 'postbuild') {
    if (!targetVersion) throw new Error('missing --target-version')
    if (!stagedDir) throw new Error('missing --staged-dir')
  }
  return {
    bump,
    stage,
    ...(targetVersion ? { targetVersion } : {}),
    ...(stagedDir ? { stagedDir } : {}),
  }
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseReleaseArgs(argv)
  return runReleaseVerification({ ...options, ...parsed })
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
