// A final authored test is written straight to its target, over the CLI host's
// real writer, a real workspace and — where a repository exists — a real git repository.
//
// RE-SPELLED IN PLACE, 2026-09-30. This file used to prove that ACCEPTING a `test-draft` proposal
// wrote it and made one commit of one file. Nothing waits for acceptance now and agent-qa
// makes no commits, so every claim here keeps its subject — the bytes that land at the target — and
// measures the direct write instead: the exact bytes, the workspace boundary and the source-digest
// guard the old apply checked, no commit, no index change, success in a dirty tree and without git,
// no bytes for a rejected draft, and a failed write reported as not written.
//
// WHY THIS FILE IS IN `packages/cli`. The writer needs `workspaceRelativeIdentityPath` from
// `@vostride/agent-qa-core`, which neither `agent` nor `agent-local` may name, so the CLI host is the
// only place the loop, the real writer and a real repository can be in one process.

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { runAuthoringLoop } from '@vostride/agent-qa-agent'
import type { DraftShelfPortLike } from '@vostride/agent-qa-agent'
import type { AuthoringBrief, DraftDisposition, DraftReceipt } from '@vostride/agent-qa-schema'
import { CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as localHost from '../composition/local-agent-host.js'

const DRAFT_PATH = 'tests/.agent-qa-drafts/abc123.yaml'
const TARGET_PATH = 'tests/the-coupon-banner-appears.yaml'

// UTF-8 beyond ASCII, and one byte that is not UTF-8 at all inside a comment: a writer that went
// through a string anywhere would turn the last into U+FFFD and fail the byte comparison.
const DRAFT_BYTES = Buffer.concat([
  Buffer.from('# café ✓ — checks the coupon banner, byte '),
  Buffer.from([0xff]),
  Buffer.from(`
name: The coupon banner appears
target: local-form
steps:
  - Open the cart
  - Apply the coupon FREESHIP
  - Verify the coupon banner is visible
`),
])

interface PublishRequest {
  readonly draftPath: string
  readonly targetPath: string
  readonly sourceDigest?: string
}

type Publish = (input: {
  readonly configPath: string
  readonly request: PublishRequest
  readonly writeTarget?: (absolutePath: string, bytes: Buffer) => void
}) => unknown

/** The writer under test, reached by name so an absent export is an assertion rather than a crash. */
function publisher(): Publish {
  const publish = (localHost as Record<string, unknown>)['publishAuthoredTest']
  expect(typeof publish).toBe('function')
  return publish as Publish
}

let root: string
let configPath: string

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return result.stdout
}

/** Everything a commit or a stage would move, read before and after the write. */
function repositorySnapshot(): Record<string, string> {
  return {
    head: git('rev-parse', 'HEAD').trim(),
    count: git('rev-list', '--count', 'HEAD').trim(),
    index: git('ls-files', '--stage'),
    cached: git('diff', '--cached', '--name-status'),
  }
}

