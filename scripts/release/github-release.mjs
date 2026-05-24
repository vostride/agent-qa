import { execFileSync as defaultExecFileSync } from 'node:child_process'
import { mkdtempSync as defaultMkdtempSync, rmSync as defaultRmSync, writeFileSync as defaultWriteFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'

function releaseTag(version) {
  return `v${version}`
}

function validateVersion(version) {
  if (!semver.valid(version) || !version.startsWith('0.')) {
    throw new Error(`GitHub release version must be valid v0 semver: ${version ?? 'missing'}`)
  }
}

function validateRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) {
    throw new Error(`GitHub release repo must be owner/name: ${repo ?? 'missing'}`)
  }
}

function ghOptions(options = {}) {
  return {
    cwd: options.rootDir ?? process.cwd(),
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'pipe',
  }
}

export function parseGithubReleaseArgs(argv = [], options = {}) {
  let version
  let repo
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version') {
      version = argv[index + 1]
      index += 1
    } else if (arg === '--repo') {
      repo = argv[index + 1]
      index += 1
    } else {
      throw new Error(`invalid args: ${argv.join(' ')}`)
    }
  }

  if (!version) throw new Error('missing --version')
  validateVersion(version)
  repo ??= options.env?.GITHUB_REPOSITORY ?? process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('missing --repo or GITHUB_REPOSITORY')
  validateRepo(repo)
  return { version, repo }
}

export function buildReleaseFooter() {
  return [
    '---',
    'npm package: https://www.npmjs.com/package/agent-qa',
    'Docker images: https://hub.docker.com/u/vostride',
    'Docs: https://vostride.com/docs/agent-qa',
    'Update: update the agent-qa dev dependency in your project with your package manager.',
  ].join('\n')
}

export function composeReleaseNotes({ generatedBody, footer = buildReleaseFooter() } = {}) {
  const body = generatedBody?.trim() || '_No generated release notes were returned._'
  return `${body}\n\n${footer.trim()}\n`
}

export function generateReleaseNotes({ version, repo }, options = {}) {
  validateVersion(version)
  validateRepo(repo)
  const tag = releaseTag(version)
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const output = execFileSync('gh', [
    'api',
    `repos/${repo}/releases/generate-notes`,
    '-f',
    `tag_name=${tag}`,
  ], ghOptions(options))
  const parsed = JSON.parse(output)
  return {
    title: `agent-qa ${tag}`,
    body: parsed.body ?? '',
  }
}

export function githubReleaseExists({ version, repo }, options = {}) {
  validateVersion(version)
  validateRepo(repo)
  const tag = releaseTag(version)
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName'], ghOptions(options))
    return true
  } catch (error) {
    if (error.status === 1) return false
    throw new Error(`could not inspect GitHub release ${tag}: ${error.message}`)
  }
}

export function publishGithubRelease({ version, repo }, options = {}) {
  validateVersion(version)
  validateRepo(repo)
  const tag = releaseTag(version)
  const execFileSync = options.execFileSync ?? defaultExecFileSync
  const mkdtempSync = options.mkdtempSync ?? defaultMkdtempSync
  const writeFileSync = options.writeFileSync ?? defaultWriteFileSync
  const rmSync = options.rmSync ?? defaultRmSync
  const tempDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'agent-qa-github-release-'))
  const notesPath = join(tempDir, `${tag}-notes.md`)

  try {
    const generated = generateReleaseNotes({ version, repo }, options)
    writeFileSync(notesPath, composeReleaseNotes({
      generatedBody: generated.body,
      footer: buildReleaseFooter(version),
    }), 'utf8')

    const exists = githubReleaseExists({ version, repo }, options)
    const baseArgs = [
      tag,
      '--repo',
      repo,
      '--title',
      generated.title,
      '--notes-file',
      notesPath,
      '--latest',
    ]
    if (exists) {
      execFileSync('gh', ['release', 'edit', ...baseArgs], ghOptions(options))
      return { action: 'updated', repo, tag, title: generated.title }
    }

    execFileSync('gh', ['release', 'create', ...baseArgs, '--verify-tag'], ghOptions(options))
    return { action: 'created', repo, tag, title: generated.title }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseGithubReleaseArgs(argv, options)
  return publishGithubRelease(parsed, options)
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
