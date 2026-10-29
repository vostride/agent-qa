// `authoring.draft.edit` over the REAL applier (394-09, D-20/D-21 · WTST-07).
//
// WHY THIS FILE IS IN `packages/cli`. The byte-confinement claim — an edit never reformats a line
// it did not address — is a property of `applyPatchSetToTestDoc`, which needs the yaml CST from
// `@vostride/agent-qa-core`. Neither `agent` nor `agent-local` may depend on that package, so the
// applier is bound at the CLI host (`createDraftAuthoringPort`), and this is the only place where
// the op and the real applier can be in the same process. The op's declared surface and its
// refusals are measured where the op lives:
// `packages/agent/src/functions/__tests__/authoring-draft-edit.test.ts`.
//
// THE SECOND-CONSUMER CLAIM IS WHAT THIS FILE ACTUALLY MEASURES. The repair loop was the applier's
// only caller until this op registered, and a contract with one consumer is a contract shaped like
// its one caller. The cells below drive the SAME verb the repair loop drives, over a real file with
// a leading comment, a single-quoted scalar with a trailing comment, and a key order no
// plain-object round trip would preserve — so "the second consumer inherits the guarantee" is a
// measurement rather than an argument from reuse.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTHORING_DRAFT_EDIT_FUNCTION_ID,
  createFunctionRegistry,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import type {
  AuthoringDraftEditOutput,
  FunctionCaller,
  TestEditPatchSet,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDraftAuthoringPort } from '../composition/local-agent-host.js'

/**
 * A caller holding exactly the two scopes the verb declares.
 *
 * The op is reached through `invokeFunction` on a REAL registry rather than by calling its spec,
 * which is what makes these cells exercise the registration, the scope check and the gate the way
 * a surface does — and it is why the id is published from the agent barrel at all.
 */
const EDITOR: FunctionCaller = {
  surface: 'test',
  origin: 'human',
}

/**
 * A committed test with every byte-fragile feature the corpus cares about.
 *
 * Line 1 is a comment (the fragment both rejected render strategies delete). Line 4 carries a
 * single-quoted scalar with a trailing comment. `test-id` sits between two keys a patch may never
 * reach, so a render that reordered keys would move it.
 */
const COMMITTED = `# The checkout flow, kept because the coupon path regressed twice.
name: Checkout with a coupon
test-id: t_dose-warm-pea-sharp-hong-tested-lari-sat-import-slow
target: 'local-form' # single-quoted on purpose, with a trailing comment
steps:
  - Open the cart
  - Apply the coupon FREESHIP
  - Verify the total is 0.00
`

const TEST_PATH = 'tests/checkout.yaml'
const SHELF_DIR = 'tests/.agent-qa-drafts'

let root: string
let configPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'authoring-edit-'))
  configPath = join(root, 'agent-qa.config.yaml')
  // The house config verbatim, for the reason `draft-shelf-admission.test.ts` gives: the shelf and
  // the workspace resolution exist to satisfy THIS pattern, and a bespoke one measures a workspace
  // nobody has.
  writeFileSync(
    configPath,
    `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
`,
  )
  for (const name of ['hooks.yaml', '.env', '.env.secrets.local']) {
    writeFileSync(join(root, name), '')
  }
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, TEST_PATH), COMMITTED)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Per-line sha256 over RAW bytes — 394-03's instrument, so the two files are compared identically. */
function lineDigests(text: string): string[] {
  return text.split('\n').map((line) => createHash('sha256').update(Buffer.from(line, 'utf8')).digest('hex'))
}

/**
 * The lines of `before` that do NOT survive into `after`, and the lines of `after` that are new,
 * over an LCS alignment of those digests.
 *
 * The LCS rather than a positional walk, for 394-03's stated reason: a positional comparison cannot
 * express a removal at all, because every following line shifts and a one-line delete reports the
 * whole tail as changed.
 */
function changedLines(before: string, after: string): { removed: number[]; added: number[] } {
  const left = lineDigests(before)
  const right = lineDigests(after)
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j]
        ? (table[i + 1]![j + 1] ?? 0) + 1
        : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0)
    }
  }
  const removed: number[] = []
  const added: number[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue }
    if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) { removed.push(i + 1); i += 1 }
    else { added.push(j + 1); j += 1 }
  }
  while (i < left.length) { removed.push(i + 1); i += 1 }
  while (j < right.length) { added.push(j + 1); j += 1 }
  return { removed, added }
}