function initRepository(): void {
  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa direct write test')
  git('config', 'user.email', 'direct-write-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), 'tests/.agent-qa-drafts/\n')
  writeFileSync(join(root, 'README.md'), 'seeded\n')
  git('add', '--', '.gitignore', 'README.md', 'agent-qa.config.yaml')
  git('commit', '--quiet', '-m', 'seed')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'test-direct-write-'))
  configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `workspace:
  testMatch:
    - tests/**/*.yaml
`,
  )
  mkdirSync(join(root, 'tests', '.agent-qa-drafts'), { recursive: true })
  writeFileSync(join(root, DRAFT_PATH), DRAFT_BYTES)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a final authored test is written directly to its target', () => {
  it('writes the draft bytes exactly, and HEAD, the index and the history do not move', () => {
    initRepository()
    const before = repositorySnapshot()

    const outcome = publisher()({
      configPath,
      request: { draftPath: DRAFT_PATH, targetPath: TARGET_PATH },
    })

    expect(outcome).toEqual({
      kind: 'written',
      filePath: TARGET_PATH,
      contentDigest: sha256(DRAFT_BYTES),
    })
    expect(readFileSync(join(root, TARGET_PATH)).equals(DRAFT_BYTES)).toBe(true)
    expect(repositorySnapshot()).toEqual(before)
    // A plain uncommitted edit: `git status` shows it and `git restore`/deleting it reverts it.
    expect(git('status', '--porcelain', '--', TARGET_PATH).trim()).toBe(`?? ${TARGET_PATH}`)
    // No sibling temp is left beside the written test.
    expect(readdirSync(join(root, 'tests')).sort())
      .toEqual(['.agent-qa-drafts', 'the-coupon-banner-appears.yaml'])
  })

  it("writes into a dirty tree and leaves a person's staged and unstaged work alone", () => {
    initRepository()
    writeFileSync(join(root, 'README.md'), 'seeded\nstaged edit\n')
    git('add', '--', 'README.md')
    writeFileSync(join(root, 'README.md'), 'seeded\nstaged edit\nunstaged edit\n')
    writeFileSync(join(root, 'notes.txt'), 'untracked\n')
    const before = repositorySnapshot()

    const outcome = publisher()({
      configPath,
      request: { draftPath: DRAFT_PATH, targetPath: TARGET_PATH },
    })

    expect(outcome).toMatchObject({ kind: 'written', filePath: TARGET_PATH })
    expect(readFileSync(join(root, TARGET_PATH)).equals(DRAFT_BYTES)).toBe(true)
    expect(repositorySnapshot()).toEqual(before)
    expect(git('diff', '--cached', '--name-only').trim()).toBe('README.md')
    expect(readFileSync(join(root, 'README.md'), 'utf8'))
      .toBe('seeded\nstaged edit\nunstaged edit\n')
  })

  it('writes with no repository and no git on PATH', () => {
    const savedPath = process.env['PATH']
    process.env['PATH'] = ''
    let outcome: unknown
    try {
      outcome = publisher()({
        configPath,
        request: { draftPath: DRAFT_PATH, targetPath: TARGET_PATH },
      })
    } finally {
      process.env['PATH'] = savedPath
    }

    expect(outcome).toMatchObject({ kind: 'written', filePath: TARGET_PATH })
    expect(readFileSync(join(root, TARGET_PATH)).equals(DRAFT_BYTES)).toBe(true)
    expect(existsSync(join(root, '.git'))).toBe(false)
  })

  it('refuses a target that is no longer what was read, and writes nothing', () => {
    const theirs = Buffer.from('name: mine, not yet committed\nsteps:\n  - Open\n')
    writeFileSync(join(root, TARGET_PATH), theirs)

    // A NEW test claims the target is absent; a file there is somebody else's.
    expect(publisher()({
      configPath,
      request: { draftPath: DRAFT_PATH, targetPath: TARGET_PATH },
    })).toEqual({ kind: 'not-written', targetPath: TARGET_PATH, reason: 'target-changed' })
    // An EDIT claims the bytes it read; a digest of anything else is refused the same way.
    expect(publisher()({
      configPath,
      request: { draftPath: DRAFT_PATH, targetPath: TARGET_PATH, sourceDigest: sha256('other') },
    })).toEqual({ kind: 'not-written', targetPath: TARGET_PATH, reason: 'target-changed' })
    expect(readFileSync(join(root, TARGET_PATH)).equals(theirs)).toBe(true)

    // The digest of exactly what is there is the edit that goes through.
    expect(publisher()({
      configPath,
      request: { draftPath: DRAFT_PATH, targetPath: TARGET_PATH, sourceDigest: sha256(theirs) },
    })).toMatchObject({ kind: 'written', filePath: TARGET_PATH })
    expect(readFileSync(join(root, TARGET_PATH)).equals(DRAFT_BYTES)).toBe(true)
  })

  it('refuses a target outside the workspace, including through a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'test-direct-write-outside-'))
    try {
      symlinkSync(outside, join(root, 'tests', 'escape'))

      expect(publisher()({
        configPath,
        request: { draftPath: DRAFT_PATH, targetPath: '../escaped.yaml' },
      })).toMatchObject({ kind: 'not-written', reason: 'outside-workspace' })
      expect(publisher()({
        configPath,
        request: { draftPath: DRAFT_PATH, targetPath: 'tests/escape/escaped.yaml' },
      })).toMatchObject({ kind: 'not-written', reason: 'outside-workspace' })

      expect(readdirSync(outside)).toEqual([])
      expect(existsSync(join(root, '..', 'escaped.yaml'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a failed write is reported as not written, never as success', () => {
    const outcome = publisher()({
      configPath,
      request: { draftPath: DRAFT_PATH, targetPath: TARGET_PATH },
      writeTarget: () => {
        throw new Error('EIO: i/o error, write')
      },
    })

    expect(outcome).toEqual({
      kind: 'not-written',
      targetPath: TARGET_PATH,
      reason: 'write-failed',
      detail: 'EIO: i/o error, write',
    })
    expect(existsSync(join(root, TARGET_PATH))).toBe(false)
    expect(readdirSync(join(root, 'tests'))).toEqual(['.agent-qa-drafts'])
  })
})

// ---- the loop over this host's real writer ----------------------------------------------------

const MODEL_DOCUMENT = `name: Confirm the coupon banner
test-id: t_dose-warm-pea-sharp-hong-tested-lari-sat-import-slow
target: local-form
steps:
  - Open the cart
  - Verify the coupon banner says "Free shipping"
`

const EMPTY_BRIEF: AuthoringBrief = {
  exemplars: [],
  procedures: [],
  facts: [],
  cautions: [],
  coverage: {},
  truncation: 'none',
  admissions: [],
}

function receiptFor(
  draft: { readonly filePath: string; readonly testId: string; readonly testName: string;
    readonly contentDigest: string },
  disposition: DraftDisposition,
  pass: boolean,
): DraftReceipt {
  return {
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: draft.filePath,
      testId: draft.testId,
      testName: draft.testName,
      contentDigest: draft.contentDigest,
    },
    gates: {
      executesDefinitive: { pass: true, runRefs: [], indefinitiveRunRefs: [] },
      stableVerdict: { pass, runRefs: [], distinctOutcomes: [], earlyStopped: false },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 0 },
      falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
    },
    stepTable: [],
    gateRuns: [],
    addsValueFinding: { novelElements: [], comparedTests: [] },
    stabilityRunsRequested: 3,
    stabilityRunsCompleted: 3,
    disposition,
    evaluatedAt: 1,
  }
}

