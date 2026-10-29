// The one thing the committed ledger is committed FOR: quarantine state written on machine A
// suppresses on checkout B.
//
// WHY THIS FILE EXISTS. `quarantine.jsonl` lives at the knowledge root and travels in git so a
// fresh CI checkout inherits the disposition. The match that decides whether it applies is an exact
// string compare on `(filePath, testName)`. Before 390-08 the `filePath` leg was the CLI's ABSOLUTE
// resolved path, so the bytes a ledger carried were bytes only the machine that wrote them could
// ever produce — the artifact was committed for an inheritance it structurally could not deliver,
// and no single-root fixture could see it, because under one root the absolute paths agree.
//
// THE SHAPE OF THE PIN (the 388 two-sided contract law). Both halves run through PRODUCTION code
// and they run under DIFFERENT temp roots:
//
//   writer half, under root A   real descriptors from `buildDirectRunMembers` -> a handoff ->
//                               `LOCAL_CURATION_CAPABILITIES.foldRunOutcomes`, three failing
//                               ordinals, until detection itself authors the `entered` event
//   the artifact travels        the committed file is COPIED to root B, the way git would deliver it
//   reader half, under root B   real descriptors minted under root B -> `resolveRunQuarantineSnapshot`
//                               -> `quarantineAppliesToTest`
//
// Neither half is handed the other's bytes. The assertions anchor OUTSIDE the code's own field
// relations — exact fixture strings, the exact schemaVersion number, and the ABSENCE of either
// temp-root prefix anywhere in the committed file — so "both sides agree" cannot be satisfied by
// two halves that are wrong in the same way.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseTestFile, workspaceRelativeIdentityPath } from '@vostride/agent-qa-core'
import type { ParsedTestBinding } from '@vostride/agent-qa-core'
import {
  QuarantineIdentityRefusedError,
  createQuarantineOperations,
} from '@vostride/agent-qa-knowledge-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
  exercisedAnchors,
  quarantineAppliesToTest,
} from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  ElementInfo,
  MemberTestOutcome,
  PerTestOutcome,
  QuarantineAppliedEntry,
  ScreenState,
  StepEvidence,
  Verdict,
} from '@vostride/agent-qa-schema'
import {
  LOCAL_CURATION_CAPABILITIES,
  resolveRunQuarantineSnapshot,
} from '@vostride/agent-qa-agent-local'
import { afterEach, describe, expect, it } from 'vitest'

import { buildDirectRunMembers } from '../commands/direct-run-members.js'

// Spelled as a literal rather than imported from the writer: this suite asserts on the artifact a
// human finds in their repository, and a constant imported from the writer would move with it.
const QUARANTINE_LEDGER_FILE = 'quarantine.jsonl'

const PRODUCT = 'shop-web'
/** The workspace-relative layout BOTH checkouts share. This string is the identity. */
const TEST_FILE_RELATIVE = 'tests/checkout.yaml'
const TEST_NAME = 'checkout completes the payment sheet'
const ANCHOR_NAME = 'pay now'

const NOW = '2026-08-05T12:00:00.000Z'
/** NOW + QUARANTINE_DEFAULT_EXPIRY_DAYS (30). */
const EXPECTED_EXPIRY = '2026-09-04T12:00:00.000Z'

const TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

const TEST_YAML = [
  `test-id: ${TEST_ID}`,
  `name: ${TEST_NAME}`,
  'target: storefront',
  'steps:',
  `  - click the ${ANCHOR_NAME} button`,
  '',
].join('\n')

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---- two independent checkouts of the same workspace -------------------------------------------

interface Checkout {
  /** The config directory — the root every identity is relative to. */
  configDir: string
  knowledgeRoot: string
  agentQaRoot: string
  /** The absolute path of the member test file INSIDE this checkout. */
  absoluteTestFile: string
}

function checkout(prefix: string): Checkout {
  const configDir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(configDir)
  const knowledgeRoot = join(configDir, 'agent-qa-knowledge')
  const agentQaRoot = join(configDir, '.agent-qa')
  mkdirSync(knowledgeRoot, { recursive: true })
  mkdirSync(agentQaRoot, { recursive: true })
  const absoluteTestFile = join(configDir, 'tests', 'checkout.yaml')
  mkdirSync(join(configDir, 'tests'), { recursive: true })
  writeFileSync(absoluteTestFile, TEST_YAML, 'utf8')
  return { configDir, knowledgeRoot, agentQaRoot, absoluteTestFile }
}

