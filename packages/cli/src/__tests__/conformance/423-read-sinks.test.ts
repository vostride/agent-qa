/// <reference lib="dom" />
// Real durable rows, registry dispatch and HTTP adapter. No sanitizer mock.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFunctionRegistry, type FunctionDeps } from '@vostride/agent-qa-agent'
import {
  createEvidenceBlobReader,
  type LocalAgentHost,
} from '@vostride/agent-qa-agent-local'
import {
  DashboardDatabase,
  createDashboardRunDetailReader,
  createRunServiceRoutes,
  type RunServicePorts,
  serveRunDetailRead,
  startServer,
} from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  MARK_RECEIPT_SCHEMA_VERSION,
  MarkReceiptSchema,
  type CompletedRunHandoff,
  type MarkReceipt,
  type RunDetailProjection,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'

import { composeDashboardAgentHost } from '../../commands/dashboard.js'
import { PACKAGES_ROOT } from './spawned-chat.js'

const AUTH_TOKEN = 'synthetic-423-cookie-token'
const AUTH_STATE = JSON.stringify({
  cookies: [{ name: 'session', value: AUTH_TOKEN, domain: 'app.test', path: '/' }],
  origins: [],
})
const ALLOWED = 'Restored "display" label'

async function startFixture(
  display?: { name: string; attributes: Record<string, string> },
  extraDeps?: (runId: string) => Partial<FunctionDeps>,
) {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-423-sinks-'))
  const db = new DashboardDatabase({ dbPath: join(root, 'dashboard.db') })
  const runId = generateRunId()
  // 2026-10-14 (441-16, D-06): records hold the declared marker the run wrote; reads mask with the same store.
  const redactor = new SecretRedactor(new SecretStore({ AUTH_STATE, ALLOWED }))
  const mask = (text: string) => redactor.redactString(text)
  const authPlaceholder = mask(AUTH_STATE)
  const allowedPlaceholder = mask(ALLOWED)
  const evidenceDocument = {
    schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION as typeof RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
    kind: 'console' as const, records: [
    { level: 'log', text: allowedPlaceholder, timestamp: 1 },
    { level: 'log', text: authPlaceholder, timestamp: 2 },
  ] }
  const evidenceRef = new FsEvidenceArtifactStore({ root, runId }).persistEvidenceDocument(evidenceDocument)
  db.insertRun({
    id: runId, name: display?.name ?? 'Read sink fixture', status: 'failed', duration: 1,
    ...(display === undefined ? {} : { attributes: display.attributes }),
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString(),
  })
  db.upsertRunMember({ runId, testIndex: 0, name: 'Synthetic member', totalSteps: 2, outcome: 'failed' })
  db.insertRunStep({
    runId, testIndex: 0, stepIndex: 0, stepText: allowedPlaceholder,
    cacheStatus: 'miss', verifierVerdict: null, selfHealOccurred: false,
    briefDigest: '', status: 'failed', error: authPlaceholder,
    evidence: {
      console: { kind: 'console', state: 'present', ref: evidenceRef as never, counts: { total: 2, errors: 0, warnings: 0 } },
      network: { kind: 'network', state: 'absent', reason: 'empty' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'not-captured' },
    },
  })
  db.insertRunStep({
    runId, testIndex: 0, stepIndex: 1,
    stepText: 'Normal text [secret] <EMAIL_123> <SECRET_987>',
    cacheStatus: 'miss', verifierVerdict: null, selfHealOccurred: false, briefDigest: '',
  })
  const registry = createFunctionRegistry({
    deps: {
      runDetail: createDashboardRunDetailReader(db), evidenceBlobs: createEvidenceBlobReader({ agentQaRoot: root }),
      secretMask: mask,
      ...extraDeps?.(runId),
    } as FunctionDeps,
    // 2026-10-02 (432-36, D-12): no `resolveExecutionContext` registry option; the registry reads
    // no context (432-20).
  })
  const agentHost = composeDashboardAgentHost({ registry } as LocalAgentHost)
  const started = await startServer({
    declaredSecretMask: (text) => text,
    db, port: 0, agentHost,
    ...(display === undefined ? {} : { uiDir: join(PACKAGES_ROOT, 'dashboard-ui', 'dist') }),
  })
  const address = started.server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind')
  const origin = `http://127.0.0.1:${address.port}`
  // The same production adapter's default machine boundary, on a real socket.
  const machine = createServer((req, res) => serveRunDetailRead(req, res, { runId, host: agentHost }))
  await new Promise<void>((resolve) => machine.listen(0, '127.0.0.1', resolve))
  const machineAddress = machine.address()
  if (machineAddress === null || typeof machineAddress === 'string') throw new Error('Machine fixture did not bind')
  const remote = createServer(createRunServiceRoutes({ agentHost } as unknown as RunServicePorts))
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const remoteAddress = remote.address()
  if (remoteAddress === null || typeof remoteAddress === 'string') throw new Error('Remote fixture did not bind')
  return {
    root, db, runId, origin, authPlaceholder, allowedPlaceholder, evidenceRef, evidenceDocument,
    machineUrl: `http://127.0.0.1:${machineAddress.port}`,
    remoteUrl: `http://127.0.0.1:${remoteAddress.port}/run/${runId}/evidence?kind=console&testIndex=0&stepIndex=0`,
    async close() {
      await started.close()
      await new Promise<void>((resolve, reject) => machine.close((error) => error ? reject(error) : resolve()))
      await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()))
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('423 guarded human read', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>
  beforeAll(async () => { fixture = await startFixture() })
  afterAll(async () => { await fixture?.close() })

  it('HTTP-EVIDENCE-HUMAN serves evidence as stored, and raw SHA bytes stay as stored (441 D-07)', async () => {
    const url = `${fixture.origin}/api/runs/${fixture.runId}`
    const response = await fetch(`${url}/evidence?kind=console&testIndex=0&stepIndex=0`)
    expect(response.status).toBe(200)
    const raw = await response.text()
    const body = JSON.parse(raw)
    expect(body).toMatchObject({ outcome: 'ready', document: { records: [
      { text: fixture.allowedPlaceholder }, { text: fixture.authPlaceholder },
    ] } })
    expect(raw).not.toContain(AUTH_TOKEN)
    const artifact = await fetch(`${url}/artifacts/${fixture.evidenceRef.sha}`)
    expect(await artifact.text()).toBe(JSON.stringify(fixture.evidenceDocument))
    expect(artifact.headers.get('etag')).toBe(`"${fixture.evidenceRef.sha}"`)
  })

  it('HTTP-EVIDENCE-MACHINE real authenticated router retains placeholders and durable masked bytes', async () => {
    // 432-21 (D-12/D-13): the machine door is tokenless; what it refuses is a cross-site read.
    expect((await fetch(fixture.remoteUrl, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    const response = await fetch(fixture.remoteUrl)
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(raw).toContain(fixture.authPlaceholder)
    expect(raw).toContain(fixture.allowedPlaceholder)
    expect(raw).not.toContain(AUTH_TOKEN)
    expect(raw).not.toContain(ALLOWED)
    expect(JSON.stringify(fixture.db.readRunDetailRows(fixture.runId))).not.toContain(AUTH_TOKEN)
  })

  it('C423-HUMAN-DETAIL-SANITIZED: T-405-38 the human door answers durable rows as stored (441 D-07)', async () => {
    const response = await fetch(`${fixture.origin}/api/runs/${fixture.runId}/detail`)
    expect(response.status).toBe(200)
    const raw = await response.text()
    const body = JSON.parse(raw) as RunDetailProjection
    expect.soft(body.steps[0]?.error).toBe(fixture.authPlaceholder)
    expect.soft(body.steps[0]?.stepText).toBe(fixture.allowedPlaceholder)
    expect.soft(body.steps[1]?.stepText).toBe('Normal text [secret] <EMAIL_123> <SECRET_987>')
    expect.soft(raw).not.toContain(AUTH_TOKEN)
    expect.soft(raw).not.toContain(ALLOWED)
    expect.soft(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('C423-HUMAN-DETAIL-SANITIZED: cross-site reads are refused before dispatch', async () => {
    const response = await fetch(`${fixture.origin}/api/runs/${fixture.runId}/detail`, {
      headers: { Origin: 'https://other.test', 'Sec-Fetch-Site': 'cross-site' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'cross_site_refused' })
  })

  it('C423-HUMAN-DETAIL-SANITIZED: machine HTTP output and durable rows remain masked', async () => {
    const response = await fetch(fixture.machineUrl)
    expect(response.status).toBe(200)
    const raw = await response.text()
    expect(raw).toContain(fixture.authPlaceholder)
    expect(raw).toContain(fixture.allowedPlaceholder)
    expect(raw).not.toContain(AUTH_TOKEN)
    expect(raw).not.toContain(ALLOWED)
    const stored = JSON.stringify(fixture.db.readRunDetailRows(fixture.runId))
    expect(stored).toContain(fixture.authPlaceholder)
    expect(stored).not.toContain(AUTH_TOKEN)
  })

  it('C423-HUMAN-DETAIL-SANITIZED: empty evidence answers empty, and an old run\'s placeholders are served as the text they are', async () => {
    const runId = fixture.db.insertRun({
      name: 'Historical run', status: 'passed', duration: 0,
      startedAt: new Date(0).toISOString(), endedAt: new Date(0).toISOString(),
    })
    const url = `${fixture.origin}/api/runs/${runId}/detail`
    const empty = await fetch(url)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ members: [], steps: [], subActions: [] })
    fixture.db.insertRunStep({
      runId, testIndex: 0, stepIndex: 0, stepText: '<SECRET_0> <EMAIL_0> [secret]',
      cacheStatus: 'miss', verifierVerdict: null, selfHealOccurred: false, briefDigest: '',
    })
    const historical = await fetch(url)
    const body = await historical.json() as RunDetailProjection
    expect(body.steps[0]?.stepText).toBe('<SECRET_0> <EMAIL_0> [secret]')
    expect(JSON.stringify(body)).not.toContain(AUTH_TOKEN)
  })
})

// 2026-10-14 (441-37, D-28, D-20): the drawer shows and copies stored text as written.
const KEY = 'key [secret:API_KEY] <EMAIL_81>'
const VALUE = 'normal [secret:PASSWORD] <SECRET_82> [secret]'
const NESTED = JSON.stringify({ [KEY]: [VALUE, { note: '[secret:API_KEY]' }] })
const STORED_NAME = 'Name [secret:API_KEY] <SECRET_99>'

describe('423 rendered run-detail sinks', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    fixture = await startFixture({
      name: STORED_NAME,
      attributes: { [KEY]: VALUE, nested: NESTED, normal: 'Readable normal value', auth: AUTH_STATE },
    })
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    // Observe what the actual button writes without depending on desktop clipboard permissions.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text } },
      })
    })
    await page.goto(`${fixture.origin}/runs/${fixture.runId}`)
    await page.waitForSelector('[data-step-id]')
    await page.keyboard.press('i')
    await page.getByRole('button', { name: 'Copy JSON', exact: true }).waitFor()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    await fixture?.close()
  })

  it('SINK-CLIPBOARD: values and nested JSON keys are copied as stored', async () => {
    await page.getByRole('button', { name: 'Copy JSON', exact: true }).click()
    const copied = await page.evaluate(() => (window as unknown as { copied: string }).copied)
    expect.soft(JSON.parse(copied)).toEqual({
      [KEY]: VALUE, nested: NESTED,
      normal: 'Readable normal value', auth: AUTH_STATE,
    })
    expect.soft(copied).not.toMatch(/␟masked:/u)
    const rows = page.getByRole('dialog').locator('tr')
    const normal = rows.filter({ hasText: 'Readable normal value' })
    await normal.getByRole('button').click()
    expect.soft(await page.evaluate(() => (window as unknown as { copied: string }).copied))
      .toBe('Readable normal value')
    const nested = rows.filter({ has: page.locator('th', { hasText: /^nested$/ }) })
    await nested.getByRole('button').click()
    expect.soft(await page.evaluate(() => (window as unknown as { copied: string }).copied))
      .toBe(NESTED)
  })

  it('SINK-TITLE: document title is the stored run name as written', async () => {
    expect(await page.title()).toBe(`Run - ${STORED_NAME} | agent-qa`)
    expect(await page.title()).not.toContain(AUTH_TOKEN)
  })

  it('SINK-DOM: drawer values, keys and accessible attributes show stored text, and a stored auth-state value shows as written', async () => {
    const dialog = page.getByRole('dialog')
    const text = await dialog.innerText()
    expect.soft(text).toContain('Readable normal value')
    expect.soft(text).toContain(KEY)
    expect.soft(text).toContain(VALUE)
    expect.soft(text).toContain(AUTH_STATE)
    expect.soft(text).not.toMatch(/␟masked:/u)
    expect.soft(await dialog.locator('[data-masked]').count()).toBe(0)
    const attrs = await dialog.evaluate((element) => Array.from(element.querySelectorAll('*'))
      .flatMap((node) => Array.from(node.attributes).map((attribute) => attribute.value)).join('\n'))
    expect.soft(attrs).not.toContain(AUTH_TOKEN)
    expect.soft(await dialog.getByRole('button', { name: `Copy ${KEY} value`, exact: true }).count()).toBe(1)
  })
})

