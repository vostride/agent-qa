/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CurationSnapshotSchema,
  RunKnowledgeProjectionSchema,
  type RunKnowledgeProjection,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  CURATION_SNAPSHOT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordingFixture, type RecordingFixture } from './recording-dom-fixture.js'
import { populatedRunSpawnEnv, POPULATED_SECRET_ENV_VAR } from './populated-run-fixture.js'
import { cleanupTempRoots, reserveEphemeralPort, spawnDashboard, trackTempRoot } from './spawned-chat.js'

// The run, its detail read, the page and every pixel are the shipped runner's and the built
// dashboard's. ONE read is substituted: `/api/runs/{id}/knowledge` answers a rich projection built
// here, parsed through RunKnowledgeProjectionSchema and addressed to the run's real steps, because a
// fixture run cannot reach every outcome the layout must hold. The real read path is proven by
// knowledge-tab-dom's (a8), (a9) and (b7). Captures go only where AGENT_QA_427_CAPTURE_DIR points.
const DESKTOP = { width: 1280, height: 800 }
const NARROW = { width: 400, height: 800 }
const DESKTOP_LABEL = '1280x800'
const NARROW_LABEL = '400x800'
const ZOOM_LABEL = 'zoom2-from-1280x800'
const DEFAULT_SECTIONS = ['used', 'effect', 'changes'] as const
const MACHINERY = ['canary', 'leg ', 'rank ', 'score ', 'attribution'] as const
const TRACE_LINE = /leg (anchor|lexical|dense) · rank \d+ · score \d+\.\d{3}/
// A ledger step row must keep a readable part of its title beside its badges (the 400px capture
// once showed the title squeezed to nothing).
const LEDGER_TITLE_MIN_PX = 48

// Content-derived id shapes, so a leaked id reads like a real one would.
const ID = {
  contradicted: 'fact-el-button-acknowledge-0f9a1c2b3d4e5f60',
  harmful: 'fact-el-textbox-credential-1a2b3c4d5e6f7081',
  confirmed: 'fact-page-local-probe-heading-2b3c4d5e6f708192',
  helpful: 'fact-flow-acknowledge-round-3c4d5e6f708192a3',
  quietA: 'fact-el-status-notice-4d5e6f708192a3b4',
  quietB: 'fact-el-link-help-5e6f708192a3b4c5',
  selector: 'fact-el-button-dismiss-selector-6f708192a3b4c5d6',
  opened: 'fact-flow-credential-entry-708192a3b4c5d6e7',
  openedGone: 'fact-page-local-probe-retired-8192a3b4c5d6e7f8',
  caution: 'caution-el-button-acknowledge-twice-92a3b4c5d6e7f809',
  replayed: 'procedure-flow-acknowledge-a3b4c5d6e7f8091a',
  stopped: 'procedure-flow-credential-b4c5d6e7f8091a2b',
  hinted: 'procedure-flow-help-c5d6e7f8091a2b3c',
  cut: 'fact-el-link-footer-d6e7f8091a2b3c4d',
  added: 'fact-el-textbox-credential-mask-e7f8091a2b3c4d5e',
  confirmedChange: 'fact-el-heading-probe-f8091a2b3c4d5e6f',
  victim: 'fact-el-button-acknowledge-old-091a2b3c4d5e6f70',
  replacement: 'fact-el-button-acknowledge-new-1a2b3c4d5e6f7082',
  deprecated: 'fact-page-local-probe-banner-2b3c4d5e6f708193',
  proposed: 'policy-flow-credential-review-3c4d5e6f708192a4',
} as const
const RECORD_IDS = Object.values(ID)
const DIGESTS = ['sha256:9e1f2a3b4c5d6e7f8091a2b3c4d5e6f7', 'sha256:0a1b2c3d4e5f60718293a4b5c6d7e8f9']
const LONG_SELECTOR = 'button[data-testid="notice-banner-dismiss-control-primary-action-with-an-unbroken-selector-literal"]'
  + ' inside main > section.notice-region:nth-of-type(2) > div.actions'

type RealStep = { testId: string; testIndex: number; stepIndex: number; stepText: string }
type World = 'settled' | 'scan-incomplete' | 'pending'

function content(summary: string, kind: 'fact' | 'caution' = 'fact', narrative?: string) {
  return {
    content: `${summary}.\nSeen on the local probe page after the notice rendered.\nRe-read on every round of the recipe.`,
    summary,
    kind,
    applicability: { product: 'local-probe', scope: 'local-probe', anchors: ['page:/', `el:button:${LONG_SELECTOR}`], openedAtOrdinal: 3 },
    currentStatus: 'active' as const,
    currentTrust: {
      confirmations: 2, contradictions: 1, evidenceTokens: ['receipt-11'], lastEventOrdinal: 30,
      ...(narrative === undefined ? {} : { trustNarrative: narrative }),
    },
  }
}

function recorded(runId: string, recordId: string, change: string, atOrdinal: number, extra: Record<string, unknown> = {}) {
  return { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId, change, atOrdinal, sourceRunId: runId, evidenceToken: `receipt-${String(atOrdinal)}`, ...extra }
}

const SUMMARIES: Record<string, string> = {
  [ID.contradicted]: 'The Acknowledge button dismisses the notice banner',
  [ID.harmful]: 'The Credential field accepts a pasted value',
  [ID.confirmed]: 'The probe page shows an Evidence layout probe heading',
  [ID.helpful]: 'Each round ends once the notice closes',
  [ID.quietA]: 'The notice status line reads Dismissed after a click',
  [ID.quietB]: 'The help link opens in the same tab',
  [ID.selector]: `Dismiss is ${LONG_SELECTOR}`,
  [ID.opened]: 'Entering the credential happens before any click',
  [ID.caution]: 'Pressing Acknowledge twice reopens the notice',
  [ID.added]: 'The Credential field masks its value',
  [ID.confirmedChange]: 'The probe heading stays visible after dismissal',
  [ID.victim]: 'The notice button reads Acknowledge',
  [ID.replacement]: 'The notice button reads Acknowledge and close',
  [ID.deprecated]: 'The banner hides itself after five seconds',
  [ID.proposed]: 'Credential entry needs a review before it is trusted',
}