/**
 * The member identity THIS checkout mints, through the production descriptor builder.
 *
 * This is the load-bearing hop: reverting `buildDirectRunMembers` to copy the binding's absolute
 * path is exactly the pre-390-08 defect, and it reds every assertion below.
 */
function mintedIdentity(env: Checkout): string {
  const parsed = parseTestFile(TEST_YAML, env.absoluteTestFile)
  expect(parsed.errors).toEqual([])
  const bindings: ParsedTestBinding[] = parsed.tests.map((test) => ({
    test,
    filePath: env.absoluteTestFile,
    fileContent: TEST_YAML,
  }))
  const { members } = buildDirectRunMembers(bindings, env.configDir)
  expect(members).toHaveLength(1)
  return members[0].filePath
}

// ---- fixture shapes (the lifecycle E2E's idiom, trimmed to one member) --------------------------

function failingStep(buildOrdinal: number): StepEvidence {
  const element: ElementInfo = {
    ref: 'e1' as ElementInfo['ref'],
    role: 'button',
    name: ANCHOR_NAME,
    nameNormalized: ANCHOR_NAME,
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
  }
  const stateBefore: ScreenState = {
    platform: 'web',
    tree: '',
    elements: [element],
    refMap: {},
    url: '/checkout',
    timestamp: 1,
    metadata: {
      coordSpace: 'viewport',
      viewportWidth: 1280,
      viewportHeight: 720,
      scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
      captureMode: 'textOnly',
    },
  }
  return {
    stepIndex: 0,
    stepText: `click the ${ANCHOR_NAME} button`,
    cacheStatus: 'miss',
    servedBrief: {
      scope: { tier: 'product', key: PRODUCT },
      asOfBuild: buildOrdinal,
      budget: 0,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'portability-brief-digest',
    },
    subActions: [{
      plan: `click ${ANCHOR_NAME}`,
      plannedAction: { type: 'click', ref: element.ref },
      stateBefore,
      result: { success: false, error: `Error: element "${ANCHOR_NAME}" not found` },
    }],
    verifierVerdict: { pass: false, reasoning: `the ${ANCHOR_NAME} button never appeared` },
  } as unknown as StepEvidence
}

/**
 * AUTHORED since 390-19, and STILL authored after 390-21 for a live reason rather than a dead one
 * (corrected 390-22; 390-21 filed this sentence as a known stale comment).
 *
 * This file's subject is LEDGER PORTABILITY — that a committed entry suppresses on a checkout that
 * never saw the machine that wrote it, and that no checkout root leaks into the bytes — so it needs
 * a crossing the gate genuinely ADMITS in order to have an entry to carry at all.
 *
 * WHAT CHANGED. 390-19's floor arm requires a per-crossing `sameBuildPassAndFail`, and for one wave
 * the fold's only construction site supplied a constant `false`, so a floor-produced crossing was
 * inert in-tree by construction. That interval is CLOSED: 390-21 replaced the constant with a read
 * of the crossing test's own outcome window, and the floor path is reachable end to end.
 *
 * WHY AUTHORED IS STILL THE RIGHT CHOICE HERE. The floor arm is reachable, not free: it needs the
 * crossing test's window to carry a pass and a fail at ONE build ordinal, which takes two separate
 * applied runs at the same `handoff.buildOrdinal` and which an in-run retry can never produce. This
 * harness drives one run per checkout because the checkout, not the run count, is its subject.
 * `analyze-run` admits on the first disjunct — untouched by either round — so the portability
 * assertions keep exercising a real committed entry without the fixture having to simulate a CI
 * job re-run it is not about.
 */
function flakeVerdict(): Verdict {
  return {
    class: 'flake',
    producer: 'analyze-run',
    confidence: 0.6,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: `the ${ANCHOR_NAME} button never appeared`,
    },
    memoryMisdirectionRuledOut: false,
    perTest: 0,
  } as Verdict
}

