// C439-SAVED-FILE (439 D-04, D-17, SC2): a later step checks the earlier step's download by exact
// name and content, in real headless Chromium through the real loop. The capture holds the bytes
// in memory, the loop hands the runner's comparator only this test's downloads, and the file's text
// reaches no prompt: the verifier states the expected name and text, the runner compares, and only
// the masked, windowed first difference is recorded. The file is served by a loopback server here.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { CarriedArtifacts, ConditionJudgment, PlannerConfig, StepContext } from '@vostride/agent-qa-runner'
import { FILE_DIFFERENCE_WINDOW } from '@vostride/agent-qa-runner'
import type { ConditionRecord } from '@vostride/agent-qa-schema'
import { WebPlatformAdapter } from '../adapter.js'
import { act, giveUp, refFor, runScriptedStep, scriptedPlanner, scriptedVerifier } from './fixtures/scripted-loop.js'
import type { ScriptedStepRun, ScriptedVerifier } from './fixtures/scripted-loop.js'

const LIMITS: PlannerConfig = { maxActions: 30, maxPlanningTurns: 30, previousStepCount: 0 }
const DOWNLOAD_STEP = 'Download the invoice'
const LINE_STEP = 'Verify the downloaded file is named invoice-1042.csv and contains the line ORD-1001,42.50'
const ROWS_STEP = 'Verify the downloaded file is named invoice-1042.csv and lists both orders on separate lines'
const INVOICE = 'order,total\nORD-1001,42.50\nORD-1002,17.00\n'
const MERGED = 'order,total\nORD-1001,42.50 ORD-1002,17.00\n'
const SECOND_ROW = 'ORD-1002,17.00'
const ONE_LINE: ConditionJudgment['file'] = { name: 'invoice-1042.csv', match: 'lines', text: 'ORD-1001,42.50' }
const TWO_LINES: ConditionJudgment['file'] = {
  name: 'invoice-1042.csv',
  match: 'lines',
  text: 'ORD-1001,42.50\nORD-1002,17.00',
}

interface FileServer {
  url: string
  close(): Promise<void>
}

