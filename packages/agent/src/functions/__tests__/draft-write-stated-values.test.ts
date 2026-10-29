// the historical substitution and its two faithful twins, through
// the public op with a scripted model and a fake shelf.

import {
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
  NO_RUNS_FAN_OUT_BOUND,
  MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { DraftReceipt, FunctionCaller } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { REQUEST_WINS_INSTRUCTION } from '../../authoring/brief-blocks.js'
import { runDocument } from '../../authoring/__tests__/evidence-fixtures.js'
import type { MemberFixture } from '../../authoring/__tests__/evidence-fixtures.js'
import { AUTHORING_REFINE_AGENT_CONTEXT } from '../../authoring/refine.js'
import { routeRepairOrStop } from '../../authoring/router.js'
import type { DraftShelfPortLike, ParsedDraftLike } from '../../authoring/ports.js'
import { invokeFunction } from '../invoke.js'
import { createFunctionRegistry } from '../registry.js'
import type { FunctionDeps } from '../spec.js'

const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

const TARGET = 'automation-exercise'
const SCOPE = { tier: 'product', key: TARGET } as const

const HISTORICAL_REQUEST = 'open the products page and check it says "Kitchen Appliances"'
const FAITHFUL_TRUE_REQUEST = 'open the products page and check it says "All Products"'

const HISTORICAL_DOCUMENT = `name: Confirm the products page shows the All Products heading
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: automation-exercise
steps:
  - Open the Automation Exercise home page
  - Click the " products" link
  - Verify the products page says "All Products"
`

const FAITHFUL_FALSE_DOCUMENT = `name: Confirm the products page shows the All Products heading
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: automation-exercise
steps:
  - Open the Automation Exercise home page
  - Click the " products" link
  - Verify the products page says "Kitchen Appliances"
`

const DIGESTS = new Map<string, string>([
  [HISTORICAL_DOCUMENT, 'digest-440-historical'],
  [FAITHFUL_FALSE_DOCUMENT, 'digest-440-faithful-false'],
])

const GATE_RUN_IDS = ['r_440-gate-0', 'r_440-gate-1', 'r_440-gate-2'] as const
const ROUTING_RUN_ID = GATE_RUN_IDS[2]

function stagedDraftOf(text: string): ParsedDraftLike {
  const lines = text.split('\n')
  const digest = DIGESTS.get(text) ?? 'digest-440-other'
  const name = (lines.find((line) => line.startsWith('name: ')) ?? 'name: ').slice('name: '.length)
  const testId = (lines.find((line) => line.startsWith('test-id: ')) ?? 'test-id: ')
    .slice('test-id: '.length)
  return {
    testId,
    filePath: `tests/.agent-qa-drafts/${digest}.yaml`,
    testName: name,
    target: TARGET,
    steps: lines.filter((line) => line.startsWith('  - ')).map((line) => line.slice(4)),
    contentDigest: digest,
  }
}

function draftRefOf(draft: ParsedDraftLike) {
  return {
    filePath: draft.filePath,
    testId: draft.testId,
    testName: draft.testName,
    contentDigest: draft.contentDigest,
  }
}

function keepEligibleReceipt(draft: ParsedDraftLike): DraftReceipt {
  return DraftReceiptSchema.parse({
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: draftRefOf(draft),
    gates: {
      executesDefinitive: { pass: true, runRefs: [...GATE_RUN_IDS], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: true,
        runRefs: [...GATE_RUN_IDS],
        distinctOutcomes: ['passed'],
        earlyStopped: false,
      },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 0 },
      falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
    },
    stepTable: [],
    gateRuns: GATE_RUN_IDS.map((runId) => ({
      runId,
      memberOutcome: 'passed',
      definitive: true,
      healed: false,
    })),
    addsValueFinding: { novelElements: ['el:heading "all products"'], comparedTests: [] },
    stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
    stabilityRunsCompleted: GATE_RUN_IDS.length,
    disposition: 'keep-eligible',
    evaluatedAt: 1,
  })
}