function handoffFor(input: {
  runId: string
  buildOrdinal: number
  outcome: Extract<MemberTestOutcome, 'passed' | 'failed'>
  /** The descriptor identity this run's checkout minted — never a literal. */
  filePath: string
  quarantined: readonly QuarantineAppliedEntry[]
}): CompletedRunHandoff {
  const failed = input.outcome === 'failed'
  const member = {
    testId: `${input.runId}-checkout`,
    testName: TEST_NAME,
    filePath: input.filePath,
    testIndex: 0,
    outcome: input.outcome,
    steps: failed ? [failingStep(input.buildOrdinal)] : [],
    ...(failed ? { rootCause: flakeVerdict() } : {}),
  } as unknown as PerTestOutcome
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId as CompletedRunHandoff['runId'],
    buildOrdinal: input.buildOrdinal,
    scope: { tier: 'product', key: PRODUCT },
    executionContext: 'ci',
    aggregateVerdict: failed ? 'failed' : 'passed',
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: input.buildOrdinal * 1_000,
    endedAt: input.buildOrdinal * 1_000 + 1,
    tests: [member],
    ...(input.quarantined.length > 0 ? { quarantineApplied: input.quarantined } : {}),
  } as unknown as CompletedRunHandoff
}

function ledgerText(env: Checkout): string {
  const path = join(env.knowledgeRoot, QUARANTINE_LEDGER_FILE)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function ledgerLines(env: Checkout): Array<Record<string, unknown>> {
  return ledgerText(env)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Drive the WRITER half under one checkout: three failing ordinals of the same fingerprint, each
 * through the real post-run fold, until detection authors the `entered` event itself.
 */
function driveCrossingUnder(env: Checkout): string {
  const identity = mintedIdentity(env)
  for (const buildOrdinal of [1, 2, 3]) {
    LOCAL_CURATION_CAPABILITIES.foldRunOutcomes({
      knowledgeRoot: env.knowledgeRoot,
      handoff: handoffFor({
        runId: `run-portability-${buildOrdinal}`,
        buildOrdinal,
        outcome: 'failed',
        filePath: identity,
        quarantined: [],
      }),
      extractAnchors: exercisedAnchors,
      quarantine: { now: NOW },
    })
  }
  return identity
}

/** Deliver the committed artifact to another checkout, the way `git checkout` would. */
function deliverLedger(from: Checkout, to: Checkout): void {
  cpSync(
    join(from.knowledgeRoot, QUARANTINE_LEDGER_FILE),
    join(to.knowledgeRoot, QUARANTINE_LEDGER_FILE),
  )
}

// ---- the differential ---------------------------------------------------------------------------

describe('the committed quarantine ledger crosses checkout roots', () => {
  it('suppresses on a checkout that never saw the machine that wrote the entry', () => {
    const machineA = checkout('agent-qa-390-portability-A-')
    const ciCheckoutB = checkout('agent-qa-390-portability-B-')

    // --- writer half, entirely under root A ---
    const identityUnderA = driveCrossingUnder(machineA)
    const written = ledgerLines(machineA)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      kind: 'entered',
      product: PRODUCT,
      filePath: TEST_FILE_RELATIVE,
      testName: TEST_NAME,
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    })

    // --- the artifact travels; root B has no other trace of root A ---
    deliverLedger(machineA, ciCheckoutB)

    // --- reader half, entirely under root B ---
    const identityUnderB = mintedIdentity(ciCheckoutB)
    const snapshotUnderB = resolveRunQuarantineSnapshot({
      knowledgeRoot: ciCheckoutB.knowledgeRoot,
      product: PRODUCT,
      now: NOW,
    })

    expect(snapshotUnderB).toEqual([{
      product: PRODUCT,
      filePath: TEST_FILE_RELATIVE,
      testName: TEST_NAME,
      expiresAt: EXPECTED_EXPIRY,
    }])
    // THE CLAIM: root B's own member, minted from root B's own absolute path, matches the entry
    // root A wrote. The two checkouts never exchanged anything but the committed file.
    expect(quarantineAppliesToTest(snapshotUnderB, {
      filePath: identityUnderB,
      testName: TEST_NAME,
    })).toBe(true)

    // The two checkouts genuinely differ on disk, and genuinely agree on identity.
    expect(machineA.configDir).not.toBe(ciCheckoutB.configDir)
    expect(machineA.absoluteTestFile).not.toBe(ciCheckoutB.absoluteTestFile)
    expect(identityUnderA).toBe(TEST_FILE_RELATIVE)
    expect(identityUnderB).toBe(TEST_FILE_RELATIVE)
  })

  it('leaks no checkout root into the committed bytes', () => {
    const machineA = checkout('agent-qa-390-portability-bytes-A-')
    const ciCheckoutB = checkout('agent-qa-390-portability-bytes-B-')
    driveCrossingUnder(machineA)
    deliverLedger(machineA, ciCheckoutB)

    // Anchored on the file's own bytes, not on a relation between two of the code's fields.
    const committed = ledgerText(machineA)
    expect(committed.length).toBeGreaterThan(0)
    expect(committed).not.toContain(machineA.configDir)
    expect(committed).not.toContain(ciCheckoutB.configDir)
    expect(committed).not.toContain(tmpdir())

    for (const line of ledgerLines(machineA)) {
      expect(line.filePath).toBe(TEST_FILE_RELATIVE)
      expect(line.schemaVersion).toBe(2)
    }
  })

  it('refuses a hand-edited absolute-path line while its healthy neighbours still apply', () => {
    const machineA = checkout('agent-qa-390-portability-refuse-A-')
    const ciCheckoutB = checkout('agent-qa-390-portability-refuse-B-')
    driveCrossingUnder(machineA)
    deliverLedger(machineA, ciCheckoutB)

    // A human (or a pre-390-08 build) writes a machine-local identity into the committed file.
    const damaged = {
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
      kind: 'entered',
      at: NOW,
      product: PRODUCT,
      filePath: join(machineA.configDir, 'tests', 'legacy.yaml'),
      testName: 'legacy checkout',
      fingerprint: 'fp-legacy',
      verdictClass: 'flake',
      owner: QUARANTINE_UNASSIGNED_OWNER,
      expiresAt: EXPECTED_EXPIRY,
    }
    appendFileSync(
      join(ciCheckoutB.knowledgeRoot, QUARANTINE_LEDGER_FILE),
      `${JSON.stringify(damaged)}\n`,
      'utf8',
    )

    const warnings: string[] = []
    const snapshotUnderB = resolveRunQuarantineSnapshot({
      knowledgeRoot: ciCheckoutB.knowledgeRoot,
      product: PRODUCT,
      now: NOW,
      warn: (message) => warnings.push(message),
    })

    // Refusal-as-data: the damaged line is named to a human, not silently dropped.
    expect(warnings.join('\n')).toContain('unreadable line')
    expect(warnings.join('\n')).toContain('line 2')
    // The healthy relative-identity neighbour is UNAFFECTED — a damaged line withholds nothing else.
    expect(snapshotUnderB.map((entry) => entry.filePath)).toEqual([TEST_FILE_RELATIVE])
    expect(quarantineAppliesToTest(snapshotUnderB, {
      filePath: mintedIdentity(ciCheckoutB),
      testName: TEST_NAME,
    })).toBe(true)
    // And the machine-local entry licenses nothing, on this checkout or any other.
    expect(quarantineAppliesToTest(snapshotUnderB, {
      filePath: damaged.filePath,
      testName: damaged.testName,
    })).toBe(false)
  })
})