// 423 D-19 · SC5: run detail's review controls re-homed off `routes.chat`. The three places that
// used to navigate to Chat (member mark, step mark, Knowledge proposals CTA) are driven on the
// built bundle over real registry reads, by keyboard. Since 426 D-22 the two mark pointers live in
// the composer history, opened from the header entry and the step trigger; since 432-09 (D-25) all
// three show what changed and offer no review command. Scoped to the routed page's own `<main>` (inside the sidebar
// inset): the global sidebar's
// Chat entry is 430's removal, not this plan's.
// 2026-09-30, 432-09 (D-25): each mark applied a knowledge fix, and history joins the changed record.
const MEMBER_RECORD = 'mem_member-423-24'
const STEP_RECORD = 'mem_step-423-24'

function appliedReceipt(runId: string, ordinal: number, recordId: string, stepIndex?: number): MarkReceipt {
  return MarkReceiptSchema.parse({
    schemaVersion: MARK_RECEIPT_SCHEMA_VERSION, markId: `mark_${String(ordinal).padStart(12, '0')}`, runId, testIndex: 0,
    ...(stepIndex === undefined ? {} : { stepIndex }), runSlug: 'read-sink-review', kind: 'false-fail',
    origin: 'user', ordinal, markedAt: ordinal,
    disposition: { kind: 'applied', fix: 'fact', change: { kind: 'knowledge', changeId: 'prop_0123456789ab', recordIds: [recordId] } },
    evidence: { confirmed: 0, overturned: 0 },
  })
}
const changedRecord = (recordId: string) => [{ recordId, contentAbsence: { reason: 'not-bound' as const } }]