type AuthoringPort = ReturnType<typeof localHost.createDraftAuthoringPort>

function loopDeps(disposition: DraftDisposition, pass: boolean) {
  const authoring: AuthoringPort = localHost.createDraftAuthoringPort(configPath)
  const publish = (authoring as unknown as Record<string, unknown>)['publishDraft'] as
    | ((request: PublishRequest) => Promise<unknown>)
    | undefined
  const shelf = {
    model: () => Promise.resolve({
      modelId: 'fixture:direct-write',
      generate: (request: { readonly system?: string }) => Promise.resolve({
        text: (request.system ?? '').includes('authoring.draft.write — refine')
          ? 'no changes'
          : MODEL_DOCUMENT,
      }),
    }),
    write: (contents: string) => authoring.stageDraft(contents),
    applyPatches: () => Promise.reject(new Error('no repair in this cell')),
    runs: {
      start: () => Promise.reject(new Error('the scripted verify starts no run')),
      get: () => Promise.resolve(undefined),
    },
    verifyDraft: async (input: { readonly draftPath: string }) => {
      const parsed = await authoring.parseDraft(input.draftPath)
      if (parsed.kind !== 'parsed') throw new Error(`unparsed draft: ${parsed.kind}`)
      return receiptFor(parsed.draft, disposition, pass)
    },
    publish: (request: PublishRequest) =>
      publish === undefined ? Promise.reject(new Error('no writer')) : publish(request),
  } as unknown as DraftShelfPortLike
  const read = {
    getAuthoringBrief: () => Promise.resolve(EMPTY_BRIEF),
    suiteTextCorpus: () => Promise.resolve([]),
    configuredTargetNames: () => Promise.resolve(['local-form']),
  }
  return { read, shelf }
}

const LOOP_TARGET = 'tests/confirm-the-coupon-banner.yaml'

describe('the loop writes a final draft through this host, or does not', () => {
  it('a keep-eligible final draft lands at its target, byte for byte', async () => {
    initRepository()
    const before = repositorySnapshot()

    const result = await runAuthoringLoop(
      { intent: 'Check the coupon banner', scope: { tier: 'product', key: 'local-form' } },
      loopDeps('keep-eligible', true),
    )

    expect(result.outcome.kind).toBe('drafted')
    expect(existsSync(join(root, LOOP_TARGET))).toBe(true)
    expect(readFileSync(join(root, LOOP_TARGET), 'utf8')).toBe(MODEL_DOCUMENT)
    expect(repositorySnapshot()).toEqual(before)
  })

  it('a rejected final draft leaves no bytes at its target', async () => {
    initRepository()
    const before = repositorySnapshot()

    await runAuthoringLoop(
      { intent: 'Check the coupon banner', scope: { tier: 'product', key: 'local-form' } },
      loopDeps('rejected', false),
    ).catch((error: unknown) => error)

    expect(existsSync(join(root, LOOP_TARGET))).toBe(false)
    expect(readdirSync(join(root, 'tests')).sort()).toEqual(['.agent-qa-drafts'])
    expect(repositorySnapshot()).toEqual(before)
  })
})
