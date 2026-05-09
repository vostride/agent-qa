import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import semver from 'semver'
import { getPublicPackages } from './packages.mjs'

const dependencyBlocks = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const internalPackagePrefix = '@vostride/agent-qa-'

export function assertAllowedBump(bump) {
  if (bump !== 'patch' && bump !== 'minor') {
    throw new Error('Release bump must be patch or minor')
  }
  return bump
}

export function computeTargetVersion(currentVersion, bump) {
  assertAllowedBump(bump)
  if (!semver.valid(currentVersion)) {
    throw new Error(`invalid shared package version: ${currentVersion}`)
  }
  const targetVersion = semver.inc(currentVersion, bump)
  if (!targetVersion || !targetVersion.startsWith('0.')) {
    throw new Error('Release target left the 0.x.x line')
  }
  return targetVersion
}

export function assertSharedPublicVersion(records) {
  const versions = new Set(records.map(record => record.pkg?.version).filter(Boolean))
  if (versions.size !== 1) {
    throw new Error(`public package versions must match, found: ${[...versions].join(', ') || 'none'}`)
  }
  const [version] = versions
  if (!semver.valid(version) || !version.startsWith('0.')) {
    throw new Error(`public package version must be valid v0 semver: ${version}`)
  }
  return version
}

export function rewriteInternalWorkspaceRanges(pkg, targetVersion) {
  const next = JSON.parse(JSON.stringify(pkg))
  for (const blockName of dependencyBlocks) {
    const block = next[blockName]
    if (!block || typeof block !== 'object') continue
    for (const [name, range] of Object.entries(block)) {
      if (name.startsWith(internalPackagePrefix) && range === 'workspace:*') {
        block[name] = targetVersion
      }
    }
  }
  return next
}

function parseArgs(argv) {
  let bump
  let write = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--bump') {
      bump = argv[index + 1]
      index += 1
    } else if (arg === '--write') {
      write = true
    } else {
      throw new Error(`invalid args: ${argv.join(' ')}`)
    }
  }
  if (!bump) throw new Error('missing --bump')
  assertAllowedBump(bump)
  return { bump, write }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const { bump, write } = parseArgs(argv)
  const records = getPublicPackages({ rootDir: options.rootDir })
  const currentVersion = assertSharedPublicVersion(records)
  const targetVersion = computeTargetVersion(currentVersion, bump)

  if (write) {
    for (const record of records) {
      const pkg = JSON.parse(readFileSync(record.manifestPath, 'utf8'))
      pkg.version = targetVersion
      writeJson(record.manifestPath, pkg)
    }
  }

  const output = options.output ?? process.stdout
  output.write?.(`${targetVersion}\n`)
  const githubOutput = options.env?.GITHUB_OUTPUT ?? process.env.GITHUB_OUTPUT
  if (githubOutput) {
    appendFileSync(githubOutput, `version=${targetVersion}\n`, 'utf8')
  }
  return targetVersion
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