function line(id: string, canary: boolean) {
  return { id, kind: 'fact', summary: SUMMARIES[id]!, trust: canary ? 0.41 : 0.87, status: canary ? 'candidate' : 'active',
    servedAsCanary: canary, tier: canary ? 'candidate' : 'confirmed', recordContent: content(SUMMARIES[id]!) }
}

/** One rich projection over the run's real steps; the three worlds differ only in how curation settled. */
function buildProjection(runId: string, steps: RealStep[], world: World): Extract<RunKnowledgeProjection, { kind: 'ready' }> {
  const member0 = steps.filter(step => step.testIndex === 0).sort((a, b) => a.stepIndex - b.stepIndex)
  const others = steps.filter(step => step.testIndex !== 0)
  if (member0.length < 6) throw new Error(`the capture world needs six member-0 steps, the run recorded ${String(member0.length)}`)
  const rung = { schemaVersion: 2 as const, rung: 'bundle-scan' as const, reason: 'index-locked' as const }
  const served: Record<number, { c1: ReturnType<typeof line>[]; c2: unknown[]; c3: unknown[]; plan?: unknown; cut?: boolean }> = {
    0: { c1: [line(ID.contradicted, true), line(ID.selector, false)],
      c2: [{ id: ID.opened, detailLevel: 'full', bodyDigest: DIGESTS[0], recordContent: content(SUMMARIES[ID.opened]!, 'fact',
        'Confirmed twice on the local probe and contradicted once when the notice rendered late; trust recovered after the next confirmation.') }],
      c3: [], cut: true,
      plan: { kind: 'procedure-replay', procedureId: ID.replayed, guard: { checksPassed: 1, total: 1 }, flow: { cursor: 0, length: 2 } } },
    1: { c1: [line(ID.harmful, true), line(ID.confirmed, true)], c2: [],
      c3: [{ id: ID.caution, summary: SUMMARIES[ID.caution]!, recordContent: content(SUMMARIES[ID.caution]!, 'caution') }],
      plan: { kind: 'procedure-replay', procedureId: ID.replayed, guard: { checksPassed: 1, total: 1 }, flow: { cursor: 1, length: 2 } } },
    2: { c1: [line(ID.helpful, true), line(ID.contradicted, true)], c2: [], c3: [], plan: { kind: 'procedure-hint', procedureId: ID.hinted } },
    3: { c1: [line(ID.quietA, true), line(ID.quietB, true)], c2: [], c3: [] },
    4: { c1: [line(ID.selector, false)], c2: [{ id: ID.openedGone, detailLevel: 'summary', bodyDigest: DIGESTS[1], contentAbsence: { reason: 'not-found' } }], c3: [] },
    5: { c1: [], c2: [], c3: [],
      plan: { kind: 'procedure-replay', procedureId: ID.stopped,
        guard: { checksPassed: 0, total: 1, miss: { procedureStepIndex: 0, reason: 'descriptor-missing' } }, flow: { cursor: 0, length: 3 } } },
  }
  const projectionSteps = [...member0, ...others].map(step => {
    const slot = step.testIndex === 0 ? served[step.stepIndex] : others[0] === step ? { c1: [line(ID.confirmed, true)], c2: [], c3: [] } : undefined
    const c1 = slot?.c1 ?? []
    return {
      testId: step.testId, testIndex: step.testIndex, stepIndex: step.stepIndex, stepText: step.stepText,
      served: { channel1: c1, channel2: slot?.c2 ?? [], channel3: slot?.c3 ?? [] },
      trace: { kind: 'answered', trace: { schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
        servedLines: c1.map((entry, index) => ({ recordId: entry.id, leg: (['anchor', 'lexical', 'dense'] as const)[index % 3], rank: index + 1, score: 1.48695 - index * 0.4 })),
        truncated: slot?.cut === true ? [{ recordId: ID.cut, leg: 'dense', rank: 21, score: 0.11 }] : [] } },
      ...(slot?.plan === undefined ? {} : { planSource: slot.plan }),
      retrievalRung: rung,
    }
  })
  const attributions = world === 'pending' ? [] : [
    { at: member0[0]!, recordId: ID.contradicted, outcome: 'contradicted' },
    { at: member0[2]!, recordId: ID.contradicted, outcome: 'contradicted' },
    { at: member0[1]!, recordId: ID.harmful, outcome: 'harmful' },
    { at: member0[1]!, recordId: ID.confirmed, outcome: 'confirmed' },
    ...(others[0] === undefined ? [] : [{ at: others[0], recordId: ID.confirmed, outcome: 'confirmed' }]),
    { at: member0[2]!, recordId: ID.helpful, outcome: 'helpful' },
  ].map(({ at, recordId, outcome }) => ({ testIndex: at.testIndex, stepIndex: at.stepIndex, recordId,
    observationId: `canary-outcome:${recordId.slice(-8)}-${String(at.testIndex)}-${String(at.stepIndex)}`, outcome }))

  const snapshot = CurationSnapshotSchema.parse({
    schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION,
    rows: [
      { recordId: ID.added, bucket: 'added', changes: [{ bucket: 'added', change: recorded(runId, ID.added, 'added', 20) }] },
      { recordId: ID.confirmedChange, bucket: 'confirmed', changes: [{ bucket: 'confirmed', change: recorded(runId, ID.confirmedChange, 'confirmed', 21) }] },
      { recordId: ID.victim, bucket: 'superseded', byRecordId: ID.replacement, changes: [
        { bucket: 'superseded', change: recorded(runId, ID.victim, 'superseded', 22, { byRecordId: ID.replacement }) },
        { bucket: 'added', change: recorded(runId, ID.replacement, 'added', 22) },
      ] },
      { recordId: ID.deprecated, bucket: 'deprecated', changes: [{ bucket: 'deprecated', change: recorded(runId, ID.deprecated, 'deprecated', 23) }] },
      { recordId: ID.proposed, bucket: 'proposed', changes: [{ bucket: 'proposed', change: recorded(runId, ID.proposed, 'added', 24) }] },
    ],
    breakdown: { added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1 },
  })
  const joined = (change: { recordId: string }) => ({ ...change, recordContent: content(SUMMARIES[change.recordId] ?? 'A recorded change') })
  const later = joined(recorded(runId, ID.added, 'promoted', 91))
  const learned = world === 'pending'
    ? { changes: [], canaryAttributions: [] }
    : {
        changes: [...snapshot.rows.flatMap(row => row.changes.map(entry => joined(entry.change))), later],
        canaryAttributions: attributions,
        curationSnapshot: snapshot,
        sinceThen: { changes: [later], count: 1 },
        ...(world === 'scan-incomplete' ? { scanIncomplete: true } : {}),
      }
  const parsed = RunKnowledgeProjectionSchema.parse({
    kind: 'ready', runId, buildOrdinal: 7, knowledgeStore: 'bound', retrievalRung: rung,
    steps: projectionSteps,
    curation: world === 'pending' ? { status: 'pending' } : { status: 'complete', counts: { curated: 4, deprecated: 1 } },
    learned,
  })
  if (parsed.kind !== 'ready') throw new Error('the capture projection must be ready')
  return parsed
}

