import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { getPublicPackages } from './packages.mjs'
import { assertSharedPublicVersion } from './version.mjs'

export function checkGitTagAbsent(version, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const cwd = options.rootDir ?? process.cwd()
  const tag = `v${version}`
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    throw new Error(`git tag already exists: ${tag}`)
  } catch (error) {
    if (error.message?.startsWith('git tag already exists:')) throw error
    if (error.status === 1) return
    throw new Error(`could not verify git tag absence: ${tag}`)
  }
}

// The bot identity is passed per command so it never lands in the repository's config.
export function createReleaseCommitAndTag(version, manifestPaths, options = {}) {
  if (typeof options.rootDir !== 'string') {
    throw new Error('createReleaseCommitAndTag needs options.rootDir, the repository to commit in')
  }
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const cwd = options.rootDir
  const identity = [
    '-c',
    `user.name=${options.gitUserName ?? 'github-actions[bot]'}`,
    '-c',
    `user.email=${options.gitUserEmail ?? '41898282+github-actions[bot]@users.noreply.github.com'}`,
  ]
  execFileSync('git', ['add', '--', ...manifestPaths], { cwd })
  execFileSync('git', [...identity, 'commit', '-m', `release: agent-qa v${version}`], { cwd })
  execFileSync('git', [...identity, 'tag', '-a', `v${version}`, '-m', `agent-qa v${version}`], { cwd })
}

export function parseReleaseArgs(argv = []) {
  if (argv.length !== 1 || argv[0] !== '--commit-tag') {
    throw new Error(`invalid args: node scripts/release/git.mjs --commit-tag`)
  }
  return { mode: 'commit-tag' }
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  parseReleaseArgs(argv)
  const records = getPublicPackages({ rootDir: options.rootDir })
  const version = assertSharedPublicVersion(records)
  const cwd = options.rootDir ?? process.cwd()
  const manifestPaths = records.map(record => relative(cwd, record.manifestPath))
  createReleaseCommitAndTag(version, manifestPaths, { ...options, rootDir: cwd })
  return version
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