function rejectedReceipt(draft: ParsedDraftLike): DraftReceipt {
  const accepted = keepEligibleReceipt(draft)
  return DraftReceiptSchema.parse({
    ...accepted,
    gates: {
      ...accepted.gates,
      executesDefinitive: { pass: false, runRefs: [ROUTING_RUN_ID], indefinitiveRunRefs: [] },
    },
    gateRuns: [{
      runId: ROUTING_RUN_ID,
      memberOutcome: 'failed',
      definitive: true,
      healed: false,
      reason: 'fixture: the claim was evaluated and did not hold',
    }],
    stabilityRunsCompleted: 1,
    disposition: 'rejected',
  })
}

const PRODUCTS_URL = 'http://127.0.0.1:8931/products'

function memberOf(draft: ParsedDraftLike, outcome: 'passed' | 'failed'): MemberFixture {
  return {
    filePath: draft.filePath,
    testName: draft.testName,
    outcome,
    steps: [
      [{ type: 'navigate', url: PRODUCTS_URL }],
      [{ type: 'click', ref: 'e3', role: 'link', name: 'products' }],
      [{
        type: 'assertValue',
        ref: 'e7',
        role: 'heading',
        name: 'all products',
        ...(outcome === 'failed' ? { success: false } : {}),
      }],
    ],
    ...(outcome === 'failed'
      ? {
          failedSteps: [2],
          verdictSourceSteps: [{ stepIndex: 2, source: 'assert-value' as never }],
        }
      : {}),
  }
}

function cleanFailRun(draft: ParsedDraftLike) {
  return runDocument(ROUTING_RUN_ID, [memberOf(draft, 'failed')])
}

function publicPathHost(options: {
  readonly document: string
  readonly runs: 'pass' | 'clean-fail'
}) {
  const counts = { model: 0, verify: 0 }
  const published: string[] = []
  const requests: { readonly system?: string; readonly prompt: string }[] = []
  let staged: ParsedDraftLike | undefined

  const stagedDraft = (): ParsedDraftLike => {
    if (staged === undefined) throw new Error('no draft was staged before it was read')
    return staged
  }

  const shelf: DraftShelfPortLike = {
    model: () => Promise.resolve({
      modelId: 'fixture:440-public-path',
      generate(request) {
        counts.model += 1
        requests.push(request)
        if ((request.system ?? '').includes(AUTHORING_REFINE_AGENT_CONTEXT)) {
          return Promise.resolve({ text: '{"thoughts":"","patches":[]}' })
        }
        return Promise.resolve({ text: options.document })
      },
    }),
    write(contents: string) {
      staged = stagedDraftOf(contents)
      return Promise.resolve({ kind: 'staged' as const, draft: staged })
    },
    applyPatches(): Promise<never> {
      throw new Error('the public-path cells never reach repair, so no patch is applied')
    },
    runs: {
      start(): Promise<never> {
        throw new Error('the public-path cells start no probe run')
      },
      get(runId: string) {
        const draft = stagedDraft()
        return Promise.resolve(
          options.runs === 'clean-fail'
            ? cleanFailRun(draft)
            : runDocument(runId, [memberOf(draft, 'passed')]),
        )
      },
    },
    verifyDraft() {
      counts.verify += 1
      const draft = stagedDraft()
      return Promise.resolve(
        options.runs === 'pass' ? keepEligibleReceipt(draft) : rejectedReceipt(draft),
      )
    },
    publish(request) {
      published.push(request.targetPath)
      return Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: stagedDraft().contentDigest,
      })
    },
  }

  const deps = {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }: { readonly recordId: string }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    draftShelf: shelf,
    authoringRead: {
      getAuthoringBrief: () => Promise.resolve({
        scope: SCOPE,
        facts: [],
        cautions: [],
        procedures: [],
        exemplars: [],
      }),
      suiteTextCorpus: () => Promise.resolve([]),
      configuredTargetNames: () => Promise.resolve([TARGET]),
    },
  } as unknown as FunctionDeps

  const registry = createFunctionRegistry({ deps })

  return {
    counts,
    published,
    requests,
    async write(intent: string): Promise<Record<string, unknown>> {
      return await invokeFunction(
        registry,
        'authoring.draft.write',
        { intent, scope: SCOPE },
        CALLER,
      ) as Record<string, unknown>
    },
  }
}