function reviewDeps(runId: string): Partial<FunctionDeps> {
  return {
    feedback: {
      marksFor: async () => [appliedReceipt(runId, 1, MEMBER_RECORD), appliedReceipt(runId, 2, STEP_RECORD, 0)],
      mark: async () => { throw new Error('read-only review fixture') },
    },
    // An applied receipt carries the records its fix changed (the MarkHistoryEntry join).
    feedbackReads: {
      history: async () => ({ kind: 'history', entries: [
        { receipt: appliedReceipt(runId, 1, MEMBER_RECORD), changedRecords: changedRecord(MEMBER_RECORD) },
        { receipt: appliedReceipt(runId, 2, STEP_RECORD, 0), changedRecords: changedRecord(STEP_RECORD) },
      ] }),
    },
    runs: {
      get: async (id: unknown) => String(id) === runId
        ? { schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION, runId, buildOrdinal: 1, tests: [] } as unknown as CompletedRunHandoff
        : undefined,
    },
    knowledge: { diffSince: async () => [] },
    // 432-09: a bound inbox with a pending proposal must not surface anywhere on the page.
    // 2026-10-02 (432-42, D-05/D-22): the deleted inbox dep is no longer smuggled in; nothing reads it.
  } as unknown as Partial<FunctionDeps>
}