function harness(emission: string, options: { readonly beforeAnswer?: () => void } = {}) {
  const authoring = createDraftAuthoringPort(configPath)
  let runStarts = 0
  // 432 D-06: the host's direct writer, reached through the port by name so a baseline without it
  // is an assertion failure rather than a crash.
  const publishDraft = (authoring as unknown as Record<string, unknown>)['publishDraft'] as
    | ((request: unknown) => Promise<unknown>)
    | undefined

  const deps = {
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    draftShelf: {
      model: () => Promise.resolve({
        modelId: 'fixture:edit-e2e',
        generate: () => {
          options.beforeAnswer?.()
          return Promise.resolve({ text: emission })
        },
      }),
      write: (contents: string) => authoring.stageDraft(contents),
      // THE REAL APPLIER, reached exactly as the composition root reaches it.
      applyPatches: (draft: { readonly filePath: string }, patchSet: TestEditPatchSet) =>
        authoring.applyPatchesToDraft(draft as never, patchSet),
      runs: {
        start: () => { runStarts += 1; throw new Error('authoring.draft.edit must start ZERO runs') },
        get: () => { throw new Error('authoring.draft.edit reads no runs') },
      },
      verifyDraft: () => { throw new Error('authoring.draft.edit re-runs no gates') },
      publish: (request: unknown) =>
        publishDraft === undefined ? Promise.reject(new Error('no writer')) : publishDraft(request),
    },
    draftEvaluation: {
      resolveDraft: (path: string) => authoring.parseDraft(path),
      openEvaluation: () => Promise.reject(new Error('an edit opens no evaluation')),
    },
  } as unknown as FunctionDeps

  return {
    registry: createFunctionRegistry({
      deps,
    }),
    runStarts: () => runStarts,
  }
}

async function runEdit(
  emission: string,
  intent: string,
  options: { readonly beforeAnswer?: () => void } = {},
): Promise<AuthoringDraftEditOutput> {
  const bench = harness(emission, options)
  return await invokeFunction(
    bench.registry,
    AUTHORING_DRAFT_EDIT_FUNCTION_ID,
    { testRef: `${TEST_PATH}::Checkout with a coupon`, intent },
    EDITOR,
  ) as AuthoringDraftEditOutput
}

