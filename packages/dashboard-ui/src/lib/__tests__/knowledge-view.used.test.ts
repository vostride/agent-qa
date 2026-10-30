// The section set, the grouped used rows and the step-reference text.

import { describe, expect, it } from 'vitest'
import { RunKnowledgeProjectionSchema, type RunKnowledgeProjection, RECORD_CHANGE_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

import {
  ANCHOR_PHRASE_TYPES,
  CURRENT_STATUS_WORDS,
  KNOWLEDGE_SECTIONS,
  PROCEDURE_CONTENT_NOT_RECORDED_LEAD,
  RECORD_KIND_LABELS,
  RECORD_UNREADABLE_LEAD,
  SINCE_STATUS_TAGS,
  USE_VERBS,
  applicabilityText,
  applicabilityView,
  contentById,
  formatStepRefs,
  parseAnchor,
  sinceStatusFor,
  stepRefAccessibleName,
  trustCountsLine,
  usedCountLine,
  usedRecordViews,
  type StepAddress,
  type StepRefSegment,
} from '@/lib/knowledge-view'

type ReadyProjection = Extract<RunKnowledgeProjection, { kind: 'ready' }>
type Join = { recordContent?: ReturnType<typeof content>; contentAbsence?: { reason: 'not-found' | 'scan-incomplete' | 'not-bound' } }

function content(summary: string, kind = 'fact') {
  return {
    content: `body of ${summary}`,
    summary,
    kind,
    applicability: { product: 'shop', scope: 'shop', anchors: [] as string[], openedAtOrdinal: 1 },
    currentStatus: 'active',
    currentTrust: { confirmations: 1, contradictions: 0, evidenceTokens: [], lastEventOrdinal: 1 },
  }
}

function line(id: string, summary: string, join: Join = {}, kind = 'fact') {
  return { id, kind, summary, trust: 0.9, status: 'active', servedAsCanary: false, tier: 'confirmed', ...join }
}

function caution(id: string, summary: string, join: Join = {}) {
  return { id, summary, ...join }
}

function opened(id: string, join: Join = {}) {
  return { id, detailLevel: 'full', bodyDigest: `digest-${id}`, ...join }
}

function replay(procedureId: string) {
  return { kind: 'procedure-replay', procedureId, guard: { checksPassed: 2, total: 2 } }
}

function hint(procedureId: string) {
  return { kind: 'procedure-hint', procedureId }
}

interface Served {
  readonly channel1?: ReturnType<typeof line>[]
  readonly channel2?: ReturnType<typeof opened>[]
  readonly channel3?: ReturnType<typeof caution>[]
  readonly planSource?: ReturnType<typeof replay> | ReturnType<typeof hint>
}

function servedStep(stepIndex: number, served: Served, testIndex = 0) {
  return {
    testId: 't_used',
    testIndex,
    stepIndex,
    stepText: `step text ${String(stepIndex)}`,
    served: { channel1: served.channel1 ?? [], channel2: served.channel2 ?? [], channel3: served.channel3 ?? [] },
    trace: { kind: 'no-trace', reason: 'pre-trace-run' },
    ...(served.planSource === undefined ? {} : { planSource: served.planSource }),
  }
}

function step(stepIndex: number, channel1: ReturnType<typeof line>[], testIndex = 0) {
  return servedStep(stepIndex, { channel1 }, testIndex)
}

function change(recordId: string, join: Join) {
  return { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId, change: 'added', atOrdinal: 2, ...join }
}

function projection(
  steps: ReturnType<typeof step>[],
  learned: { changes?: ReturnType<typeof change>[]; sinceThen?: ReturnType<typeof change>[] } = {},
): ReadyProjection {
  const parsed = RunKnowledgeProjectionSchema.parse({
    kind: 'ready',
    runId: 'run-used',
    buildOrdinal: 1,
    knowledgeStore: 'bound',
    steps,
    curation: { status: 'complete' },
    learned: {
      changes: learned.changes ?? [],
      canaryAttributions: [],
      ...(learned.sinceThen === undefined
        ? {}
        : { sinceThen: { changes: learned.sinceThen, count: learned.sinceThen.length } }),
    },
  })
  if (parsed.kind !== 'ready') throw new Error('expected a ready projection')
  return parsed
}

const at = (stepIndex: number, testIndex = 0): StepAddress => ({ testIndex, stepIndex, stepText: `step text ${String(stepIndex)}` })

function text(segments: readonly StepRefSegment[]): string {
  return segments.map(segment => (segment.kind === 'text' ? segment.text : segment.label)).join('')
}

describe('the knowledge view closed sets are exactly the published members', () => {
  it('the sections and the use verbs', () => {
    expect(KNOWLEDGE_SECTIONS).toEqual(['used', 'effect', 'changes', 'retrieval-details'])
    expect(USE_VERBS).toEqual(['given', 'opened', 'caution', 'replayed', 'hint'])
    expect(ANCHOR_PHRASE_TYPES).toEqual(['platform', 'page', 'flow', 'el', 'selector', 'error', 'unparsed'])
    expect(SINCE_STATUS_TAGS).toEqual({
      active: 'since proven',
      candidate: 'since put back on trial',
      superseded: 'since superseded',
      deprecated: 'since retired',
    })
    expect(CURRENT_STATUS_WORDS).toEqual({
      active: 'in use',
      candidate: 'on trial',
      superseded: 'superseded',
      deprecated: 'retired',
    })
    expect(RECORD_KIND_LABELS).toEqual({
      fact: 'Fact',
      caution: 'Caution',
      procedure: 'Procedure',
      policy: 'Policy',
      unknown: 'Open question',
    })
  })
})

describe('every way the run used a record is one row, in first-use order', () => {
  it('EVERY-USE-ONE-ROW: given plus opened is one row; a caution is its own; a replay and a hint of one procedure are one row', () => {
    const views = usedRecordViews(projection([
      servedStep(0, { channel1: [line('rec_a', 'fact A')], channel3: [caution('rec_b', 'caution B')] }),
      servedStep(1, { channel1: [line('rec_a', 'fact A')], channel2: [opened('rec_a')], planSource: replay('rec_p') }),
      servedStep(2, { channel1: [line('rec_a', 'fact A')], planSource: hint('rec_p') }),
    ]))

    expect(views.map(view => view.uses)).toEqual([
      [{ verb: 'given', addresses: [at(0), at(1), at(2)] }, { verb: 'opened', addresses: [at(1)] }],
      [{ verb: 'caution', addresses: [at(0)] }],
      [{ verb: 'replayed', addresses: [at(1)] }, { verb: 'hint', addresses: [at(2)] }],
    ])
    expect(views.map(view => view.primary)).toEqual(['fact A', 'caution B', PROCEDURE_CONTENT_NOT_RECORDED_LEAD])
    expect(views.map(view => view.key)).toEqual(['0', '1', '2'])
    expect(JSON.stringify(views)).not.toContain('rec_')
  })

  it('FIRST-USE-ORDER: within one step given, caution, plan source, opened; across steps the earliest (test, step); wire order is irrelevant', () => {
    const oneStep = usedRecordViews(projection([
      servedStep(0, {
        channel1: [line('rec_a', 'A')],
        channel2: [opened('rec_c', { recordContent: content('C') })],
        channel3: [caution('rec_b', 'B')],
        planSource: hint('rec_p'),
      }),
    ]))
    expect(oneStep.map(view => view.primary)).toEqual(['A', 'B', PROCEDURE_CONTENT_NOT_RECORDED_LEAD, 'C'])
    expect(oneStep.map(view => view.uses.map(use => use.verb))).toEqual([['given'], ['caution'], ['hint'], ['opened']])

    const inOrder = [
      servedStep(5, { channel1: [line('rec_early', 'first used in test 0 step 6')] }, 0),
      servedStep(0, { channel1: [line('rec_late', 'first used in test 1 step 1')] }, 1),
      servedStep(1, { channel1: [line('rec_early', 'first used in test 0 step 6')] }, 1),
    ]
    const ordered = usedRecordViews(projection(inOrder))
    expect(ordered.map(view => view.primary)).toEqual(['first used in test 0 step 6', 'first used in test 1 step 1'])

    const shuffled = usedRecordViews(projection([inOrder[2]!, inOrder[1]!, inOrder[0]!]))
    expect(shuffled).toEqual(ordered)
  })
})

describe('one pinned rule leads every used row', () => {
  it('SUMMARY-RULE: served first, then joined content, then the unreadable lead, then the not-recorded procedure lead', () => {
    const views = usedRecordViews(projection(
      [
        servedStep(0, {
          channel1: [line('rec_a', 'what the agent saw', { recordContent: content('what the store says now', 'caution') })],
          channel2: [
            opened('rec_o', { recordContent: content('joined summary of O', 'policy') }),
            opened('rec_n', { contentAbsence: { reason: 'not-found' } }),
          ],
        }),
        servedStep(1, { planSource: replay('rec_p') }),
        servedStep(2, {
          channel3: [caution('rec_c', 'caution as served', { contentAbsence: { reason: 'scan-incomplete' } })],
          planSource: hint('rec_q'),
        }),
      ],
      { changes: [change('rec_p', { recordContent: content('procedure summary from a learned change', 'procedure') })] },
    ))

    expect(views.map(view => [view.primary, view.leadSource])).toEqual([
      ['what the agent saw', 'served'],
      ['joined summary of O', 'joined'],
      [RECORD_UNREADABLE_LEAD, 'absent'],
      ['procedure summary from a learned change', 'joined'],
      ['caution as served', 'served'],
      [PROCEDURE_CONTENT_NOT_RECORDED_LEAD, 'not-recorded'],
    ])
    expect(views.map(view => view.kind)).toEqual(['caution', 'policy', undefined, 'procedure', undefined, undefined])
    expect(views[0]?.content?.summary).toBe('what the store says now')
    expect(views[2]?.contentAbsence).toEqual({ reason: 'not-found' })
    expect(views[4]?.contentAbsence).toEqual({ reason: 'scan-incomplete' })
    expect(views[5]?.content).toBeUndefined()
    expect(views[5]?.contentAbsence).toBeUndefined()
    expect(JSON.stringify(views)).not.toContain('rec_')
  })

  it('SUMMARY-RULE: the kind falls back to a served channel-1 kind only when it is one of the five', () => {
    const views = usedRecordViews(projection([
      servedStep(0, { channel1: [line('rec_x', 'policy line', {}, 'policy'), line('rec_y', 'odd line', {}, 'hunch')] }),
    ]))
    expect(views.map(view => view.kind)).toEqual(['policy', undefined])
  })
})

describe('contentById folds every joined row in the read by record id', () => {
  it('CONTENT-BY-ID: first content across channels 1, 3, 2, learned.changes and sinceThen; else the first absence; else nothing', () => {
    expect(contentById).toBeTypeOf('function')
    const joined = contentById(projection(
      [
        servedStep(0, {
          channel1: [line('rec_x', 'X', { recordContent: content('X from channel 1') })],
          channel2: [opened('rec_x', { recordContent: content('X from channel 2') }), opened('rec_m', { contentAbsence: { reason: 'not-bound' } })],
          channel3: [caution('rec_y', 'Y', { contentAbsence: { reason: 'scan-incomplete' } })],
        }),
        servedStep(1, { channel1: [line('rec_w', 'W')] }),
      ],
      {
        changes: [change('rec_m', { recordContent: content('M from a learned change') }), change('rec_y', { contentAbsence: { reason: 'not-found' } })],
        sinceThen: [change('rec_z', { recordContent: content('Z since then') })],
      },
    ))

    expect(joined.get('rec_x')?.content?.summary).toBe('X from channel 1')
    expect(joined.get('rec_m')?.content?.summary).toBe('M from a learned change')
    expect(joined.get('rec_m')?.absence).toBeUndefined()
    expect(joined.get('rec_y')?.content).toBeUndefined()
    expect(joined.get('rec_y')?.absence).toEqual({ reason: 'scan-incomplete' })
    expect(joined.get('rec_z')?.content?.summary).toBe('Z since then')
    expect(joined.has('rec_w')).toBe(false)
  })
})

describe('a record used in several steps is one row', () => {
  it('GROUPED-ONE-ROW: one id across three steps is one view; equal summaries under two ids stay two; first use orders rows', () => {
    const shared = line('rec_shared', 'the cart page lives at /view_cart')
    const grouped = usedRecordViews(projection([step(0, [shared]), step(1, [shared]), step(2, [shared])]))
    expect(grouped).toEqual([
      { key: '0', primary: shared.summary, leadSource: 'served', kind: 'fact', uses: [{ verb: 'given', addresses: [at(0), at(1), at(2)] }] },
    ])

    const twins = usedRecordViews(projection([
      step(0, [line('rec_a', 'same words'), line('rec_b', 'same words')]),
    ]))
    expect(twins.map(view => view.primary)).toEqual(['same words', 'same words'])
    expect(twins.length).toBe(2)

    const ordered = usedRecordViews(projection([
      step(3, [line('rec_late', 'late')]),
      step(1, [line('rec_first', 'first'), line('rec_second', 'second')]),
      step(2, [line('rec_late', 'late')]),
    ]))
    expect(ordered.map(view => view.primary)).toEqual(['first', 'second', 'late'])
    expect(ordered[2]?.uses[0]?.addresses).toEqual([at(2), at(3)])
    expect(JSON.stringify(ordered)).not.toContain('rec_')
  })

  it('counts records as the heading line reads them', () => {
    expect(usedCountLine(1)).toBe('1 record')
    expect(usedCountLine(4)).toBe('4 records')
  })
})

describe('step references read as a person counts them', () => {
  it('FORMAT-STEP-REFS: one, two, a range, a range plus one, a list — de-duplicated and order-free', () => {
    expect(text(formatStepRefs([at(1)]))).toBe('step 2')
    expect(text(formatStepRefs([at(0), at(1)]))).toBe('steps 1 and 2')

    const range = formatStepRefs([at(0), at(1), at(2)])
    expect(text(range)).toBe('steps 1–3')
    expect(range).toEqual([
      { kind: 'text', text: 'steps ' },
      { kind: 'step', address: at(0), label: '1' },
      { kind: 'text', text: '–' },
      { kind: 'step', address: at(2), label: '3' },
    ])

    expect(text(formatStepRefs([at(0), at(1), at(2), at(4)]))).toBe('steps 1–3 and 5')
    expect(text(formatStepRefs([at(0), at(2), at(4)]))).toBe('steps 1, 3 and 5')
    expect(text(formatStepRefs([at(4), at(0), at(2), at(0), at(2)]))).toBe('steps 1, 3 and 5')
    expect(text(formatStepRefs([at(2), at(1), at(1), at(0)]))).toBe('steps 1–3')
  })
})

describe('suite step references name their test; a single-test run never does', () => {
  it('STEP-REF-SUITE-NAMES: groups by member in testIndex order as {test} · {steps}, joined by "; "', () => {
    const names = new Map([[0, 'checkout'], [1, 'login']])
    const addresses = [at(1, 1), at(2, 0), at(0, 0), at(1, 0)]

    const suite = formatStepRefs(addresses, names)
    expect(text(suite)).toBe('checkout · steps 1–3; login · step 2')
    expect(suite.filter(segment => segment.kind === 'step').map(segment => segment.label)).toEqual(['1', '3', '2'])
    expect(suite.filter(segment => segment.kind === 'text').map(segment => segment.text))
      .toEqual(['checkout', ' · ', 'steps ', '–', '; ', 'login', ' · ', 'step '])

    expect(text(formatStepRefs(addresses, new Map()))).toBe('steps 1–3 and 2')
    expect(text(formatStepRefs(addresses))).toBe('steps 1–3 and 2')
  })
})

describe('a step reference has a full accessible name', () => {
  it('STEP-REF-ACCESSIBLE-NAME: step number one-based, step text in its served form, test name in a suite', () => {
    const address: StepAddress = { testIndex: 0, stepIndex: 1, stepText: 'Open cart' }
    expect(stepRefAccessibleName(address)).toBe('Go to step 2 · Open cart')
    expect(stepRefAccessibleName(address, 'checkout')).toBe('Go to checkout · step 2 · Open cart')
  })
})

const anchor = (value: Record<string, unknown>) => JSON.stringify(value)

function applicability(product: string, scope: string, anchors: readonly string[]) {
  return { product, scope, anchors: [...anchors], openedAtOrdinal: 1 }
}

describe('where a record applies, in plain words', () => {
  it('APPLICABILITY-KNOWN-ANSWER: the demo-store record reads Applies to example-web · web · flow measurement:assert-value:url', () => {
    expect(applicabilityView).toBeTypeOf('function')
    const known = applicability('example-web', 'example-web', [
      '{"platform":"web","t":"platform"}',
      '{"name":"measurement:assert-value:url","t":"flow"}',
    ])
    expect(applicabilityText(applicabilityView(known))).toBe('Applies to example-web · web · flow measurement:assert-value:url')

    const joined = { ...content('the url is asserted'), applicability: known }
    const [view] = usedRecordViews(projection([step(0, [line('rec_k', 'the url is asserted', { recordContent: joined })])]))
    expect(view?.applicability).toEqual(applicabilityView(known))
    expect(JSON.stringify(view)).not.toContain('rec_')
  })

  it('APPLICABILITY-ORDER: platform, page, flow, element, selector, error whatever order the anchors arrive in', () => {
    expect(applicabilityView).toBeTypeOf('function')
    const view = applicabilityView(applicability('shop', 'shop', [
      anchor({ message: 'Out of stock', t: 'error' }),
      anchor({ literal: '#buy > button', t: 'selector' }),
      anchor({ name: 'Buy', ordinal: 2, role: 'button', t: 'el' }),
      anchor({ route: '/cart', t: 'page' }),
      anchor({ name: 'checkout', t: 'flow' }),
      anchor({ platform: 'android', t: 'platform' }),
    ]))
    expect(view.phrases.map(phrase => phrase.type)).toEqual(['platform', 'page', 'flow', 'el', 'selector', 'error'])
    expect(view.phrases).toEqual([
      { type: 'platform', text: 'android' },
      { type: 'page', text: 'page /cart' },
      { type: 'flow', text: 'flow checkout' },
      { type: 'el', text: 'element button "Buy" #2' },
      { type: 'selector', text: 'selector', literal: '#buy > button' },
      { type: 'error', text: 'error "Out of stock"' },
    ])
    expect(applicabilityText(view)).toBe(
      'Applies to shop · android · page /cart · flow checkout · element button "Buy" #2 · selector #buy > button · error "Out of stock"',
    )
    const noOrdinal = applicabilityView(applicability('shop', 'shop', [anchor({ name: 'Buy', role: 'button', t: 'el' })]))
    expect(noOrdinal.phrases).toEqual([{ type: 'el', text: 'element button "Buy"' }])
  })

  it('APPLICABILITY-PRODUCT-SCOPE: product and scope print once when equal, both when they differ; no anchors is the lead alone', () => {
    expect(applicabilityView).toBeTypeOf('function')
    expect(applicabilityView(applicability('shop', 'checkout', []))).toEqual({ lead: 'Applies to shop · checkout', phrases: [] })
    expect(applicabilityText(applicabilityView(applicability('shop', 'checkout', [])))).toBe('Applies to shop · checkout')
    expect(applicabilityText(applicabilityView(applicability('shop', 'shop', [])))).toBe('Applies to shop')
  })

  it('ANCHOR-UNPARSED-VERBATIM: not JSON, or JSON of no anchor shape, is kept verbatim after the parsed phrases', () => {
    expect(parseAnchor).toBeTypeOf('function')
    expect(parseAnchor('{"platform":"web","t":"platform"}')).toEqual({ t: 'platform', platform: 'web' })
    expect(parseAnchor('page:/cart')).toEqual({ t: 'unparsed', raw: 'page:/cart' })
    expect(parseAnchor('{"t":"page"}')).toEqual({ t: 'unparsed', raw: '{"t":"page"}' })
    expect(parseAnchor('{"platform":"desktop","t":"platform"}')).toEqual({ t: 'unparsed', raw: '{"platform":"desktop","t":"platform"}' })

    const view = applicabilityView(applicability('shop', 'shop', ['page:/cart', '{"t":"page"}', '{"route":"/cart","t":"page"}']))
    expect(view.phrases).toEqual([
      { type: 'page', text: 'page /cart' },
      { type: 'unparsed', text: 'page:/cart' },
      { type: 'unparsed', text: '{"t":"page"}' },
    ])
  })
})

function served(id: string, summary: string, status: string, servedAsCanary: boolean, join: Join = {}) {
  return { ...line(id, summary, join), status, servedAsCanary }
}

function now(summary: string, currentStatus: string) {
  return { ...content(summary), currentStatus }
}

describe('a record on trial says so, and a record that changed since says how', () => {
  it('ON-TRIAL-TAG: a record served once on trial is onTrial; one never served on trial carries no flag', () => {
    const views = usedRecordViews(projection([
      servedStep(0, { channel1: [served('rec_t', 'on trial once', 'candidate', false), served('rec_n', 'never on trial', 'active', false)] }),
      servedStep(1, { channel1: [served('rec_t', 'on trial once', 'candidate', true)] }),
    ]))
    expect(views.map(view => view.onTrial)).toEqual([true, undefined])
    expect('onTrial' in views[1]!).toBe(false)
  })

  it('SINCE-TAG-RULE: a tag only when a serve-time status exists and the current status differs from it', () => {
    expect(sinceStatusFor).toBeTypeOf('function')
    expect(sinceStatusFor('candidate', 'superseded')).toBe('superseded')
    expect(sinceStatusFor('candidate', 'active')).toBe('active')
    expect(sinceStatusFor('active', 'active')).toBeUndefined()
    expect(sinceStatusFor(undefined, 'active')).toBeUndefined()
    expect(sinceStatusFor('hunch', 'active')).toBeUndefined()
    expect(sinceStatusFor('candidate', undefined)).toBeUndefined()

    const views = usedRecordViews(projection([
      servedStep(0, {
        channel1: [
          served('rec_s', 'superseded since', 'candidate', true, { recordContent: now('superseded since', 'superseded') }),
          served('rec_p', 'proven since', 'candidate', false, { recordContent: now('proven since', 'active') }),
          served('rec_same', 'unchanged', 'active', false, { recordContent: now('unchanged', 'active') }),
          served('rec_odd', 'odd served status', 'hunch', false, { recordContent: now('odd served status', 'active') }),
        ],
        channel2: [opened('rec_o', { recordContent: now('opened only', 'deprecated') })],
      }),
    ]))
    expect(views.map(view => view.sinceStatus)).toEqual(['superseded', 'active', undefined, undefined, undefined])
    expect(SINCE_STATUS_TAGS[views[0]!.sinceStatus!]).toBe('since superseded')
    expect(SINCE_STATUS_TAGS[views[1]!.sinceStatus!]).toBe('since proven')
  })
})

describe('the track record is counted by code (memory.md §7.5)', () => {
  it('TRUST-COUNTS-LINE: once for 1, {n} times otherwise, zero included', () => {
    expect(trustCountsLine).toBeTypeOf('function')
    expect(trustCountsLine(1, 0)).toBe('Confirmed once · contradicted 0 times')
    expect(trustCountsLine(3, 1)).toBe('Confirmed 3 times · contradicted once')
    expect(trustCountsLine(0, 0)).toBe('Confirmed 0 times · contradicted 0 times')
  })
})
