// The stable-tier format block, staged through the REAL parser.
//
// WHY THIS FILE IS IN `packages/cli`, and why the sibling cell in `agent-local` is not enough.
// `authoring-loop.e2e.test.ts` reaches the composed op, the real registry and the real gates — but
// its `DraftAuthoringPort` is a FAKE that accepts any document carrying `name` and `steps`, because
// `parseTestFile` lives in `@vostride/agent-qa-core` and the FUNC-02 firewall forbids `agent` and
// `agent-local` from naming it. WINDOWS 111 is a defect about `test-id` and `target` — the two keys
// that fake does not look at — so a parsability claim made there is a claim about the fake.
// `createDraftAuthoringPort` is the shipped shelf and it parses through `parseTestFile`; this is the
// only process where the loop and that parser can be in the same room.
//
// PRODUCED, NEVER ASSERTED. Nothing below spells a document. The generator is handed the request
// `compileDraft` actually built, lifts the canonical example out of the stable block by title, and
// returns it — so an example that drifted from what `parseTestFile` accepts reds here rather than
// teaching every model a schema the shelf refuses.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runAuthoringLoop } from '@vostride/agent-qa-agent'
import type {
  AuthoringReadPortLike,
  DraftShelfPortLike,
  DraftStageOutcome,
  JobModelRequest,
} from '@vostride/agent-qa-agent'
import type { AuthoringBrief, ScopeKey } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDraftAuthoringPort } from '../../composition/local-agent-host.js'

const INTENT = 'Confirm the local account form shows its heading'
const SCOPE: ScopeKey = { tier: 'product', key: 'local-form' }
const SHELF_DIR = 'tests/.agent-qa-drafts'

/** The bootstrap condition itself: a fresh project, and therefore no memory at all. */
const ZERO_EXEMPLAR_BRIEF: AuthoringBrief = {
  exemplars: [],
  procedures: [],
  facts: [],
  cautions: [],
  coverage: {},
  truncation: 'none',
  admissions: [],
}

// The title and the marker as a MODEL reads them — literals, not imports. Importing the constants
// would give this generator a channel to the schema that a model does not have.
const FORMAT_BLOCK_TITLE = 'Test document format'
const FORMAT_EXAMPLE_MARKER = 'A complete document looks exactly like this:'
const TARGETS_BLOCK_TITLE = 'Configured targets'

/**
 * The one sentence that makes a fifth key emittable.
 *
 * The generator emits `context` if and only if it reads this rule off the block. It is not a
 * literal this file decided to write: with the shipping block — which says four keys and that no
 * other key is accepted — nothing below emits one, and the reachability cell reds. That is the
 * whole instrument, and it is why the rule is matched rather than the key name: a block merely
 * MENTIONING `context` (in a rejection sentence, say) must not be read as permission.
 */
const CONTEXT_OPTIONAL_RULE = /^`context` is optional:/m