type Scroll = { scrollWidth: number; clientWidth: number }
type Geometry = {
  label: string
  state: 'collapsed' | 'open'
  innerWidth: number
  dpr: number
  document: Scroll
  owner: Scroll & { left: number; right: number; overflowX: string }
  root: Scroll
  horizontal: string[]
  vertical: string[]
  escaping: string[]
  sections: string[]
  ledgerTitles: number[]
  details: string | null
}
type Machinery = {
  state: 'collapsed' | 'open'
  sections: Record<string, { text: string; html: string }>
  details: string
  detailsState: string | null
}
type Zoom = { factor: number; beforeWidth: number; afterWidth: number; beforeDpr: number; afterDpr: number }
type Remount = { opened: string | null; afterSwitch: string | null; detailsRowsAfterSwitch: number }

const failures: Record<string, string> = {}
let fixture: RecordingFixture | undefined
let reader: Awaited<ReturnType<typeof spawnDashboard>> | undefined
let zoomContext: BrowserContext | undefined
let zoom: Zoom | undefined
let remount: Remount | undefined
let realRead: { status: number; kind?: string } | undefined
let realSteps: RealStep[] = []
const geometries: Geometry[] = []
const machinery: Machinery[] = []
const worlds = new Map<World, Extract<RunKnowledgeProjection, { kind: 'ready' }>>()
let serving: World = 'settled'

type EffectRead = { world: World; filter: string; entries: Array<{ outcome: string; glyph: string; sentence: string }>; uncounted: number }
type Ax = { role: string; name: string; description: string }
type Focused = { id: number; tag: string; label: string | null; inKnowledge: boolean; visible: string; meaning: string; ax: Ax; tooltip: string | null; scrollTop: number }
type Inventory = { stepRefs: number[]; onTrial: number[]; buckets: number[]; uncounted: number[]; recordIdCopies: number[]; proposals: number[] }
type TooltipEscape = { trigger: string; shown: string | null; afterEscape: number }
type Walk = { focused: Focused[]; inventory: Inventory; labels: Record<number, string | null>; visible: Record<number, string>; meaning: Record<number, string>; escapes: TooltipEscape[] }
const effects: EffectRead[] = []
let walk: Walk | undefined

async function captureElement(page: Page, selector: string, name: string) {
  const directory = process.env.AGENT_QA_427_CAPTURE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  await page.locator(selector).first().screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

async function readEffect(page: Page, world: World) {
  const read = await page.evaluate(() => {
    const section = document.querySelector('[data-knowledge-section="effect"]')!
    return {
      filter: getComputedStyle(section).filter,
      entries: [...section.querySelectorAll('[data-effect-entry]')].map(entry => ({
        outcome: entry.getAttribute('data-effect-outcome') ?? '',
        glyph: [...(entry.querySelector('svg')?.classList ?? [])].find(name => name.startsWith('lucide-') && name !== 'lucide-icon') ?? '',
        sentence: (entry.querySelector('[data-effect-sentence]')?.textContent ?? '').trim(),
      })),
      uncounted: Number(section.querySelector('[data-effect-uncounted]')?.getAttribute('data-effect-uncounted') ?? 0),
    }
  })
  effects.push({ world, ...read })
}

/** E5 populated: the Effect section with colour stripped, in the two worlds that together hold all eight outcomes. */
async function driveGrayscale(context: BrowserContext, url: string) {
  for (const [world, name] of [['scan-incomplete', 'knowledge-effect-grayscale'], ['pending', 'knowledge-effect-grayscale-pending']] as const) {
    serving = world
    const page = await context.newPage()
    await openKnowledge(page, url)
    await page.addStyleTag({ content: '[data-knowledge-section="effect"] { filter: grayscale(1) }' })
    await page.locator('[data-knowledge-section="effect"]').scrollIntoViewIfNeeded()
    await frames(page)
    await captureElement(page, '[data-knowledge-section="effect"]', name)
    await readEffect(page, world)
    await page.close()
  }
  serving = 'settled'
}

/** Chromium's computed role, name and description for whatever holds focus, through CDP. */
async function focusedAx(cdp: CDPSession): Promise<Ax> {
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.activeElement', objectGroup: 'walk' })
  try {
    if (result.objectId === undefined) return { role: '', name: '', description: '' }
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId })
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false })
    const ax = nodes.find(entry => entry.backendDOMNodeId === node.backendNodeId)
    const text = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
    return { role: text(ax?.role?.value), name: text(ax?.name?.value), description: text(ax?.description?.value) }
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'walk' })
  }
}

