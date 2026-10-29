// A final authored test is written by `publishAuthoredTest`; HEAD, index and history never move.

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as cliHost from '../composition/local-agent-host.js'
import { createDraftAuthoringPort, publishAuthoredTest } from '../composition/local-agent-host.js'

const DRAFT_BYTES = `name: The coupon banner appears after a code is applied
target: local-form
steps:
  - Open the cart
  - Apply the coupon FREESHIP
  - Verify the coupon banner is visible
`

const TARGET_PATH = 'tests/coupon-banner.yaml'

let root: string
let configPath: string
let draftPath: string

function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** What git holds: the tip, the history length, the index and what is staged. */
function repository(): { head: string; count: string; index: string; staged: string } {
  return {
    head: git('rev-parse', 'HEAD').stdout.trim(),
    count: git('rev-list', '--count', 'HEAD').stdout.trim(),
    index: git('ls-files', '--stage').stdout,
    staged: git('diff', '--cached', '--name-status').stdout,
  }
}

/** Every file under the workspace with its bytes — the instrument for "the tree is unchanged". */
function treeSnapshot(dir = root, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === '.git') continue
    const child = join(dir, name.name)
    const key = prefix === '' ? name.name : `${prefix}/${name.name}`
    if (name.isDirectory()) Object.assign(out, treeSnapshot(child, key))
    else out[key] = createHash('sha256').update(readFileSync(child)).digest('hex')
  }
  return out
}

function publish(overrides: { targetPath?: string; sourceDigest?: string } = {}) {
  return publishAuthoredTest({
    configPath,
    request: {
      draftPath,
      targetPath: overrides.targetPath ?? TARGET_PATH,
      ...(overrides.sourceDigest === undefined ? {} : { sourceDigest: overrides.sourceDigest }),
    },
  })
}

