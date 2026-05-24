import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  buildReleaseFooter,
  composeReleaseNotes,
  parseGithubReleaseArgs,
  publishGithubRelease,
} from '../release/github-release.mjs'

function notFoundError() {
  const error = new Error('release not found')
  error.status = 1
  return error
}

function unexpectedViewError() {
  const error = new Error('git repository unavailable')
  error.status = 128
  return error
}

function generatedNotes(body = '## Changes\n\n- Shipped release automation') {
  return JSON.stringify({
    name: 'Ignored generated title',
    body,
  })
}

test('parses GitHub release CLI args with explicit or Actions repository', () => {
  assert.deepEqual(parseGithubReleaseArgs(['--version', '0.1.1', '--repo', 'vostride/agent-qa']), {
    version: '0.1.1',
    repo: 'vostride/agent-qa',
  })
  assert.deepEqual(parseGithubReleaseArgs(['--version', '0.1.1'], {
    env: { GITHUB_REPOSITORY: 'vostride/agent-qa' },
  }), {
    version: '0.1.1',
    repo: 'vostride/agent-qa',
  })
  assert.throws(() => parseGithubReleaseArgs(['--repo', 'vostride/agent-qa']), /missing --version/)
  assert.throws(() => parseGithubReleaseArgs(['--version', '1.0.0', '--repo', 'vostride/agent-qa']), /valid v0 semver/)
  assert.throws(() => parseGithubReleaseArgs(['--version', '0.1.1', '--repo', 'bad']), /owner\/name/)
})

test('composes generated release notes before the stable public footer', () => {
  const footer = buildReleaseFooter('0.1.1')
  const notes = composeReleaseNotes({
    generatedBody: '## Changes\n\n- Added GitHub Releases',
    footer,
  })

  assert.ok(notes.indexOf('## Changes') < notes.indexOf('npm package'))
  assert.match(notes, /https:\/\/www\.npmjs\.com\/package\/agent-qa/)
  assert.match(notes, /https:\/\/hub\.docker\.com\/u\/vostride/)
  assert.match(notes, /https:\/\/vostride\.com\/docs\/agent-qa/)
  assert.doesNotMatch(notes, /\/Users|POSTHOG|TOKEN|agent-qa\.local\.yaml/)
})

test('creates a missing GitHub release with generated notes and --verify-tag', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-github-release-create-'))
  try {
    const calls = []
    publishGithubRelease({
      version: '0.1.1',
      repo: 'vostride/agent-qa',
    }, {
      mkdtempSync: () => tempDir,
      rmSync: () => {},
      execFileSync: (cmd, args, options) => {
        calls.push([cmd, args, options?.cwd])
        if (cmd === 'gh' && args[0] === 'api') return generatedNotes()
        if (cmd === 'gh' && args[0] === 'release' && args[1] === 'view') throw notFoundError()
        return ''
      },
    })

    const apiCall = calls.find(([cmd, args]) => cmd === 'gh' && args[0] === 'api')
    assert.deepEqual(apiCall.slice(0, 2), [
      'gh',
      ['api', 'repos/vostride/agent-qa/releases/generate-notes', '-f', 'tag_name=v0.1.1'],
    ])

    const createCall = calls.find(([cmd, args]) => cmd === 'gh' && args[0] === 'release' && args[1] === 'create')
    assert.ok(createCall, 'expected gh release create call')
    assert.deepEqual(createCall[1].slice(0, 6), [
      'release',
      'create',
      'v0.1.1',
      '--repo',
      'vostride/agent-qa',
      '--title',
    ])
    assert.equal(createCall[1].includes('--verify-tag'), true)
    assert.equal(createCall[1].includes('--latest'), true)
    assert.equal(createCall[1].includes('--notes-file'), true)

    const notesFile = createCall[1][createCall[1].indexOf('--notes-file') + 1]
    const notes = readFileSync(notesFile, 'utf8')
    assert.ok(notes.indexOf('## Changes') < notes.indexOf('npm package'))
    assert.match(notes, /https:\/\/www\.npmjs\.com\/package\/agent-qa/)
    assert.match(notes, /https:\/\/hub\.docker\.com\/u\/vostride/)
    assert.match(notes, /https:\/\/vostride\.com\/docs\/agent-qa/)
    assert.equal(calls.some(([, args]) => args.includes('edit')), false)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('updates an existing GitHub release instead of creating a duplicate', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-github-release-edit-'))
  try {
    const calls = []
    publishGithubRelease({
      version: '0.1.1',
      repo: 'vostride/agent-qa',
    }, {
      mkdtempSync: () => tempDir,
      rmSync: () => {},
      execFileSync: (cmd, args) => {
        calls.push([cmd, args])
        if (cmd === 'gh' && args[0] === 'api') return generatedNotes()
        if (cmd === 'gh' && args[0] === 'release' && args[1] === 'view') return JSON.stringify({ tagName: 'v0.1.1' })
        return ''
      },
    })

    const editCall = calls.find(([cmd, args]) => cmd === 'gh' && args[0] === 'release' && args[1] === 'edit')
    assert.ok(editCall, 'expected gh release edit call')
    assert.deepEqual(editCall[1].slice(0, 5), ['release', 'edit', 'v0.1.1', '--repo', 'vostride/agent-qa'])
    assert.equal(editCall[1].includes('--notes-file'), true)
    assert.equal(editCall[1].includes('--latest'), true)
    assert.equal(calls.some(([, args]) => args.includes('create')), false)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('does not create a release after an unexpected gh release view failure', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-github-release-error-'))
  try {
    const calls = []
    assert.throws(() => publishGithubRelease({
      version: '0.1.1',
      repo: 'vostride/agent-qa',
    }, {
      mkdtempSync: () => tempDir,
      rmSync: () => {},
      execFileSync: (cmd, args) => {
        calls.push([cmd, args])
        if (cmd === 'gh' && args[0] === 'api') return generatedNotes()
        if (cmd === 'gh' && args[0] === 'release' && args[1] === 'view') throw unexpectedViewError()
        return ''
      },
    }), /could not inspect GitHub release v0\.1\.1/)
    assert.equal(calls.some(([, args]) => args.includes('create')), false)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