/** Tab through the whole Knowledge pane with Retrieval details open, then prove Escape closes a tooltip. */
async function driveKeyboard(context: BrowserContext, url: string): Promise<Walk> {
  const page = await context.newPage()
  await openKnowledge(page, url)
  await openDetails(page)
  await scrollPane(page, 'top')
  const cdp = await context.newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('Accessibility.enable')
  const inventory = await page.evaluate(() => {
    const ids = new WeakMap<Element, number>()
    let next = 0
    const idOf = (element: Element) => { if (!ids.has(element)) ids.set(element, next++); return ids.get(element)! }
    const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
    const meaningOf = (element: Element) => normalize((element.getAttribute('aria-describedby') ?? '').split(/\s+/)
      .filter(id => id.length > 0).map(id => document.getElementById(id)?.textContent ?? '').join(' '))
    const helpers = window as unknown as { walkIdOf: (element: Element) => number; walkNormalize: typeof normalize; walkMeaningOf: typeof meaningOf }
    helpers.walkIdOf = idOf
    helpers.walkNormalize = normalize
    helpers.walkMeaningOf = meaningOf
    const root = document.querySelector('[data-knowledge-state="ready"]')!
    const all = (selector: string) => [...root.querySelectorAll(selector)]
    const groups = {
      stepRefs: all('[data-step-ref]'), onTrial: all('[data-used-record][data-on-trial] [data-slot="tooltip-trigger"]'),
      buckets: all('[data-bucket-label]'), uncounted: all('[data-effect-uncounted] [data-slot="tooltip-trigger"]'),
      recordIdCopies: all('[data-record-id-copy]'), proposals: all('[data-pending-proposals] button'),
    }
    const labels: Record<number, string | null> = {}
    const visible: Record<number, string> = {}
    const meaning: Record<number, string> = {}
    const inventory = Object.fromEntries(Object.entries(groups).map(([key, elements]) => [key, elements.map(element => {
      const id = idOf(element)
      labels[id] = element.getAttribute('aria-label')
      visible[id] = normalize(element.textContent)
      meaning[id] = meaningOf(element)
      return id
    })]))
    return { inventory, labels, visible, meaning }
  })
  await page.getByRole('tab', { name: 'Knowledge' }).focus()
  const focused: Focused[] = []
  let entered = false
  for (let press = 0; press < 600; press++) {
    await page.keyboard.press('Tab')
    await frames(page)
    const now = await page.evaluate(() => {
      const element = document.activeElement
      if (!element || element === document.body) return undefined
      const helpers = window as unknown as { walkIdOf: (element: Element) => number; walkNormalize: (text: string | null) => string; walkMeaningOf: (element: Element) => string }
      return {
        id: helpers.walkIdOf(element), tag: element.tagName.toLowerCase(), label: element.getAttribute('aria-label'),
        inKnowledge: element.closest('[data-knowledge-state]') !== null,
        visible: helpers.walkNormalize(element.textContent), meaning: helpers.walkMeaningOf(element),
        // A closing tooltip lingers through its exit animation, so only open ones are read.
        tooltip: [...document.querySelectorAll('[data-slot="tooltip-content"]:not([data-state="closed"])')].map(node => node.textContent ?? '').join(' ') || null,
        scrollTop: element.closest('[data-slot="scroll-area"]')?.scrollTop ?? -1,
      }
    })
    if (now === undefined) break
    if (focused.some(entry => entry.id === now.id)) break
    if (entered && !now.inKnowledge) break
    entered ||= now.inKnowledge
    focused.push({ ...now, ax: await focusedAx(cdp) })
  }

  const escapes: TooltipEscape[] = []
  for (const [trigger, selector] of [
    ['on trial', '[data-used-record][data-on-trial] [data-slot="tooltip-trigger"]'],
    ['bucket label', '[data-bucket-label]'],
    ['uncounted line', '[data-effect-uncounted] [data-slot="tooltip-trigger"]'],
  ] as const) {
    const target = page.locator(selector).first()
    await target.scrollIntoViewIfNeeded()
    // Let the scroll event land before focusing, or Radix reads it as a reason to close.
    await frames(page)
    await frames(page)
    await target.focus()
    const tooltip = page.locator('[data-slot="tooltip-content"]')
    const shown = await tooltip.first().waitFor({ timeout: 5_000 }).then(async () => await tooltip.first().textContent(), () => null)
    await page.keyboard.press('Escape')
    await tooltip.first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined)
    escapes.push({ trigger, shown, afterEscape: await tooltip.count() })
  }
  await cdp.detach()
  await page.close()
  return { focused, ...inventory, inventory: inventory.inventory as Inventory, escapes }
}

async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function captureTo(page: Page, name: string, zoomed = false) {
  const directory = process.env.AGENT_QA_427_CAPTURE_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  // Under browser zoom a clip is in surface pixels, so the viewport is scaled by devicePixelRatio.
  const clip = zoomed
    ? await page.evaluate(() => ({ x: 0, y: 0, width: innerWidth * devicePixelRatio, height: innerHeight * devicePixelRatio }))
    : undefined
  await page.screenshot({ path: join(directory, `${name}.png`), ...(clip ? { clip } : {}), animations: 'disabled' })
}

async function routeKnowledge(context: BrowserContext, runId: string) {
  await context.route(`**/api/runs/${encodeURIComponent(runId)}/knowledge`, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(worlds.get(serving)) })
  })
}

async function openKnowledge(page: Page, url: string) {
  await page.goto(url)
  await page.locator('[data-verdict-badge]').waitFor({ timeout: 30_000 })
  await page.keyboard.press('7')
  await page.locator('[role="tabpanel"][data-state="active"] [data-knowledge-state="ready"]').waitFor({ timeout: 15_000 })
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await frames(page)
}

const DETAILS = '[data-knowledge-section="retrieval-details"]'

async function detailsState(page: Page) {
  return await page.locator(`${DETAILS} [data-slot="collapsible"]`).first().getAttribute('data-state')
}