async function fileServer(name: string, body: Buffer): Promise<FileServer> {
  const server = createServer((request, response) => {
    if (request.url === '/file') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      })
      response.end(body)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><html><body><main><h1>Billing</h1><a href="/file">Download invoice</a></main></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://localhost:${String(port)}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let adapter: WebPlatformAdapter | undefined
let site: FileServer | undefined

afterEach(async () => {
  await adapter?.cleanup()
  adapter = undefined
  await site?.close()
  site = undefined
}, 60_000)

async function open(name: string, body: Buffer): Promise<WebPlatformAdapter> {
  site = await fileServer(name, body)
  const created = new WebPlatformAdapter()
  try {
    await created.setup({ platform: 'web', browser: { name: 'chromium', headless: true } })
  } catch (error) {
    throw new Error('Real Chromium required: run `pnpm exec playwright install chromium`', { cause: error })
  }
  adapter = created
  await created.getPage()!.goto(site.url)
  return created
}

interface TwoSteps {
  first: ScriptedStepRun
  second: ScriptedStepRun
  verifier: ScriptedVerifier
  failureContexts: string[]
  condition: ConditionRecord
}

/** Step 1 downloads `name`; step 2 is verified met with a file condition expecting `file`. */
async function downloadThenVerify(
  name: string,
  body: Buffer,
  step: string,
  file: ConditionJudgment['file'],
): Promise<TwoSteps> {
  const web = await open(name, body)
  const carriedArtifacts: CarriedArtifacts = { downloads: [] }
  const first = await runScriptedStep({
    adapter: web,
    instruction: DOWNLOAD_STEP,
    planner: scriptedPlanner([
      (screen) => act({ type: 'click', ref: refFor(screen, 'link', 'Download invoice') }, true, 'Download the invoice'),
    ]),
    verifier: scriptedVerifier(() => ({
      pass: true,
      reason: 'The invoice was downloaded',
      citations: [{ source: 'action', quote: `Download "${name}"` }],
    })),
    plannerConfig: LIMITS,
    carriedArtifacts,
    stepNumber: 1,
  })
  const failureContexts: string[] = []
  const remember = (turn: (context: StepContext) => ReturnType<typeof giveUp>) =>
    (_screen: unknown, context: StepContext) => {
      if (context.failureContext !== undefined) failureContexts.push(context.failureContext)
      return turn(context)
    }
  const verifier = scriptedVerifier(() => ({
    pass: true,
    reason: 'The file is the one the step names',
    needs: 'file',
    file,
    citations: [{ source: 'carried', quote: `Download "${name}"` }],
  }))
  const second = await runScriptedStep({
    adapter: web,
    instruction: step,
    planner: scriptedPlanner([
      remember(() => act({ type: 'delay', ms: 0 }, true, 'The file was downloaded in step 1')),
      remember(() => giveUp('The downloaded file does not hold what the step asks for')),
    ]),
    verifier,
    plannerConfig: LIMITS,
    carriedArtifacts,
    stepNumber: 2,
  })
  const condition = second.result.evidence!.conditionVerdicts!.conditions[0]!
  return { first, second, verifier, failureContexts, condition }
}

function withoutDifference(value: unknown): string {
  return JSON.stringify(value, (key, inner: unknown) => (key === 'firstDifference' ? undefined : inner))
}

describe('C439-SAVED-FILE', () => {
  it("a later step finds the exact line in the earlier step's download", async () => {
    const run = await downloadThenVerify('invoice-1042.csv', Buffer.from(INVOICE), LINE_STEP, ONE_LINE)

    expect(run.first.result.status).toBe('passed')
    expect(run.second.result.status).toBe('passed')
    expect(run.verifier.calls).toBe(1)
    expect(run.condition).toMatchObject({ verdict: 'met', needs: 'file', file: { name: 'match', content: 'match' } })
    expect(run.condition.citations[0]).toMatchObject({ source: 'carried', found: true })
  }, 60_000)

  it('two rows merged into one line differ', async () => {
    const run = await downloadThenVerify('invoice-1042.csv', Buffer.from(MERGED), ROWS_STEP, TWO_LINES)

    expect(run.second.result.status).toBe('failed')
    expect(run.condition).toMatchObject({
      verdict: 'not-met',
      judged: 'met',
      guard: 'file',
      reason: 'file content differs at line 2',
      file: { name: 'match', content: 'differs' },
    })
    const difference = run.condition.file!.firstDifference!
    const sides = [...difference.matchAll(/«([^»]*)»/g)].map((match) => match[1]!)
    expect(sides).toHaveLength(2)
    for (const side of sides) expect(side.length).toBeLessThanOrEqual(FILE_DIFFERENCE_WINDOW)
    expect(difference).toBe('line 2: expected «ORD-1001,42.50» found «ORD-1001,42.50 ORD-1002,17.00»')
    expect(run.failureContexts.at(-1)).toContain('file content differs at line 2')
  }, 60_000)

  it('another name or extension differs', async () => {
    const run = await downloadThenVerify('invoice-1042.txt', Buffer.from(INVOICE), LINE_STEP, ONE_LINE)

    expect(run.first.result.status).toBe('passed')
    expect(run.second.result.status).toBe('failed')
    expect(run.condition).toMatchObject({
      verdict: 'not-met',
      guard: 'file',
      reason: 'no download named invoice-1042.csv; found invoice-1042.txt',
      file: { name: 'differs' },
    })
  }, 60_000)

  it('a file over the hold cap is unverified', async () => {
    const big = Buffer.concat([Buffer.from(INVOICE), Buffer.alloc(1024 * 1024 + 1 - Buffer.byteLength(INVOICE), 0x41)])
    expect(big.length).toBe(1024 * 1024 + 1)
    const run = await downloadThenVerify('invoice-1042.csv', big, LINE_STEP, ONE_LINE)

    expect(run.first.result.evidence!.subActions[0]!.operationEvidence?.downloads?.[0]).toMatchObject({
      state: 'completed',
      size: 1024 * 1024 + 1,
    })
    expect(run.second.result.status).toBe('failed')
    expect(run.condition).toMatchObject({
      verdict: 'unverified',
      guard: 'file',
      file: { name: 'match', content: 'unverified' },
    })
  }, 60_000)

  it('a file that is not UTF-8 text is unverified', async () => {
    const run = await downloadThenVerify('invoice-1042.csv', Buffer.from([0xff, 0xfe, 0xfd]), LINE_STEP, ONE_LINE)

    expect(run.second.result.status).toBe('failed')
    expect(run.condition).toMatchObject({
      verdict: 'unverified',
      guard: 'file',
      reason: 'the file is not UTF-8 text',
      file: { name: 'match', content: 'unverified' },
    })
  }, 60_000)

  it("the file's text reaches no prompt and only its bounded difference reaches the handoff", async () => {
    const run = await downloadThenVerify('invoice-1042.csv', Buffer.from(MERGED), ROWS_STEP, TWO_LINES)

    expect(run.second.result.status).toBe('failed')
    expect(run.verifier.inputs.length).toBeGreaterThan(0)
    for (const input of run.verifier.inputs) {
      expect(input.record, 'the verifier was handed the step record').toBeDefined()
      expect(JSON.stringify(input)).not.toContain(SECOND_ROW)
    }
    expect(run.failureContexts.length).toBeGreaterThan(0)
    for (const context of run.failureContexts) expect(context).not.toContain(SECOND_ROW)
    expect(run.second.result.error ?? '').not.toContain(SECOND_ROW)
    const evidence = run.second.result.evidence
    expect(JSON.stringify(evidence)).toContain(SECOND_ROW)
    expect(withoutDifference(evidence)).not.toContain(SECOND_ROW)
    expect(withoutDifference(run.first.result.evidence)).not.toContain(SECOND_ROW)
  }, 60_000)
})