function writtenKind(output: Record<string, unknown>): unknown {
  const written = output['written'] as { readonly file?: { readonly kind?: unknown } } | undefined
  return written?.file?.kind ?? null
}

function runsSpent(output: Record<string, unknown>): unknown {
  return (output['fanOut'] as { readonly consumedTotal?: unknown } | undefined)?.consumedTotal
}

describe('authoring.draft.write on the historical substitution and its faithful twins', () => {
  it('the clean-failing fixture routes to a clean definitive assertion failure', () => {
    const draft = stagedDraftOf(FAITHFUL_FALSE_DOCUMENT)
    const route = routeRepairOrStop(draftRefOf(draft), cleanFailRun(draft))
    expect({ kind: route.kind, signalClass: route.signalClass })
      .toEqual({ kind: 'stop', signalClass: 'clean-definitive-assertion-fail' })
  })

  it('the historical substitution is refused at compile with no run spent and nothing written', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(HISTORICAL_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      written: writtenKind(output),
      published: host.published.length,
      verifyCalls: host.counts.verify,
      modelCalls: host.counts.model,
      runsSpent: runsSpent(output),
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['Kitchen Appliances'] },
      written: null,
      published: 0,
      verifyCalls: 0,
      modelCalls: 1,
      runsSpent: 0,
    })
  })

  it('a faithful draft of what the page shows is kept and written', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(FAITHFUL_TRUE_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      written: writtenKind(output),
      published: host.published.length,
      verifyCalls: host.counts.verify,
      modelCalls: host.counts.model,
      runsSpent: runsSpent(output),
    }).toEqual({
      outcome: 'drafted',
      statedValueRefusal: null,
      written: 'written',
      published: 1,
      verifyCalls: 1,
      modelCalls: 2,
      runsSpent: 3,
    })
  })

  it('a faithful draft the app disagrees with stops on rule 2 and writes nothing', async () => {
    const host = publicPathHost({ document: FAITHFUL_FALSE_DOCUMENT, runs: 'clean-fail' })
    const output = await host.write(HISTORICAL_REQUEST)
    const stop = output['stop'] as { readonly signalClass?: unknown } | undefined

    expect({
      outcome: output['outcome'],
      signalClass: stop?.signalClass ?? null,
      written: writtenKind(output),
      published: host.published.length,
      statedValueRefusal: output['statedValueRefusal'] ?? null,
    }).toEqual({
      outcome: 'stopped',
      signalClass: 'clean-definitive-assertion-fail',
      written: null,
      published: 0,
      statedValueRefusal: null,
    })
  })
})

// the compile check's behaviours through the public op.
const CASE_CHANGED_DOCUMENT = `name: Confirm the products page shows the Kitchen appliances heading
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: automation-exercise
steps:
  - Open the Automation Exercise home page
  - Click the " products" link
  - Verify the products page says "Kitchen appliances"
`

const SALE_REQUEST =
  'open the products page and check the "Sale" banner shows $20 and "Kitchen Appliances"'

const SALE_ONLY_DOCUMENT = `name: Confirm the products page shows the Sale banner
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: automation-exercise
steps:
  - Open the Automation Exercise home page
  - Click the " products" link
  - Verify the products page shows the "Sale" banner
`