/** Activate the Retrieval details trigger, then every disclosure inside it, until none is closed. */
async function openDetails(page: Page) {
  await page.locator(`${DETAILS} [data-slot="collapsible-trigger"]`).first().click()
  await page.locator(`${DETAILS} [data-slot="collapsible"][data-state="open"]`).first().waitFor({ timeout: 5_000 })
  for (let pass = 0; pass < 10; pass++) {
    const opened = await page.evaluate(selector => {
      const closed = [...document.querySelectorAll<HTMLElement>(`${selector} [data-slot="collapsible-trigger"][data-state="closed"]`)]
      for (const trigger of closed) trigger.click()
      return closed.length
    }, DETAILS)
    await frames(page)
    if (opened === 0) return
  }
  throw new Error('Retrieval details kept a disclosure closed')
}

async function scrollPane(page: Page, to: 'top' | 'details') {
  await page.evaluate(({ to, selector }) => {
    const owner = document.querySelector('[data-knowledge-state]')!.closest('[data-slot="scroll-area"]')!
    if (to === 'top') owner.scrollTop = 0
    else document.querySelector(`${selector} [data-slot="collapsible-trigger"]`)!.scrollIntoView({ block: 'start' })
  }, { to, selector: DETAILS })
  await frames(page)
}

async function measure(page: Page, label: string, state: 'collapsed' | 'open') {
  await frames(page)
  const measured = await page.evaluate(selector => {
    const named = (element: Element) => {
      const data = [...element.attributes].find(attribute => attribute.name.startsWith('data-'))
      return `${element.tagName.toLowerCase()}${data ? `[${data.name}=${data.value}]` : ''}[${(element.textContent ?? '').trim().slice(0, 32)}]`
    }
    const root = document.querySelector<HTMLElement>('[data-knowledge-state]')!
    const panel = root.closest('[role="tabpanel"]')!
    // The shipped ScrollArea is a plain overflow-auto div: its root is the pane's one scroll owner.
    const owner = root.closest<HTMLElement>('[data-slot="scroll-area"]')!
    const all = [panel, ...panel.querySelectorAll('*')]
    const style = (element: Element) => getComputedStyle(element)
    const box = owner.getBoundingClientRect()
    return {
      innerWidth, dpr: devicePixelRatio,
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      owner: { scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth, left: box.left, right: box.right, overflowX: style(owner).overflowX },
      root: { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth },
      horizontal: all.filter(element => ['auto', 'scroll'].includes(style(element).overflowX) && element.scrollWidth > element.clientWidth + 1).map(named),
      vertical: all.filter(element => ['auto', 'scroll'].includes(style(element).overflowY) && element.scrollHeight > element.clientHeight + 1)
        .map(element => element === owner ? 'owner' : named(element)),
      escaping: [...root.querySelectorAll('*')]
        .filter(element => element.closest('.sr-only') === null)
        .filter(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.right > box.right + 1 || r.left < box.left - 1) })
        .slice(0, 12).map(named),
      sections: [...root.querySelectorAll('[data-knowledge-section]')].map(element => element.getAttribute('data-knowledge-section') ?? ''),
      ledgerTitles: [...root.querySelectorAll(`${selector} li[data-step-index] > button > span.truncate`)]
        .map(element => Math.round(element.getBoundingClientRect().width * 10) / 10),
      details: document.querySelector(`${selector} [data-slot="collapsible"]`)?.getAttribute('data-state') ?? null,
    }
  }, DETAILS)
  geometries.push({ label, state, ...measured })
}

async function readMachinery(page: Page, state: 'collapsed' | 'open') {
  const read = await page.evaluate(({ names, selector }) => {
    const root = document.querySelector('[data-knowledge-state="ready"]')!
    const sections = Object.fromEntries(names.map(name => {
      const section = root.querySelector(`[data-knowledge-section="${name}"]`)
      return [name, { text: section?.textContent ?? '', html: section?.outerHTML ?? '' }]
    }))
    return { sections, details: root.querySelector(selector)?.textContent ?? '',
      detailsState: root.querySelector(`${selector} [data-slot="collapsible"]`)?.getAttribute('data-state') ?? null }
  }, { names: [...DEFAULT_SECTIONS], selector: DETAILS })
  machinery.push({ state, ...read })
}

/** The whole collapsed pane in one picture: the viewport made as tall as the pane's content. */
async function captureFullPane(page: Page, name: string) {
  if (!process.env.AGENT_QA_427_CAPTURE_DIR) return
  const size = page.viewportSize()!
  const extra = await page.evaluate(() => {
    const owner = document.querySelector('[data-knowledge-state]')!.closest('[data-slot="scroll-area"]')!
    return owner.scrollHeight - owner.clientHeight
  })
  await page.setViewportSize({ width: size.width, height: size.height + extra })
  await frames(page)
  await captureTo(page, name)
  await page.setViewportSize(size)
  await frames(page)
}

/** Collapsed, then open, at one geometry: measured and captured in both states. */
async function driveGeometry(page: Page, label: string, capture: string, zoomed = false) {
  await scrollPane(page, 'top')
  await measure(page, label, 'collapsed')
  await captureTo(page, `${capture}-collapsed`, zoomed)
  if (!zoomed) await captureFullPane(page, `${capture}-full-collapsed`)
  if (label === DESKTOP_LABEL) await readMachinery(page, 'collapsed')
  await openDetails(page)
  await scrollPane(page, 'details')
  await measure(page, label, 'open')
  await captureTo(page, `${capture}-open`, zoomed)
  if (label === DESKTOP_LABEL) await readMachinery(page, 'open')
}