/** One `## `-titled block's body, off the rendered markdown a model is handed. */
function promptBlockBody(text: string, title: string): string | undefined {
  for (const part of text.split(/^## /m).slice(1)) {
    const split = part.indexOf('\n\n')
    if (part.slice(0, split) === title) return part.slice(split + 2).replace(/\n+$/, '')
  }
  return undefined
}

/**
 * The `target` a prompt-driven generator picks: one of the SERVED names, or nothing.
 *
 * THE SCOPE KEY IS NOT AN ANSWER, and deleting the derivation that treated it as one is most of
 * this function. `deriveDefaultAuthoringScope` supplies a PRODUCT (`target.product ?? targetName`),
 * so slicing the scope key out of the Scope block yielded a configured target only on the projects
 * where the two happen to coincide — which was every fixture this file had, which is why nothing
 * could red on the branch where they do not. It survives here as a HINT for choosing among served
 * names and never as a source of the value.
 *
 * THE PREFERENCE IS A MODEL'S, NOT A LOOKUP'S. Among the served names it prefers one that shares
 * text with the scope key and otherwise takes the first, because that is what a reader of the
 * prompt can do — it has no config, no product map, and no way to acquire one. What the cells
 * assert is membership in the served list, never this heuristic's particular pick.
 */
function targetFromVocabulary(request: JobModelRequest, scopeKey: string): string {
  const served = promptBlockBody(request.prompt, TARGETS_BLOCK_TITLE)
  const names = (served ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (names.length === 0) {
    throw new Error(`the prompt serves no "${TARGETS_BLOCK_TITLE}" block, and this generator will `
      + 'not invent a target')
  }
  return names.find((name) => name.includes(scopeKey) || scopeKey.includes(name)) ?? (names[0] as string)
}

/** The block's own body, or the generator's refusal — the one lift both generators below share. */
function formatBlockOrThrow(request: JobModelRequest): string {
  const format = promptBlockBody(request.system ?? '', FORMAT_BLOCK_TITLE)
  if (format === undefined || !format.includes(FORMAT_EXAMPLE_MARKER)) {
    throw new Error(`the prompt carries no usable "${FORMAT_BLOCK_TITLE}" block, and this `
      + 'generator knows no document schema of its own')
  }
  return format
}

/**
 * The canonical example, lifted verbatim, with ONLY its `name` adapted to the Intent block.
 *
 * The `target` line stays as the block wrote it, and that omission is the point:
 * a generator that adapts `target` from the served list can only ever emit a member of it, so no
 * cell built on one can measure the product's refusal. This is the same block, read by title, with
 * one bullet skipped — which is a model behaviour, not a contrivance.
 */
function exampleWithIntentName(request: JobModelRequest): string {
  const format = formatBlockOrThrow(request)
  const marker = format.indexOf(FORMAT_EXAMPLE_MARKER)
  const example = `${format.slice(marker + FORMAT_EXAMPLE_MARKER.length).trim()}\n`
  const intent = promptBlockBody(request.prompt, 'Intent') ?? ''
  return example.replace(/^name: .*$/m, () => `name: ${intent}`)
}

function documentFromPrompt(request: JobModelRequest): string {
  const format = formatBlockOrThrow(request)
  const intent = promptBlockBody(request.prompt, 'Intent') ?? ''
  const scope = promptBlockBody(request.prompt, 'Scope') ?? ''
  const target = targetFromVocabulary(request, scope.split(':')[1] ?? scope)

  const document = exampleWithIntentName(request)
    .replace(/^target: .*$/m, () => `target: ${target}`)

  // A FIFTH KEY, EMITTED ONLY BECAUSE THE BLOCK TAUGHT IT. The value is derived from the Intent
  // block rather than spelled here, so a generator that ignored the prompt entirely could not
  // produce it either.
  if (!CONTEXT_OPTIONAL_RULE.test(format)) return document
  return document.replace(
    /^target: .*$/m,
    (line) => `${line}\ncontext: Standing background for this test — ${intent}`,
  )
}

/** Reaching stage 4 is the proof stage 3 staged real bytes; there is nothing here to verify with. */
const VERIFY_REACHED = 'the draft reached stage 4'

/**
 * One whole invocation of the loop against the SHIPPED shelf, and everything it produced.
 *
 * Shared by every cell below rather than retyped per case: the arrangement — a zero-exemplar
 * brief, a schema-blind generator, the real `createDraftAuthoringPort` as the shelf — is the
 * CONDITION under test, and two spellings of it would let one cell measure a setup the other
 * does not have.
 */
async function driveZeroExemplarLoop(
  scope: ScopeKey = SCOPE,
  /** The generator under test. Parameterised for WR-04's off-vocabulary emission, nothing else. */
  generate: (request: JobModelRequest) => string = documentFromPrompt,
): Promise<{
  readonly authoring: ReturnType<typeof createDraftAuthoringPort>
  readonly failure: Error | undefined
  readonly compileRequests: readonly JobModelRequest[]
  readonly emitted: readonly string[]
  readonly served: readonly string[]
  readonly staged: readonly DraftStageOutcome[]
  readonly verified: readonly string[]
}> {
  const authoring = createDraftAuthoringPort(configPath)
  const compileRequests: JobModelRequest[] = []
  const emitted: string[] = []
  const staged: DraftStageOutcome[] = []
  const verified: string[] = []
  const served: string[] = []

  const read: AuthoringReadPortLike = {
    getAuthoringBrief: () => Promise.resolve(ZERO_EXEMPLAR_BRIEF),
    suiteTextCorpus: () => Promise.resolve([]),
    // THE REAL HOST BINDING, not a fixture list. The vocabulary a cell asserts membership in is
    // what `createDraftAuthoringPort` read out of this workspace's own config — so a binding that
    // enumerated the wrong thing reds here rather than being papered over by a literal.
    async configuredTargetNames() {
      const names = await authoring.configuredTargetNames()
      served.push(...names)
      return names
    },
  }

  const shelf: DraftShelfPortLike = {
    model: () => Promise.resolve({
      modelId: 'fixture:zero-exemplar-format',
      generate(request: JobModelRequest) {
        // The refinement round asks about an existing draft and carries no format block; a
        // generator with nothing to add says so. The compile call is the one under test.
        if (!/^Agent context: authoring\.draft\.write — compile /.test(request.system ?? '')) {
          return Promise.resolve({ text: 'no changes needed' })
        }
        compileRequests.push(request)
        const text = generate(request)
        emitted.push(text)
        return Promise.resolve({ text })
      },
    }),
    // THE SHIPPED SHELF. `stageDraft` runs `parseTestFile` first and writes only bytes that
    // survived it, so an `unparsable` arm here is a fact about the real parser — and the outcome
    // is RECORDED, so a cell can read the `ParsedDraftLike` the real parser produced rather than
    // re-deriving one of its own.
    write: async (contents: string) => {
      const outcome = await authoring.stageDraft(contents)
      staged.push(outcome)
      return outcome
    },
    runs: {
      start: () => { throw new Error('this cell starts no runs') },
      get: () => { throw new Error('this cell reads no runs') },
    },
    applyPatches: () => { throw new Error('this cell applies no patches') },
    verifyDraft: (input: { readonly draftPath: string }) => {
      verified.push(input.draftPath)
      throw new Error(VERIFY_REACHED)
    },
  } as unknown as DraftShelfPortLike

  const failure = await runAuthoringLoop({ intent: INTENT, scope }, { read, shelf })
    .then(() => undefined, (error: unknown) => error as Error)

  return { authoring, failure, compileRequests, emitted, served, staged, verified }
}

// The house config verbatim, on `authoring-draft-edit.e2e.test.ts`'s reason: the shelf and the
// workspace resolution exist to satisfy THIS pattern, and a bespoke one measures a workspace
// nobody has. `use.mobile.appState` is not decoration — `resolveConfig` REFUSES a config without
// it, and `configuredTargetNames` resolves the config for real.
const WORKSPACE_BLOCK = `workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local
use:
  mobile:
    appState: preserve
`

/** The EASY branch: one target whose product IS its name (`product` absent). */
const ONE_TARGET = `registry:
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931
`

/**
 * The HARD branch, verbatim from `authoring-scope-derivation.test.ts`'s own fixture class
 * `storefront-web` declares `product: storefront`, so the scope
 * `deriveDefaultAuthoringScope` supplies for it — `product:storefront` — is NOT a configured
 * target. `local-form` rides along as a distractor, so choosing from the served list is a real
 * choice rather than "there was only one".
 */
const TWO_TARGETS = `registry:
  targets:
    local-form:
      platform: web
      url: http://127.0.0.1:8931
    storefront-web:
      product: storefront
      platform: web
      url: https://storefront.example
`

let root: string
let configPath: string

/** Rewrite this workspace's config; the shelf and the vocabulary both re-read it per call. */
function writeConfig(registryBlock: string): void {
  writeFileSync(configPath, `${WORKSPACE_BLOCK}${registryBlock}`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zero-exemplar-format-'))
  configPath = join(root, 'agent-qa.config.yaml')
  writeConfig(ONE_TARGET)
  for (const name of ['hooks.yaml', '.env', '.env.secrets.local']) {
    writeFileSync(join(root, name), '')
  }
  mkdirSync(join(root, 'tests'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a zero-exemplar scope compiles a document the SHIPPED parser accepts', () => {
  it('stages the prompt-taught example through the real shelf, and stage 4 is reached', async () => {
    const { authoring, failure, compileRequests, verified } = await driveZeroExemplarLoop()

    // NOT `AuthoringDraftUnparsableError` — which is exactly what the live model produced on 5/5
    // gate-allowed invocations, and what this generator produces when the block is absent.
    expect(failure?.message).toBe(VERIFY_REACHED)

    // The condition, produced rather than assumed: the exemplar block carried the empty answer, so
    // the only schema channel in that prompt was the stable block.
    expect(compileRequests[0]?.prompt).toContain('No exemplar tests were served for this scope.')

    // The bytes really are on the shelf, and the SHIPPED read path parses them back into the four
    // fields a receipt joins on.
    const staged = readdirSync(join(root, SHELF_DIR))
    expect(staged).toHaveLength(1)
    expect(verified).toEqual([`${SHELF_DIR}/${staged[0] as string}`])

    const parsed = await authoring.parseDraft(verified[0] as string)
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') return
    expect(parsed.draft.testName).toBe(INTENT)
    // `test-id` is the key the live emission omitted; the shipped read path prefers an authored one
    // and falls back to the name, so a document that carried none would read back as the name.
    expect(parsed.draft.testId).not.toBe(parsed.draft.testName)
    expect(parsed.draft.testId).toMatch(/^t_/)
    expect(parsed.draft.steps.length).toBeGreaterThan(0)
  })

  it('reaches ParsedDraftLike.context from stage 3 — the root the gate scans', async () => {
    // THE CLAIM, AND WHY IT IS MADE HERE. `ParsedDraftLike.context` was widened into the shape in
    // 394-15 so the draft check could read it, and nothing on the compile path had
    // ever populated it: the format block told stage 3 that four keys were all a document may
    // carry. This cell is that root's first end-to-end reachability proof, and it is a fact about
    // the SHIPPED parser — `agent-local`'s shelf is a fake that reads `name` and `steps` and would
    // have answered `staged` for a document whose `context` it never looked at.
    const { failure, staged, verified, authoring } = await driveZeroExemplarLoop()

    expect(failure?.message).toBe(VERIFY_REACHED)

    // ① the compile prompt is what taught it — the rule is present in the block a model reads.
    const [staging] = staged
    expect(staging?.kind).toBe('staged')
    if (staging === undefined || staging.kind !== 'staged') return

    // ② the value survived `parseTestFile` into the field the credential gate scans, on the way
    // OUT of the shelf's own staging verb.
    expect(staging.draft.context).toContain(INTENT)

    // ③ and it is on disk, so a later read — the repair loop's, an accept's — finds it too.
    const parsed = await authoring.parseDraft(verified[0] as string)
    expect(parsed.kind).toBe('parsed')
    if (parsed.kind !== 'parsed') return
    expect(parsed.draft.context).toBe(staging.draft.context)
  })

  it('chooses `target` from the served vocabulary when product ≠ target name', async () => {
    // THE HARD BRANCH, AND IT IS REACHABLE BY CONSTRUCTION. `deriveDefaultAuthoringScope` answers
    // a PRODUCT (`resolveTarget(...).product`, i.e. `target.product ?? targetName`), `compileDraft`
    // renders only `${tier}:${key}`, nothing validates `target` before `runs.start`, and `target`
    // is outside `EDITABLE_POINTER_ROOTS` so no repair patch can correct it. On this config the
    // scope is `product:storefront` and `storefront` is NOT a configured target — the value the
    // old scope-key derivation produced, and a test that could never run.
    writeConfig(TWO_TARGETS)
    const scope: ScopeKey = { tier: 'product', key: 'storefront' }

    const { failure, served, staged } = await driveZeroExemplarLoop(scope)

    expect(failure?.message).toBe(VERIFY_REACHED)

    // The vocabulary the HOST read out of this config — both names, product-free.
    expect([...served].sort()).toEqual(['local-form', 'storefront-web'])

    const [staging] = staged
    expect(staging?.kind).toBe('staged')
    if (staging === undefined || staging.kind !== 'staged') return

    // THE CLAIM, STATED FOR WHAT IT IS (corrected 394-37, WR-04). The staged target is a MEMBER of
    // the served vocabulary — which measures that THIS GENERATOR obeyed the block, and nothing
    // about what the product does when a generator does not. It cannot be otherwise here:
    // `targetFromVocabulary` draws its answer out of the served list on every path it can take, so
    // membership holds by construction. The PRODUCT's refusal of a non-member is a different claim
    // with its own cell — `refuses an off-vocabulary target` below, whose generator copies the
    // example's target instead of choosing one.
    //
    // Not "equals storefront-web" either: that would pin this generator's preference heuristic
    // rather than the property, which is that stage 3 chose rather than guessed.
    const parsedTarget = /^target: (.+)$/m.exec(
      readFileSync(join(root, staging.draft.filePath), 'utf8'),
    )?.[1]
    expect(served).toContain(parsedTarget)

    // AND THE CONTROL: it is not the scope key. Every fixture in this file before this one had
    // product == target name, which is why 35 plans of cells could not tell the two apart.
    expect(parsedTarget).not.toBe(scope.key)
  })

  it('refuses an off-vocabulary `target` before stage 4, through the SHIPPED parser', async () => {
    // THE CASE THE GUARD REJECTS, PRODUCED BY THE REAL EMISSION PATH. The value compared here is
    // `ParsedDraftLike.target` as `createDraftAuthoringPort.stageDraft` derived it — `parseTestFile`
    // over the bytes the generator emitted — and the vocabulary is what the same host read out of
    // this workspace's own config file. Neither side is a literal this file chose.
    //
    // The generator is a model that read the format block and skipped one bullet: it copies the
    // canonical example's `target: sign-in`, and this config declares only `local-form`.
    const { failure, emitted, served, staged, verified } =
      await driveZeroExemplarLoop(SCOPE, exampleWithIntentName)

    // ① THE CONDITION, PRODUCED: an off-vocabulary emission, against a vocabulary read from disk.
    expect(emitted[0]).toContain('target: sign-in')
    expect(served).toEqual(['local-form'])

    // ② IT PARSED. The refusal is about the vocabulary and not about the document — the SHIPPED
    // parser accepted these bytes, so a guard that never fired would have handed them to stage 4.
    const [staging] = staged
    expect(staging?.kind).toBe('staged')
    if (staging === undefined || staging.kind !== 'staged') return
    expect(staging.draft.target).toBe('sign-in')

    // ③ THE REFUSAL, naming both halves of the comparison.
    expect(failure?.name).toBe('AuthoringDraftUnconfiguredTargetError')
    expect(failure?.message).toContain('sign-in')
    expect(failure?.message).toContain('local-form')

    // ④ AND STAGE 4 WAS NEVER REACHED. `verified` is the recording `verifyDraft`'s own ledger; on
    // every other cell in this file reaching it is the SUCCESS signal, which is what makes an
    // empty list here a claim about where the loop stopped rather than about how it failed.
    expect(verified).toEqual([])
  })

  it('refuses the same document with its test-id removed — so the cell above is not vacuous', async () => {
    // THE NON-VACUITY GUARD, and it is the whole reason this file exists. The `agent-local` fake
    // shelf accepts this document; the shipped one does not, and names the key.
    const authoring = createDraftAuthoringPort(configPath)

    const staged = await authoring.stageDraft(
      `name: ${INTENT}\ntarget: local-form\nsteps:\n  - Verify the page heading says "Local form"\n`,
    )

    expect(staged.kind).toBe('unparsable')
    if (staged.kind !== 'unparsable') return
    expect(staged.reason).toContain('test-id')
    // Nothing was written: the shelf directory does not exist at all.
    expect(readdirSync(join(root, 'tests'))).toEqual([])
  })
})