const REWORDED_DOCUMENT = `name: Confirm the products page lists its items under All Products
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: automation-exercise
steps:
  - Sign in to Automation Exercise as the test user
  - Go to the Automation Exercise landing page
  - Follow the products link in the header
  - Verify the products page heading reads "All Products"
  - Verify the products page lists at least one item
`

const VAGUE_REQUEST = 'test the products page'

function stepsOf(document: string): readonly string[] {
  return stagedDraftOf(document).steps
}

describe('stated values checked at compile', () => {
  it('a case-changed value is refused at compile', async () => {
    const host = publicPathHost({ document: CASE_CHANGED_DOCUMENT, runs: 'pass' })
    const output = await host.write(HISTORICAL_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['Kitchen Appliances'] },
      verifyCalls: 0,
      published: 0,
    })
  })

  it("the refusal names every missing value in the request's order and nothing from the draft", async () => {
    const host = publicPathHost({ document: SALE_ONLY_DOCUMENT, runs: 'pass' })
    const output = await host.write(SALE_REQUEST)
    const refusal = output['statedValueRefusal'] as
      { readonly missingValues: readonly string[] } | undefined
    const serialized = JSON.stringify(refusal)

    expect(refusal?.missingValues).toEqual(['$20', 'Kitchen Appliances'])
    expect(refusal?.missingValues.every((value) => SALE_REQUEST.includes(value))).toBe(true)
    expect(stepsOf(SALE_ONLY_DOCUMENT).filter((step) => serialized.includes(step))).toEqual([])
  })

  it("a compile refusal carries the compiled draft's ref and no receipt", async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(HISTORICAL_REQUEST)
    const draftRef = output['draftRef'] as { readonly testName?: unknown } | undefined
    const fanOut = output['fanOut'] as
      { readonly consumedTotal?: unknown; readonly previewed?: unknown } | undefined

    expect({
      testName: draftRef?.testName,
      hasReceipt: 'receipt' in output,
      consumedTotal: fanOut?.consumedTotal,
      previewed: fanOut?.previewed,
    }).toEqual({
      testName: stagedDraftOf(HISTORICAL_DOCUMENT).testName,
      hasReceipt: false,
      consumedTotal: 0,
      previewed: NO_RUNS_FAN_OUT_BOUND,
    })
  })

  it('reworded unquoted words, added steps and added checks are kept', async () => {
    const host = publicPathHost({ document: REWORDED_DOCUMENT, runs: 'pass' })
    const output = await host.write(FAITHFUL_TRUE_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      written: writtenKind(output),
      published: host.published.length,
    }).toEqual({ outcome: 'drafted', statedValueRefusal: null, written: 'written', published: 1 })
  })

  it('a vague request is never refused', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(VAGUE_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      written: writtenKind(output),
      published: host.published.length,
    }).toEqual({ outcome: 'drafted', statedValueRefusal: null, written: 'written', published: 1 })
  })

  it('no model call is added', async () => {
    const refused = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const kept = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const refusedOutput = await refused.write(HISTORICAL_REQUEST)
    const keptOutput = await kept.write(FAITHFUL_TRUE_REQUEST)

    expect({
      refused: [refusedOutput['outcome'], refused.counts.model],
      kept: [keptOutput['outcome'], kept.counts.model],
    }).toEqual({ refused: ['refused', 1], kept: ['drafted', 2] })
  })
})

describe('the compile prompt', () => {
  it('the compile prompt puts the request over project knowledge', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    await host.write(HISTORICAL_REQUEST)
    const compile = host.requests[0]

    expect(compile?.system).toContain(REQUEST_WINS_INSTRUCTION)
    expect(compile?.system).toContain(`${REQUEST_WINS_INSTRUCTION}\n\n## Test document format`)
    expect(compile?.prompt).toContain(`## Intent\n\n${HISTORICAL_REQUEST}\n\n## Scope`)
  })

  it('the compile block titles are unchanged', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    await host.write(HISTORICAL_REQUEST)
    const compile = host.requests[0]
    const titles = (text: string | undefined): readonly string[] =>
      (text ?? '')
        .split('\n')
        .filter((line) => line.startsWith('## '))
        .map((line) => line.slice(3))

    expect({ system: titles(compile?.system), prompt: titles(compile?.prompt) }).toEqual({
      system: ['Role', 'Test document format', 'Procedures'],
      prompt: [
        'Intent',
        'Scope',
        'Configured targets',
        'What this project knows',
        'Exemplar tests',
      ],
    })
  })
})