async function driveZoom(url: string, runId: string) {
  // Real browser zoom: an isolated MV3 extension calls Chrome's own `tabs.setZoom` and `getZoom`.
  // https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
  const zoomRoot = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-427-zoom-')))
  const extension = join(zoomRoot, 'extension')
  mkdirSync(extension)
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'Local knowledge zoom probe', version: '1.0',
    host_permissions: ['http://127.0.0.1/*'], background: { service_worker: 'background.js' } }))
  writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
  zoomContext = await chromium.launchPersistentContext(join(zoomRoot, 'profile'), {
    channel: 'chromium', headless: true, viewport: DESKTOP,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  await routeKnowledge(zoomContext, runId)
  const worker = zoomContext.serviceWorkers()[0] ?? await zoomContext.waitForEvent('serviceworker')
  const page = await zoomContext.newPage()
  await openKnowledge(page, url)
  const before = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
  // The page rewrites its own URL, so the tab is found by origin.
  const factor = await worker.evaluate(async origin => {
    const tabs = (globalThis as unknown as { chrome: { tabs: {
      query(query: object): Promise<Array<{ id?: number; url?: string }>>
      setZoom(id: number, factor: number): Promise<void>
      getZoom(id: number): Promise<number>
    } } }).chrome.tabs
    const [tab, ...others] = (await tabs.query({})).filter(candidate => candidate.url?.startsWith(`${origin}/runs/`))
    if (tab?.id === undefined || others.length > 0) throw new Error(`The isolated extension found ${String(others.length + (tab ? 1 : 0))} fixture tabs`)
    await tabs.setZoom(tab.id, 2)
    return await tabs.getZoom(tab.id)
  }, new URL(url).origin)
  await page.waitForFunction(dpr => devicePixelRatio >= dpr * 1.99, before.dpr)
  const after = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }))
  zoom = { factor, beforeWidth: before.width, afterWidth: after.width, beforeDpr: before.dpr, afterDpr: after.dpr }
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await driveGeometry(page, ZOOM_LABEL, 'knowledge-browser-200-percent', true)
  await zoomContext.close()
  zoomContext = undefined
}