describe('an edit changes only the lines its pointers address', () => {
  it('replaces one step and leaves the comment, the quoting and the key order byte-identical', async () => {
    const result = await runEdit(
      JSON.stringify({
        thoughts: 'the total is what the coupon changes',
        patches: [{ op: 'replace', path: '/steps/2', value: 'Verify the total is 0.00 and the banner is shown' }],
      }),
      'also mention the banner in the total assertion',
    )

    const staged = readdirSync(join(root, SHELF_DIR))
    expect(staged).toHaveLength(1)
    const after = readFileSync(join(root, SHELF_DIR, staged[0] as string), 'utf8')

    // EXACT SETS, not an at-most. Everything outside these two vectors is byte-identical by
    // construction of the LCS alignment, so a render that re-quoted line 6 or dropped line 1 would
    // show up here as extra members rather than passing a subset check.
    const diff = changedLines(COMMITTED, after)
    expect(diff.removed).toEqual([8])
    expect(diff.added).toEqual([8])

    // The fragile lines, named individually so a failure says WHICH guarantee broke: the leading
    // comment, the single-quoted scalar with its trailing comment, and the untouched steps.
    const beforeLines = COMMITTED.split('\n')
    const afterLines = after.split('\n')
    expect(afterLines[0]).toBe(beforeLines[0])
    expect(afterLines[3]).toBe(beforeLines[3])
    expect(afterLines[5]).toBe(beforeLines[5])
    expect(afterLines[6]).toBe(beforeLines[6])
    expect(afterLines[7]).toContain('and the banner is shown')

    // 2026-09-30, 432 D-06: re-spelled in place. This used to assert the edited file UNTOUCHED
    // because the edit only proposed. The edit now lands in the file it edited, so the same
    // byte-confinement claim holds for the file on disk, and the answer points at that file.
    expect(readFileSync(join(root, TEST_PATH), 'utf8')).toBe(after)
    expect(result.draftRef.filePath).toBe(TEST_PATH)
    expect(result.editedFrom.boundBy).toBe('exact-ref')
  })

  it('adds a step without disturbing any existing line', async () => {
    const result = await runEdit(
      JSON.stringify({
        thoughts: 'a banner assertion belongs at the end',
        patches: [{ op: 'add', path: '/steps/3', value: 'Verify the coupon banner is visible' }],
      }),
      'also verify the coupon banner',
    )

    const staged = readdirSync(join(root, SHELF_DIR))
    const after = readFileSync(join(root, SHELF_DIR, staged[0] as string), 'utf8')

    const diff = changedLines(COMMITTED, after)
    // NOTHING removed. An append that reported a removal would mean an existing line was rewritten,
    // which is the defect this whole contract exists to prevent.
    expect(diff.removed).toEqual([])
    expect(diff.added).toEqual([9])
    expect(result.patches).toHaveLength(1)
    // 2026-10-01 (432-17, D-06): the run count rode the deleted test-draft arm; the edit answers
    // the file it wrote and carries no proposal.
    expect(result).not.toHaveProperty('proposal')
  })

  it('refuses a retarget through the REAL applier as well as at the op fence', async () => {
    // The op's own fence refuses first (its cells are the agent-side file). This asserts the other
    // side of the two-sided rule: nothing reached the shelf, so even a fence that had been removed
    // at the op would leave the host's copy standing.
    const refusal = await runEdit(
      JSON.stringify({
        thoughts: 'point it elsewhere',
        patches: [{ op: 'replace', path: '/target', value: 'someone-elses-app' }],
      }),
      'run this against the other app',
    ).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).name).toBe('EditRegionRefusedError')
    expect(readdirSync(join(root, 'tests')).filter((entry) => entry === '.agent-qa-drafts'))
      .toEqual([])
    expect(readFileSync(join(root, TEST_PATH), 'utf8')).toBe(COMMITTED)
  })
})

describe('refine edits and verifies the written test itself', () => {
  const EMISSION = JSON.stringify({
    thoughts: 'the total is what the coupon changes',
    patches: [{ op: 'replace', path: '/steps/2', value: 'Verify the total is 0.00 and the banner is shown' }],
  })

  it('an edit lands in the written file, and verify resolves that same path', async () => {
    const result = await runEdit(EMISSION, 'also mention the banner in the total assertion')

    const onDisk = readFileSync(join(root, TEST_PATH))
    const digest = createHash('sha256').update(onDisk).digest('hex')
    expect((result as Record<string, unknown>)['written']).toEqual({
      kind: 'written',
      filePath: TEST_PATH,
      contentDigest: digest,
    })
    expect(result.draftRef).toMatchObject({ filePath: TEST_PATH, contentDigest: digest })

    // The verify arm is handed `draftRef.filePath`; what it resolves there is the edited test.
    const resolved = await createDraftAuthoringPort(configPath).parseDraft(result.draftRef.filePath)
    expect(resolved.kind).toBe('parsed')
    if (resolved.kind !== 'parsed') throw new Error('unreachable')
    expect(resolved.draft.filePath).toBe(TEST_PATH)
    expect(resolved.draft.contentDigest).toBe(digest)
    expect(resolved.draft.steps.at(-1)).toBe('Verify the total is 0.00 and the banner is shown')
  })

  it('refuses to overwrite a written test that changed after it was read', async () => {
    const theirs = COMMITTED.replace('Open the cart', 'Open the cart from the header')
    const result = await runEdit(EMISSION, 'also mention the banner in the total assertion', {
      // A person saves the file while the model is thinking.
      beforeAnswer: () => writeFileSync(join(root, TEST_PATH), theirs),
    })

    expect((result as Record<string, unknown>)['written']).toEqual({
      kind: 'not-written',
      targetPath: TEST_PATH,
      reason: 'target-changed',
    })
    expect(readFileSync(join(root, TEST_PATH), 'utf8')).toBe(theirs)
  })
})