// a numbered request through the public op.
const NUMBERED_REQUEST = '1. open the products page\n2. check it says "All Products"'
const NUMBERED_INLINE_REQUEST = '1. open the products page 2. check it says "All Products"'
const PARENTHESIZED_REQUEST = '(1) open the products page\n(2) check it says "All Products"'
const PARENTHESIZED_INLINE_REQUEST = '(1) open the products page (2) check it says "All Products"'
const NUMBERED_COUNT_REQUEST =
  '1. open the products page\n2. check it lists 12 items and says "All Products"'
const STEP_REQUEST = 'Step 1: open the products page. Step 2: check it says "All Products"'

describe('numbered and step-labelled requests', () => {
  it('a numbered request with a faithful draft is kept and written', async () => {
    for (const request of [NUMBERED_REQUEST, NUMBERED_INLINE_REQUEST]) {
      const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
      const output = await host.write(request)

      expect({
        outcome: output['outcome'],
        statedValueRefusal: output['statedValueRefusal'] ?? null,
        written: writtenKind(output),
        published: host.published.length,
      }).toEqual({ outcome: 'drafted', statedValueRefusal: null, written: 'written', published: 1 })
    }
  })

  it('a request numbered in parentheses with a faithful draft is kept and written', async () => {
    for (const request of [PARENTHESIZED_REQUEST, PARENTHESIZED_INLINE_REQUEST]) {
      const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
      const output = await host.write(request)

      expect({
        outcome: output['outcome'],
        statedValueRefusal: output['statedValueRefusal'] ?? null,
        written: writtenKind(output),
        published: host.published.length,
      }).toEqual({ outcome: 'drafted', statedValueRefusal: null, written: 'written', published: 1 })
    }
  })

  it('a number stated inside a numbered item is still refused at compile when the draft loses it', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(NUMBERED_COUNT_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['12'] },
      verifyCalls: 0,
      published: 0,
    })
  })

  it('a step-labelled request with a faithful draft is kept and written', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(STEP_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      written: writtenKind(output),
      published: host.published.length,
    }).toEqual({ outcome: 'drafted', statedValueRefusal: null, written: 'written', published: 1 })
  })
})

// a value round 1 stopped protecting is refused again through the public op.
const DIGIT_QUOTED_REQUEST =
  `open the products page, check the '4K' badge and check it says "All Products"`
const BRACKETED_TIME_REQUEST =
  'open the products page, check the slot [10:30] and check it says "All Products"'

describe('values that start with digits and bracketed times', () => {
  it('a single-quoted value that starts with digits glued to a letter is refused at compile when the draft loses it', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(DIGIT_QUOTED_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['4K'] },
      verifyCalls: 0,
      published: 0,
    })
  })

  it('a bracketed time is refused at compile when the draft loses it', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(BRACKETED_TIME_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['10:30'] },
      verifyCalls: 0,
      published: 0,
    })
  })
})

// a lone 1 and a mid-sentence step number are refused again through the public op.
const COLON_ONE_REQUEST =
  'open the products page and check the badge shows: 1. Then check it says "All Products"'
const MID_SENTENCE_STEP_REQUEST =
  'open the products page, check the wizard is on step 2. Then check it says "All Products"'