// ---- the WRITE-verb half of the same contract -----------------------------------
//
// The block above pins the RUN writer. This one pins the two HUMAN write verbs — the documented
// human half of the exit path, and the surface most likely to receive a path pasted out
// of a failure report. Round 1 hardened the read and the run path and left these two as an
// unnormalized door into the same committed file: `quarantine.add` answered `entered` over a line
// the reader refuses, `list` could not show it, `release` could not undo it, a retry duplicated it,
// and every later run reported it as damage.
//
// EVERY PART HERE IS PRODUCTION CODE, which is only possible in `cli`: core's mint, knowledge-local's
// verbs, agent-local's snapshot reader and schema's match all meet in this one package. The writer
// half runs entirely under root A with the REAL `workspaceRelativeIdentityPath` pre-bound to root
// A's config directory, exactly as `composeCliLocalAgent` binds it; the committed file is then
// copied to root B the way git delivers it, and the reader half never sees root A's bytes.
//
// THE INVARIANT, one case per measured input class: for every input the verb either STORES the
// minted canonical identity or REFUSES with the ledger byte-unchanged. There is no third outcome —
// no committed line the reader refuses, and no line that lists but can never match.

describe('the human write verbs mint the identity the reader joins on', () => {
  function verbsUnder(env: Checkout): ReturnType<typeof createQuarantineOperations> {
    return createQuarantineOperations({
      resolveKnowledgeRoot: () => env.knowledgeRoot,
      // Wall-clock purity by argument: the verbs read this and nothing else.
      now: () => NOW,
      mintIdentityPath: (filePath: string) => workspaceRelativeIdentityPath(env.configDir, filePath),
    })
  }

  /** The reader half, run entirely under the checkout that never saw the writer. */
  function appliesUnder(env: Checkout): boolean {
    const snapshot = resolveRunQuarantineSnapshot({
      knowledgeRoot: env.knowledgeRoot,
      product: PRODUCT,
      now: NOW,
    })
    expect(snapshot).toEqual([{
      product: PRODUCT,
      filePath: TEST_FILE_RELATIVE,
      testName: TEST_NAME,
      expiresAt: EXPECTED_EXPIRY,
    }])
    // Root B's OWN descriptor, minted from root B's own absolute path — never handed root A's bytes.
    return quarantineAppliesToTest(snapshot, {
      filePath: mintedIdentity(env),
      testName: TEST_NAME,
    })
  }

  /** The house negative anchor: the committed bytes name no machine that ever touched them. */
  function leaksNoRoot(from: Checkout, to: Checkout): void {
    const committed = ledgerText(from)
    expect(committed.length).toBeGreaterThan(0)
    expect(committed).not.toContain(from.configDir)
    expect(committed).not.toContain(to.configDir)
    expect(committed).not.toContain(tmpdir())
  }

  it('Class 1 — an ABSOLUTE path INSIDE the workspace is stored canonical and joins on root B', async () => {
    // The operator copy-pastes the path out of a failure report on the writing machine. Before the
    // mint this produced a permanently refused, unlistable, unreleasable line in a committed file.
    const machineA = checkout('agent-qa-390-verbmint-abs-A-')
    const ciCheckoutB = checkout('agent-qa-390-verbmint-abs-B-')

    const answer = await verbsUnder(machineA).add({
      product: PRODUCT,
      filePath: machineA.absoluteTestFile,
      testName: TEST_NAME,
    })

    expect(answer.kind).toBe('entered')
    // Anchored as the exact fixture string, outside the code's own field relations.
    expect(answer.entry.filePath).toBe(TEST_FILE_RELATIVE)
    expect(ledgerLines(machineA)).toHaveLength(1)
    expect(ledgerLines(machineA)[0]).toMatchObject({
      kind: 'entered',
      filePath: TEST_FILE_RELATIVE,
      product: PRODUCT,
      expiresAt: EXPECTED_EXPIRY,
      schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    })

    deliverLedger(machineA, ciCheckoutB)

    expect(appliesUnder(ciCheckoutB)).toBe(true)
    leaksNoRoot(machineA, ciCheckoutB)
  })

  it('Class 2 — a `./`-prefixed path is stored as the SAME bytes and joins on root B', async () => {
    // Round 1 measured this class as the QUIET one: it folded and listed as `quarantined` while
    // never matching `quarantineAppliesToTest`'s `===`. The operator saw a green row and the test
    // kept failing every build.
    const machineA = checkout('agent-qa-390-verbmint-dot-A-')
    const ciCheckoutB = checkout('agent-qa-390-verbmint-dot-B-')

    const answer = await verbsUnder(machineA).add({
      product: PRODUCT,
      filePath: `./${TEST_FILE_RELATIVE}`,
      testName: TEST_NAME,
    })

    expect(answer.entry.filePath).toBe(TEST_FILE_RELATIVE)
    expect(ledgerLines(machineA)[0]).toMatchObject({ filePath: TEST_FILE_RELATIVE })
    expect(ledgerText(machineA)).not.toContain(`./${TEST_FILE_RELATIVE}`)

    deliverLedger(machineA, ciCheckoutB)

    expect(appliesUnder(ciCheckoutB)).toBe(true)
    leaksNoRoot(machineA, ciCheckoutB)
  })

  it('Class 3 — a BACKSLASH path is refused by the ledger contract, byte-unchanged', async () => {
    // MEASURED, not assumed, and this is the arm that ships on a POSIX runner: `path.resolve` treats
    // `tests\checkout.yaml` as ONE filename containing a backslash, so the mint has nothing to
    // rewrite and hands the bytes back unchanged. 390-11's structural write guard then refuses them
    // — a backslash is not something the mint can emit, so no reader would consume the line. The
    // invariant holds through the OTHER arm: refused, with the ledger byte-unchanged.
    //
    // On a Windows runner the mint would separate the segments and this would land on the stored
    // arm instead. Either way the third outcome — a committed line the reader refuses — is absent.
    const machineA = checkout('agent-qa-390-verbmint-slash-A-')

    const refused = verbsUnder(machineA).add({
      product: PRODUCT,
      filePath: 'tests\\checkout.yaml',
      testName: TEST_NAME,
    })

    await expect(refused).rejects.toThrow(/would be refused by the ledger read/)
    expect(ledgerText(machineA)).toBe('')
    expect(existsSync(join(machineA.knowledgeRoot, QUARANTINE_LEDGER_FILE))).toBe(false)
  })

  it('Class 4 — an ESCAPING path refuses TYPED, byte-unchanged, and a RETRY adds nothing', async () => {
    const machineA = checkout('agent-qa-390-verbmint-escape-A-')
    const verbs = verbsUnder(machineA)

    for (const escaping of [
      '../outside.yaml',
      // The verifier's own probe shape: an absolute path that is not inside this workspace at all.
      join(tmpdir(), 'some-other-checkout', 'tests', 'checkout.yaml'),
    ]) {
      const refused = verbs.add({ product: PRODUCT, filePath: escaping, testName: TEST_NAME })
      await expect(refused).rejects.toBeInstanceOf(QuarantineIdentityRefusedError)
      await expect(refused).rejects.toMatchObject({
        name: 'QuarantineIdentityRefusedError',
        filePath: escaping,
      })
      // Retried, exactly as an operator would. Round 1 measured `line count after retry -> 2`.
      await expect(
        verbs.add({ product: PRODUCT, filePath: escaping, testName: TEST_NAME }),
      ).rejects.toBeInstanceOf(QuarantineIdentityRefusedError)
    }

    expect(ledgerText(machineA)).toBe('')
    expect(existsSync(join(machineA.knowledgeRoot, QUARANTINE_LEDGER_FILE))).toBe(false)
  })

  it('the EXIT PATH crosses spellings — a `./` release closes the window an ABSOLUTE add opened', async () => {
    // The two verbs are one contract: if only `add` minted, this release would answer `no-entry`
    // and the operator would have no way out of a window they themselves opened.
    const machineA = checkout('agent-qa-390-verbmint-exit-A-')
    const ciCheckoutB = checkout('agent-qa-390-verbmint-exit-B-')
    const verbs = verbsUnder(machineA)

    await verbs.add({
      product: PRODUCT,
      filePath: machineA.absoluteTestFile,
      testName: TEST_NAME,
    })
    deliverLedger(machineA, ciCheckoutB)
    expect(appliesUnder(ciCheckoutB)).toBe(true)

    const released = await verbs.release({
      product: PRODUCT,
      filePath: `./${TEST_FILE_RELATIVE}`,
      testName: TEST_NAME,
    })

    expect(released.kind).toBe('released')
    expect(ledgerLines(machineA).map((line) => line.kind)).toEqual(['entered', 'released-manual'])
    for (const line of ledgerLines(machineA)) expect(line.filePath).toBe(TEST_FILE_RELATIVE)

    // The re-delivered artifact suppresses nothing on the checkout that never saw either verb run.
    deliverLedger(machineA, ciCheckoutB)
    expect(resolveRunQuarantineSnapshot({
      knowledgeRoot: ciCheckoutB.knowledgeRoot,
      product: PRODUCT,
      now: NOW,
    })).toEqual([])
    leaksNoRoot(machineA, ciCheckoutB)
  })
})