describe('the Knowledge tab on the shipped bundle at three geometries', () => {
  beforeAll(async () => {
    try {
      // The layout recipe: a two-member suite whose member 0 records six steps.
      fixture = await recordingFixture('knowledge-layout', false, true)
      const runId = fixture.drive.runId
      const origin = fixture.dashboard.origin
      const real = await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/knowledge`)
      realRead = { status: real.status, kind: (await real.json() as { kind?: string }).kind }
      const detail = await (await fetch(`${origin}/api/runs/${encodeURIComponent(runId)}/detail`)).json() as {
        members?: Array<{ testIndex: number; testId?: string }>
        steps?: Array<{ testIndex: number; stepIndex: number; stepText?: string }>
      }
      realSteps = (detail.steps ?? []).map(step => ({
        testId: detail.members?.find(member => member.testIndex === step.testIndex)?.testId ?? `member-${String(step.testIndex)}`,
        testIndex: step.testIndex, stepIndex: step.stepIndex, stepText: step.stepText ?? '',
      }))
      for (const world of ['settled', 'scan-incomplete', 'pending'] as const) worlds.set(world, buildProjection(runId, realSteps, world))
      await fixture.dashboard.stop()
      const env = populatedRunSpawnEnv()
      // A cold reader without the planted credential environment: the fixture's synthetic values
      // stay masked, so the captures carry nothing this repository did not invent.
      delete env[POPULATED_SECRET_ENV_VAR]
      reader = await spawnDashboard(fixture.project.root, fixture.project.configPath, await reserveEphemeralPort(), 60_000, env)
      if (!reader.ready) throw new Error(reader.stderr())
      const url = `${reader.origin}/runs/${encodeURIComponent(runId)}`

      const context = await fixture.browser.newContext({ viewport: DESKTOP })
      await routeKnowledge(context, runId)
      const page = await context.newPage()
      await openKnowledge(page, url)
      await readEffect(page, 'settled')
      const opened = await detailsState(page)
      await driveGeometry(page, DESKTOP_LABEL, 'knowledge-1280')
      // A tab switch unmounts the pane, so Retrieval details must come back closed.
      await page.keyboard.press('1')
      await page.locator('[data-knowledge-state]').waitFor({ state: 'detached', timeout: 5_000 })
      await page.keyboard.press('7')
      await page.locator('[data-knowledge-state="ready"]').waitFor({ timeout: 10_000 })
      await frames(page)
      remount = { opened, afterSwitch: await detailsState(page),
        detailsRowsAfterSwitch: await page.locator(`${DETAILS} [data-step-index]`).count() }
      await page.close()

      const narrow = await context.newPage()
      await narrow.setViewportSize(NARROW)
      await openKnowledge(narrow, url)
      await driveGeometry(narrow, NARROW_LABEL, 'knowledge-400')
      await narrow.close()
      try { await driveGrayscale(context, url) } catch (error) { failures.grayscale = String(error) }
      try { walk = await driveKeyboard(context, url) } catch (error) { failures.keyboard = String(error) }
      await context.close()

      await driveZoom(url, runId)
    } catch (error) { failures.drive = String(error) }
    const observation = { realRead, realSteps, zoom, remount, geometries, failures, effects, walk,
      machinery: machinery.map(({ sections, ...rest }) => ({ ...rest, sections: Object.fromEntries(Object.entries(sections).map(([name, { text }]) => [name, text])) })) }
    if (process.env.AGENT_QA_427_CAPTURE_DIR) {
      mkdirSync(process.env.AGENT_QA_427_CAPTURE_DIR, { recursive: true })
      writeFileSync(join(process.env.AGENT_QA_427_CAPTURE_DIR, 'knowledge-observation.json'),
        JSON.stringify({ ...observation, projection: worlds.get('settled') }, null, 2))
    }
  }, 480_000)

  afterAll(async () => { await zoomContext?.close(); await reader?.stop(); await fixture?.close(); cleanupTempRoots() })

  function expectNoSidewaysScroll(label: string) {
    const measured = geometries.filter(geometry => geometry.label === label)
    expect(measured.map(geometry => geometry.state), JSON.stringify(failures)).toEqual(['collapsed', 'open'])
    for (const geometry of measured) {
      const where = `${label} ${geometry.state} innerWidth=${geometry.innerWidth} dpr=${geometry.dpr}`
      expect(geometry.details, where).toBe(geometry.state === 'collapsed' ? 'closed' : 'open')
      expect(geometry.sections, where).toEqual([...DEFAULT_SECTIONS, 'retrieval-details'])
      expect(geometry.document.scrollWidth, `${where}: document ${JSON.stringify(geometry.document)}`).toBeLessThanOrEqual(geometry.document.clientWidth + 1)
      expect(geometry.owner.scrollWidth, `${where}: tab scroll owner ${JSON.stringify(geometry.owner)}`).toBeLessThanOrEqual(geometry.owner.clientWidth + 1)
      expect(geometry.root.scrollWidth, `${where}: tab body ${JSON.stringify(geometry.root)}`).toBeLessThanOrEqual(geometry.root.clientWidth + 1)
      expect(geometry.horizontal, `${where}: horizontal scrollers in the pane`).toEqual([])
      expect(geometry.escaping, `${where}: elements past the scroll owner's edges`).toEqual([])
      if (geometry.state === 'open') {
        expect(geometry.ledgerTitles.length, `${where}: ledger step rows`).toBeGreaterThan(0)
        for (const width of geometry.ledgerTitles) expect(width, `${where}: a ledger step title is ${String(width)}px wide`).toBeGreaterThanOrEqual(LEDGER_TITLE_MIN_PX)
      }
      // One scroll owner: the shipped ScrollArea, or nothing when the pane fits.
      expect(geometry.vertical.filter(owner => owner !== 'owner'), `${where}: vertical scrollers`).toEqual([])
    }
  }

  it('LAYOUT-KNOWLEDGE-1280', () => {
    expectNoSidewaysScroll(DESKTOP_LABEL)
    for (const geometry of geometries.filter(entry => entry.label === DESKTOP_LABEL)) {
      expect(geometry.innerWidth, `${geometry.label} ${geometry.state}`).toBe(1280)
    }
  })

  it('LAYOUT-KNOWLEDGE-400', () => {
    expectNoSidewaysScroll(NARROW_LABEL)
    for (const geometry of geometries.filter(entry => entry.label === NARROW_LABEL)) {
      expect(geometry.innerWidth, `${geometry.label} ${geometry.state}`).toBe(400)
    }
  })

  it('LAYOUT-KNOWLEDGE-ZOOM2', () => {
    expect(zoom?.factor, JSON.stringify(failures)).toBe(2)
    expect(zoom!.afterWidth, JSON.stringify(zoom)).toBe(zoom!.beforeWidth / 2)
    expect(zoom!.afterDpr, JSON.stringify(zoom)).toBe(zoom!.beforeDpr * 2)
    expectNoSidewaysScroll(ZOOM_LABEL)
  })

  it('DETAILS-HOLDS-MACHINERY', () => {
    expect(machinery.map(read => read.state), JSON.stringify(failures)).toEqual(['collapsed', 'open'])
    for (const read of machinery) {
      for (const name of DEFAULT_SECTIONS) {
        const { text, html } = read.sections[name]!
        expect(text.length, `${read.state} ${name}: empty section`).toBeGreaterThan(0)
        for (const word of MACHINERY) expect(text.toLowerCase().includes(word), `${read.state} ${name} says ${JSON.stringify(word)}: ${text}`).toBe(false)
        for (const id of [...RECORD_IDS, ...DIGESTS]) expect(html.includes(id), `${read.state} ${name} carries ${id}`).toBe(false)
      }
    }
    const [collapsed, open] = machinery
    expect(collapsed!.detailsState).toBe('closed')
    expect(open!.detailsState).toBe('open')
    expect(open!.details, 'no trace line in the opened Retrieval details').toMatch(TRACE_LINE)
    expect(open!.details).toContain('on trial (canary)')
    for (const id of [...RECORD_IDS, ...DIGESTS]) expect(open!.details.includes(id), `Retrieval details is missing ${id}`).toBe(true)
    expect(remount, JSON.stringify(failures)).toEqual({ opened: 'closed', afterSwitch: 'closed', detailsRowsAfterSwitch: 0 })
    expect(realRead?.status, 'the real knowledge door answered the run before the substitution').toBe(200)
  })

  it('EFFECT-GRAYSCALE', () => {
    expect(effects.map(read => read.world), JSON.stringify(failures)).toEqual(['settled', 'scan-incomplete', 'pending'])
    const [settled, partial, pending] = effects
    // No single run can show all eight: pending needs curation unsettled, the four attributed
    // outcomes need it settled, and unknown needs the store read incomplete (canaryOutcomeWord).
    expect(settled!.entries.map(entry => entry.outcome).sort()).toEqual(['confirmed', 'contradicted', 'harmful', 'helpful', 'replay-complete', 'replay-stopped'])
    expect(settled!.uncounted).toBe(2)
    expect(partial!.filter).toBe('grayscale(1)')
    expect(pending!.filter).toBe('grayscale(1)')
    // Two unmeasured trials become two unknown entries (one per record), so the partial world paints eight entries over seven outcomes.
    expect([...new Set(partial!.entries.map(entry => entry.outcome))].sort()).toEqual(['confirmed', 'contradicted', 'harmful', 'helpful', 'replay-complete', 'replay-stopped', 'unknown'])
    expect(partial!.entries).toHaveLength(8)
    expect([...new Set(pending!.entries.map(entry => entry.outcome))].sort()).toEqual(['pending', 'replay-complete', 'replay-stopped'])
    for (const read of [partial!, pending!]) {
      const outcomes = new Set(read.entries.map(entry => entry.outcome))
      expect(new Set(read.entries.map(entry => entry.glyph)).size, `${read.world}: ${JSON.stringify(read.entries)}`).toBe(outcomes.size)
    }
    const byOutcome = new Map([...partial!.entries, ...pending!.entries].map(entry => [entry.outcome, entry]))
    expect(byOutcome.size).toBe(8)
    const glyphs = [...byOutcome.values()].map(entry => entry.glyph)
    expect(glyphs.every(glyph => glyph.startsWith('lucide-')), JSON.stringify(glyphs)).toBe(true)
    expect(new Set(glyphs).size, JSON.stringify(glyphs)).toBe(8)
    expect(new Set([...byOutcome.values()].map(entry => entry.sentence)).size).toBe(8)
    for (const entry of [...partial!.entries, ...pending!.entries]) expect(byOutcome.get(entry.outcome)!.glyph).toBe(entry.glyph)
  })

  it('EFFECT-REPLAY-SENTENCES', () => {
    expect(effects.map(read => read.world), JSON.stringify(failures)).toEqual(['settled', 'scan-incomplete', 'pending'])
    for (const read of effects) {
      const where = `${read.world}: ${JSON.stringify(read.entries)}`
      expect(read.entries.filter(entry => entry.outcome === 'replay-complete'), where).toHaveLength(1)
      expect(read.entries.filter(entry => entry.outcome === 'replay-stopped'), where).toHaveLength(1)
    }
    const settled = effects[0]!
    const complete = settled.entries.find(entry => entry.outcome === 'replay-complete')!.sentence
    expect(complete.startsWith('Replayed all 2 of its steps in '), complete).toBe(true)
    expect(complete.endsWith('steps 1 and 2'), complete).toBe(true)
    const stopped = settled.entries.find(entry => entry.outcome === 'replay-stopped')!.sentence
    expect(stopped.startsWith('Replay stopped at its step 1 of 3 in '), stopped).toBe(true)
    expect(stopped.endsWith("step 6: the element wasn't found"), stopped).toBe(true)
    for (const { sentence } of effects.flatMap(read => read.entries)) {
      expect(sentence.includes('all 1 of'), sentence).toBe(false)
      for (const [, k, n] of sentence.matchAll(/step (\d+) of (\d+)/g)) expect(Number(k), sentence).toBeLessThanOrEqual(Number(n))
      for (const [, k, n] of sentence.matchAll(/Replayed (\d+) of its (\d+) steps/g)) expect(Number(k), sentence).toBeLessThanOrEqual(Number(n))
    }
  })

  it('KNOWLEDGE-ACCESSIBLE-TREE', () => {
    expect(walk, JSON.stringify(failures)).toBeDefined()
    const { focused, inventory, labels, visible, meaning, escapes } = walk!
    const reached = new Set(focused.map(entry => entry.id))
    const where = (group: string) => `${group}: ${JSON.stringify(focused.map(entry => `${entry.tag}:${entry.label ?? ''}`))}`
    for (const [group, ids] of Object.entries(inventory)) {
      // The `proposals` group is absent; that is asserted below.
      if (group === 'proposals') continue
      expect(ids.length, `no ${group} on the page`).toBeGreaterThan(0)
      for (const id of ids) expect(reached.has(id), where(`${group} ${String(id)} never took focus`)).toBe(true)
    }
    const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
    const occurrences = (text: string, part: string) => part.length === 0 ? 0 : text.split(part).length - 1
    // Every Tab stop in the pane is a control Chromium can name (WCAG 4.1.2).
    for (const [index, entry] of focused.entries()) {
      if (!entry.inKnowledge) continue
      const control = `Tab stop ${String(index)} <${entry.tag}> named ${JSON.stringify(entry.ax.name)} (role ${JSON.stringify(entry.ax.role)})`
      expect(['generic', 'none', 'presentation', ''].includes(entry.ax.role), `${control}: no usable role`).toBe(false)
      expect(normalize(entry.ax.name).length, `${control}: empty accessible name`).toBeGreaterThan(0)
      const name = normalize(entry.ax.name).toLowerCase()
      const description = normalize(entry.ax.description).toLowerCase()
      // A meaning may use its trigger's words ("on trial"), so only a description that repeats the name, or sits inside it, is a second announcement.
      if (description.length > 0) {
        expect(name.includes(description) || description === name, `${control}: announces ${JSON.stringify(description)} twice`).toBe(false)
      }
    }
    const byId = new Map(focused.map(entry => [entry.id, entry]))
    const triggerIds = [...inventory.onTrial, ...inventory.buckets, ...inventory.uncounted]
    expect({ onTrial: inventory.onTrial.length, buckets: inventory.buckets.length, uncounted: inventory.uncounted.length }).toEqual({ onTrial: 6, buckets: 6, uncounted: 1 })
    for (const id of triggerIds) {
      const entry = byId.get(id)!
      const control = `tooltip trigger ${String(id)} <${entry.tag}> named ${JSON.stringify(entry.ax.name)}`
      const name = normalize(entry.ax.name)
      const description = normalize(entry.ax.description)
      expect(entry.ax.role, control).toBe('button')
      expect(name.toLowerCase(), control).toBe(visible[id]!.toLowerCase())
      expect(meaning[id]!.length, `${control}: no described-by meaning`).toBeGreaterThan(0)
      expect(description, control).toBe(meaning[id])
      expect(name.includes(description), `${control}: its meaning is inside its name`).toBe(false)
      expect(occurrences(`${name} ${description}`, meaning[id]!), `${control}: meaning announced other than once`).toBe(1)
    }
    for (const id of inventory.stepRefs) expect(labels[id], 'a step reference\'s accessible name').toMatch(/^Go to /)
    // The tab shows what changed; no pending-proposals line or review copy control appears.
    expect(inventory.proposals).toEqual([])
    expect(Object.values(labels).filter(label => label?.startsWith('Copy review command'))).toEqual([])
    for (const id of inventory.recordIdCopies) expect(labels[id]).toMatch(/^Copy record id /)
    // Tab shows a trigger's tooltip unless the focus had to scroll the pane: Radix closes a tooltip
    // when an ancestor scrolls, and the browser's focus scroll lands a frame after the open. The
    // trigger's own description is what is announced either way; the closed ones are counted, not hidden.
    const triggers = focused.filter(item => triggerIds.includes(item.id))
    for (const entry of triggers) if (entry.tooltip !== null) expect(entry.tooltip).toContain(meaning[entry.id])
    expect(triggers.filter(entry => entry.tooltip !== null).length, 'no trigger showed its tooltip on Tab').toBeGreaterThan(0)
    expect(escapes.map(entry => entry.trigger)).toEqual(['on trial', 'bucket label', 'uncounted line'])
    for (const entry of escapes) {
      expect(entry.shown?.length ?? 0, `${entry.trigger}: focus showed no tooltip`).toBeGreaterThan(0)
      expect(entry.afterEscape, `${entry.trigger}: Escape left the tooltip open`).toBe(0)
    }
  })
})