describe('step numbers stated after a colon or mid-sentence', () => {
  it('a lone 1 stated after a colon is refused at compile when the draft loses it', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(COLON_ONE_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['1'] },
      verifyCalls: 0,
      published: 0,
    })
  })

  it('a step number stated mid-sentence is refused at compile when the draft loses it', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(MID_SENTENCE_STEP_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['2'] },
      verifyCalls: 0,
      published: 0,
    })
  })
})

// a held step heading's numbers are refused again through the public op.
const HELD_STEP_HEADING_REQUEST =
  'open the products page, check the title shows: Step 1. Then click Next and check it shows Step 2. Then check it says "All Products"'

describe('step numbers in a held step heading', () => {
  it('a step number stated in a held step heading is refused at compile when the draft loses it', async () => {
    const host = publicPathHost({ document: HISTORICAL_DOCUMENT, runs: 'pass' })
    const output = await host.write(HELD_STEP_HEADING_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['1', '2'] },
      verifyCalls: 0,
      published: 0,
    })
  })
})

// a month-name date beside a list run is refused again through the public op.
const DATE_IN_LIST_REQUEST =
  '1. open the products page\n2. check the delivery date shows Oct 3. Then check it says "All Products"'
const DATE_AFTER_HELD_START_REQUEST =
  '1. open the products page and check the badge shows: 1. Then check the delivery date shows Oct 2. Then check it says "All Products"'

const CHANGED_DATE_DOCUMENT = `name: Confirm the products page shows the delivery date and the All Products heading
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: automation-exercise
steps:
  - Open the Automation Exercise home page
  - Click the " products" link
  - Verify the badge shows 1
  - Verify the delivery date shows Oct 4
  - Verify the products page says "All Products"
`

describe('a month-name date where a list marker would go', () => {
  it('a month-name date where the next list marker would go is refused at compile when the draft changes it', async () => {
    const cases = [
      [DATE_IN_LIST_REQUEST, ['Oct 3']],
      [DATE_AFTER_HELD_START_REQUEST, ['Oct 2']],
    ] as const
    for (const [request, missingValues] of cases) {
      const host = publicPathHost({ document: CHANGED_DATE_DOCUMENT, runs: 'pass' })
      const output = await host.write(request)

      expect({
        outcome: output['outcome'],
        statedValueRefusal: output['statedValueRefusal'] ?? null,
        verifyCalls: host.counts.verify,
        published: host.published.length,
      }).toEqual({
        outcome: 'refused',
        statedValueRefusal: { stage: 'compile', missingValues },
        verifyCalls: 0,
        published: 0,
      })
    }
  })
})

// 2026-10-12 (440-16, D-05; the round-4 regression): a stated badge number beside a month-name date is refused again through the public op.
const HELD_START_BESIDE_DATE_REQUEST =
  'Check the badge shows: 1. Then check the delivery date is Oct 2. Then set it to 2. then check it says "All Products"'

const CHANGED_BADGE_DOCUMENT = `name: Confirm the products page shows the badge, the delivery date and the All Products heading
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: automation-exercise
steps:
  - Open the Automation Exercise home page
  - Click the " products" link
  - Verify the badge shows 0
  - Verify the delivery date is Oct 2
  - Set the quantity to 2
  - Verify the products page says "All Products"
`

describe('a badge number beside a month-name date', () => {
  it('a stated badge number beside a month-name date is refused at compile when the draft changes it', async () => {
    const host = publicPathHost({ document: CHANGED_BADGE_DOCUMENT, runs: 'pass' })
    const output = await host.write(HELD_START_BESIDE_DATE_REQUEST)

    expect({
      outcome: output['outcome'],
      statedValueRefusal: output['statedValueRefusal'] ?? null,
      verifyCalls: host.counts.verify,
      published: host.published.length,
    }).toEqual({
      outcome: 'refused',
      statedValueRefusal: { stage: 'compile', missingValues: ['1'] },
      verifyCalls: 0,
      published: 0,
    })
  })
})