function commitTarget(bytes: string | Buffer, message: string): void {
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, TARGET_PATH), bytes)
  git('add', '--', TARGET_PATH)
  git('commit', '--quiet', '-m', message)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'one-commit-apply-'))
  configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `workspace:
  testMatch:
    - tests/**/*.yaml
`,
  )
  mkdirSync(join(root, 'tests', '.agent-qa-drafts'), { recursive: true })
  draftPath = 'tests/.agent-qa-drafts/deadbeef.yaml'
  writeFileSync(join(root, draftPath), DRAFT_BYTES)

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa apply test')
  git('config', 'user.email', 'apply-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), 'tests/.agent-qa-drafts/\n')
  writeFileSync(join(root, 'README.md'), 'seeded\n')
  git('add', '--', '.gitignore', 'README.md', 'agent-qa.config.yaml')
  git('commit', '--quiet', '-m', 'seed')
  if (git('status', '--porcelain').stdout.trim() !== '') {
    throw new Error(`the fixture repository is not clean: ${git('status', '--porcelain').stdout}`)
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('publishAuthoredTest (the direct writer)', () => {
  it('the host exports no one-commit apply, index helpers or git exec seam', () => {
    const exported = Object.keys(cliHost)
    for (const name of [
      'applyTestDraftAsOneCommit', 'createTestDraftApplyPort', 'captureIndexEntry', 'restoreIndexEntry',
      'runGitAdd', 'runGitCommit', 'runGitHeadHash', 'runGitStatusPorcelain', 'APPLY_GIT_TIMEOUT_MS',
      'DirtyApplyTargetError', 'GitUnavailableForApplyError', 'ApplyTargetChangedError',
      'ApplyCommitHashUnavailableError', 'ApplyProducedNoChangeError', 'ApplyRollbackFailedError',
    ]) {
      expect(exported, name).not.toContain(name)
    }
    expect(exported).toContain('publishAuthoredTest')
  })

  it('writes the draft to its target and makes no commit', () => {
    const before = repository()

    expect(publish()).toMatchObject({ kind: 'written', filePath: TARGET_PATH })

    expect(readFileSync(join(root, TARGET_PATH), 'utf8')).toBe(DRAFT_BYTES)
    expect(repository()).toEqual(before)
    expect(git('status', '--porcelain', '--', TARGET_PATH).stdout.trim()).toBe(`?? ${TARGET_PATH}`)
  })

  it('writes into a dirty, partly staged tree and stages nothing', () => {
    commitTarget('name: a person\'s own version\n', 'a person committed this test')
    const read = createHash('sha256').update(readFileSync(join(root, TARGET_PATH))).digest('hex')
    writeFileSync(join(root, 'README.md'), 'staged by a person\n')
    git('add', '--', 'README.md')
    writeFileSync(join(root, 'notes.md'), 'dirty and untracked\n')
    const before = repository()

    expect(publish({ sourceDigest: read })).toMatchObject({ kind: 'written' })

    expect(repository()).toEqual(before)
    expect(git('diff', '--cached', '--name-only').stdout.trim()).toBe('README.md')
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('dirty and untracked\n')
  })

  it('writes with no repository at all, because it never asks git anything', () => {
    rmSync(join(root, '.git'), { recursive: true, force: true })

    expect(publish()).toMatchObject({ kind: 'written', filePath: TARGET_PATH })
    expect(readFileSync(join(root, TARGET_PATH), 'utf8')).toBe(DRAFT_BYTES)
  })

  it('refuses by name when the target changed between the read and the write', () => {
    commitTarget('name: the version the draft was built over\n', 'a person committed this test')
    const read = createHash('sha256').update(readFileSync(join(root, TARGET_PATH))).digest('hex')
    commitTarget('name: somebody else edited it since\n', 'somebody else edited it')
    const before = treeSnapshot()
    const history = repository()

    expect(publish({ sourceDigest: read })).toEqual({
      kind: 'not-written', targetPath: TARGET_PATH, reason: 'target-changed',
    })
    expect(treeSnapshot()).toEqual(before)
    expect(repository()).toEqual(history)
  })

  it('applies when the sourceDigest still matches the target on disk', () => {
    commitTarget('name: the version the draft was built over\n', 'a person committed this test')
    const read = createHash('sha256').update(readFileSync(join(root, TARGET_PATH))).digest('hex')

    expect(publish({ sourceDigest: read })).toMatchObject({ kind: 'written', filePath: TARGET_PATH })
    expect(readFileSync(join(root, TARGET_PATH), 'utf8')).toBe(DRAFT_BYTES)
  })

  it('refuses by name when the request carries no sourceDigest and the target now exists', () => {
    commitTarget('name: created by somebody else\n', 'a person committed this test')

    expect(publish()).toMatchObject({ kind: 'not-written', reason: 'target-changed' })
    expect(readFileSync(join(root, TARGET_PATH), 'utf8')).toBe('name: created by somebody else\n')
  })

  it('refuses a target that escapes the workspace, by the computation that mints the identity', () => {
    const before = treeSnapshot()
    expect(publish({ targetPath: '../escape.yaml' })).toMatchObject({
      kind: 'not-written', reason: 'outside-workspace',
    })
    expect(treeSnapshot()).toEqual(before)
  })
})

// The writer never touches the index, so a failed write leaves the target and index unchanged.
/** Whether a read-only directory refuses this process a write: not as root, and not on Windows. */
const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0

describe('a FAILED apply leaves the repository exactly as it found it', () => {
  // A read-only directory does not stop root or Windows, so the cell runs elsewhere and checks it.
  it.runIf(canDenyWrites)('a write that fails leaves the target\'s bytes, the index and the history untouched, and no temp behind', () => {
    commitTarget('name: the version the draft was built over\n', 'a person committed this test')
    const read = createHash('sha256').update(readFileSync(join(root, TARGET_PATH))).digest('hex')
    git('add', '--', TARGET_PATH)
    const before = treeSnapshot()
    const history = repository()

    chmodSync(join(root, 'tests'), 0o555)
    let outcome: ReturnType<typeof publish>
    try {
      expect(() => writeFileSync(join(root, 'tests', '.seal-probe'), ''), 'the directory still accepts writes')
        .toThrow()
      outcome = publish({ sourceDigest: read })
    } finally {
      chmodSync(join(root, 'tests'), 0o755)
    }

    expect(outcome).toMatchObject({ kind: 'not-written', reason: 'write-failed' })
    expect(treeSnapshot()).toEqual(before)
    expect(repository()).toEqual(history)
  })
})

// Built from numbers so this file stays ASCII; the hazard bytes sit in a trailing comment.
const NON_UTF8_TARGET_BYTES = Buffer.concat([
  Buffer.from(
    'test-id: t_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle\n'
    + 'name: a person\'s committed test\n'
    + 'target: local-form\n'
    + 'steps:\n'
    + '  - Open the cart # ',
    'ascii',
  ),
  Buffer.from([0xc3, 0x28, 0xff, 0xfe]),
  Buffer.from('\n', 'ascii'),
])

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Through `parseDraft`, the one producer of `sourceDigest`, so no cell pins a digest nothing emits.
async function sourceDigestThroughTheProducer(): Promise<string> {
  const outcome = await createDraftAuthoringPort(configPath).parseDraft(TARGET_PATH)
  expect(outcome.kind).toBe('parsed')
  return (outcome as { draft: { contentDigest: string } }).draft.contentDigest
}

// Checks the harness kept the bytes and that a decode round-trip changes them.
function assertNonUtf8BytesSurviveTheHarness(absolutePath: string, expected: Buffer): void {
  const onDisk = readFileSync(absolutePath)
  expect(onDisk.equals(expected)).toBe(true)
  expect(Buffer.from(onDisk.toString('utf8'), 'utf8').equals(onDisk)).toBe(false)
}


// The writer digests and writes raw bytes, so an untouched non-UTF-8 target is accepted and kept.
describe('the write is INSIDE the rollback\'s reach, and both halves are bytes', () => {
  it('digests the target\'s RAW BYTES, so a target that is not valid UTF-8 still matches the request', async () => {
    commitTarget(NON_UTF8_TARGET_BYTES, 'a person committed a test whose bytes are not UTF-8')
    assertNonUtf8BytesSurviveTheHarness(join(root, TARGET_PATH), NON_UTF8_TARGET_BYTES)

    expect(publish({ sourceDigest: await sourceDigestThroughTheProducer() }))
      .toMatchObject({ kind: 'written', filePath: TARGET_PATH })
    expect(readFileSync(join(root, TARGET_PATH), 'utf8')).toBe(DRAFT_BYTES)
  })

  it('leaves a non-UTF-8 target BYTE-IDENTICAL when the write fails', async () => {
    commitTarget(NON_UTF8_TARGET_BYTES, 'a person committed a test whose bytes are not UTF-8')
    assertNonUtf8BytesSurviveTheHarness(join(root, TARGET_PATH), NON_UTF8_TARGET_BYTES)
    const beforeSha = sha256File(join(root, TARGET_PATH))
    const sourceDigest = await sourceDigestThroughTheProducer()

    const outcome = publishAuthoredTest({
      configPath,
      request: { draftPath, targetPath: TARGET_PATH, sourceDigest },
      writeTarget: () => { throw new Error('the disk is full') },
    })

    expect(outcome).toMatchObject({ kind: 'not-written', reason: 'write-failed', detail: 'the disk is full' })
    expect(sha256File(join(root, TARGET_PATH))).toBe(beforeSha)
    expect(readFileSync(join(root, TARGET_PATH)).equals(NON_UTF8_TARGET_BYTES)).toBe(true)
  })
})

// The producer and the writer hash raw bytes alike, or a clean non-UTF-8 target is refused forever.
describe('the digest the producer emits is the digest the apply computes', () => {
  it('ACCEPTS an untouched non-UTF-8 target whose sourceDigest came through parseDraft', async () => {
    commitTarget(NON_UTF8_TARGET_BYTES, 'a person committed a test whose bytes are not UTF-8')
    assertNonUtf8BytesSurviveTheHarness(join(root, TARGET_PATH), NON_UTF8_TARGET_BYTES)

    const produced = await sourceDigestThroughTheProducer()

    const overTheBytes = createHash('sha256').update(NON_UTF8_TARGET_BYTES).digest('hex')
    const overTheDecoding = createHash('sha256')
      .update(NON_UTF8_TARGET_BYTES.toString('utf8')).digest('hex')
    expect(overTheDecoding).not.toBe(overTheBytes)
    expect(produced).toBe(overTheBytes)

    expect(publish({ sourceDigest: produced })).toMatchObject({ kind: 'written', filePath: TARGET_PATH })
    expect(readFileSync(join(root, TARGET_PATH), 'utf8')).toBe(DRAFT_BYTES)
  })

  it('mints the digest over the file\'s RAW BYTES in the PRODUCER, with no apply in the reading', async () => {
    writeFileSync(join(root, TARGET_PATH), NON_UTF8_TARGET_BYTES)
    assertNonUtf8BytesSurviveTheHarness(join(root, TARGET_PATH), NON_UTF8_TARGET_BYTES)

    const produced = await sourceDigestThroughTheProducer()

    const overTheBytes = createHash('sha256').update(NON_UTF8_TARGET_BYTES).digest('hex')
    const overTheDecoding = createHash('sha256')
      .update(NON_UTF8_TARGET_BYTES.toString('utf8')).digest('hex')
    expect(overTheDecoding).not.toBe(overTheBytes)
    expect(produced).toBe(overTheBytes)
  })

  it('REFUSES by name when the target\'s bytes really changed between the parse and the apply', async () => {
    commitTarget(NON_UTF8_TARGET_BYTES, 'a person committed a test whose bytes are not UTF-8')
    const produced = await sourceDigestThroughTheProducer()

    const movedUnderTheRequest = Buffer.concat([
      NON_UTF8_TARGET_BYTES,
      Buffer.from('  - Apply the coupon FREESHIP\n', 'ascii'),
    ])
    commitTarget(movedUnderTheRequest, 'somebody else edited the same test')
    expect(readFileSync(join(root, TARGET_PATH)).equals(NON_UTF8_TARGET_BYTES)).toBe(false)

    const before = treeSnapshot()
    const history = repository()
    expect(publish({ sourceDigest: produced })).toEqual({
      kind: 'not-written', targetPath: TARGET_PATH, reason: 'target-changed',
    })
    expect(treeSnapshot()).toEqual(before)
    expect(repository()).toEqual(history)
  })
})
