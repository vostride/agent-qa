import { execFileSync as defaultExecFileSync } from 'node:child_process'
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

export function createReleaseCommitAndTag(version, options = {}) {
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const cwd = options.rootDir ?? process.cwd()
  execFileSync('git', ['config', 'user.name', options.gitUserName ?? 'github-actions[bot]'], { cwd })
  execFileSync('git', ['config', 'user.email', options.gitUserEmail ?? '41898282+github-actions[bot]@users.noreply.github.com'], { cwd })
  execFileSync('git', ['add', '--', 'packages/*/package.json'], { cwd })
  execFileSync('git', ['commit', '-m', `release: agent-qa v${version}`], { cwd })
  execFileSync('git', ['tag', '-a', `v${version}`, '-m', `agent-qa v${version}`], { cwd })
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
  createReleaseCommitAndTag(version, options)
  return version
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