async function tabTo(page: Page, selector: string): Promise<void> {
  for (let index = 0; index < 400; index++) {
    if (await page.locator(selector).evaluate(element => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Keyboard could not reach ${selector}`)
}

async function regionTargets(page: Page): Promise<string[]> {
  return page.locator('main main').evaluate(region => [...region.querySelectorAll('[href],[action],[formaction],[data-href]')]
    .map(element => element.getAttribute('href') ?? element.getAttribute('action')
      ?? element.getAttribute('formaction') ?? element.getAttribute('data-href') ?? ''))
}

describe('423 run-detail review pointers', () => {
  let fixture: Awaited<ReturnType<typeof startFixture>>
  let browser: Browser
  let page: Page
  const navigations: string[] = []

  beforeAll(async () => {
    fixture = await startFixture({ name: 'Review pointer fixture', attributes: {} }, reviewDeps)
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (text: string) => { (window as unknown as { copied: string }).copied = text } },
      })
    })
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()) })
    await page.goto(`${fixture.origin}/runs/${fixture.runId}`)
    await page.waitForSelector('[data-feedback-entry="test"]', { timeout: 15_000 })
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
    await fixture?.close()
  })

  // RE-SPELLED 432-09 (D-25) from 'NO-CHAT-TARGET: no run-detail target is routes.chat, and all three
  // controls copy a runnable review command by keyboard': the three places that offered a review
  // command now show what changed and offer none, reached the same way by keyboard.
  it('NO-CHAT-TARGET: no run-detail target is routes.chat, and the three former review places show applied changes with no review command', async () => {
    const chatPath = '/chat'
    const pathOf = (target: string) => new URL(target, fixture.origin).pathname
    const detailPath = pathOf(page.url())
    const navigatedBefore = navigations.length
    expect((await regionTargets(page)).map(pathOf)).not.toContain(chatPath)

    // The two mark histories, opened from the header entry and the step trigger (426 D-22).
    const opens = [
      { selector: '[data-feedback-entry="test"]', address: '0:run', record: MEMBER_RECORD },
      { selector: '[data-step-id="0:0"] [data-feedback-entry="step"]', address: '0:0', record: STEP_RECORD },
    ]
    for (const open of opens) {
      await tabTo(page, open.selector)
      await page.keyboard.press('Enter')
      const applied = `[data-feedback-composer][data-feedback-target="${open.address}"] [data-feedback-history="target"] [data-history-applied="knowledge"]`
      await page.waitForSelector(applied)
      // RE-SPELLED 2026-10-03 (quick 261003-cpv, 432-UI-REVIEW fix 2): one line names the fix and
      // what it changed.
      expect(await page.locator(applied).textContent())
        .toBe(`Recorded — a knowledge fact was added: ${open.record} (content unavailable)`)
      expect(await page.locator('[data-history-review], [data-review-command]').count()).toBe(0)
      expect((await regionTargets(page)).map(pathOf)).not.toContain(chatPath)
    }

    // The composer stops key propagation by design, so the page shortcut is pressed from the tree.
    await page.locator('[role="treeitem"][aria-selected="true"] > button').focus()
    await page.keyboard.press('m')
    await page.waitForSelector('[data-learned-state]')
    expect(await page.locator('[data-pending-proposals], [data-review-proposals], [data-review-command]').count()).toBe(0)
    expect(await page.locator('main main').textContent()).not.toMatch(/agent-qa proposals|waiting for review/)
    expect(await page.evaluate(() => (window as unknown as { copied?: string }).copied)).toBeUndefined()
    expect((await regionTargets(page)).map(pathOf)).not.toContain(chatPath)

    // Viewer state (`?tab=knowledge` from the `m` shortcut) may change; the page never leaves run detail.
    expect(pathOf(page.url())).toBe(detailPath)
    expect(navigations.slice(navigatedBefore).map(pathOf).filter(path => path !== detailPath)).toEqual([])
    expect(navigations.map(pathOf)).not.toContain(chatPath)
  })
})
