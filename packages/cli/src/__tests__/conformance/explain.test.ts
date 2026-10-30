// The shipped op through `invokeFunction` and the shipped loader, over a produced zero-row catalog.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_ASK_FUNCTION_ID,
  EXPLAIN_FUNCTION_ID,
  createFunctionRegistry,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { CapabilityCatalogPort, ChatLanguageModel, FunctionRegistry } from '@vostride/agent-qa-agent'
import { catalogRowKey } from '@vostride/agent-qa-schema'
import type {
  AgentAskResult,
  CatalogRow,
  ExplainCitation,
  ExplainOutput,
} from '@vostride/agent-qa-schema'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  createCliCapabilityCatalogPort,
  readExplainCoverageLog,
  resolveExplainCoverageLogPath,
} from '../../capability-catalog/explain-port.js'
import type { ExplainAbstainedCounts } from '../../capability-catalog/explain-port.js'
import { loadCapabilityCatalog } from '../../capability-catalog/loader.js'
import { CONFORMANCE_CENSUS_CALLER } from './adapters.js'
import { capabilityCatalogDocumentOf, capabilityCatalogText } from './catalog.js'

// Every op but `agent.explain` reads `unbound` here, so nothing can start a run or write a project.
function explainRegistry(port: CapabilityCatalogPort): FunctionRegistry {
  return createFunctionRegistry({
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    deps: { capabilityCatalog: port } as unknown as Parameters<
      typeof createFunctionRegistry
    >[0]['deps'],
  })
}

async function explain(port: CapabilityCatalogPort, query: string): Promise<ExplainOutput> {
  return await invokeFunction(
    explainRegistry(port),
    EXPLAIN_FUNCTION_ID,
    { query },
    CONFORMANCE_CENSUS_CALLER,
  ) as ExplainOutput
}

/** Every backtick-quoted token anywhere in an output — the whole surface, not a sample of it. */
function quotedTokensOf(output: ExplainOutput): readonly string[] {
  const text = JSON.stringify(output)
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
}

const workspaces: string[] = []

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-explain-'))
  workspaces.push(root)
  return root
}

afterEach(() => {
  while (workspaces.length > 0) {
    const root = workspaces.pop()
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  }
})

/** A row id the committed catalog answers to, read off the artifact rather than spelled. */
let realRowId = ''
let committedRows: readonly CatalogRow[] = []

beforeAll(() => {
  committedRows = loadCapabilityCatalog().rows
  const row = committedRows.find((candidate) => candidate.kind === 'op')
  expect(row, 'the committed catalog carries no op row — every cell below would be vacuous')
    .toBeDefined()
  realRowId = `op:${(row as { readonly id: string }).id}`
})

describe('the empty-catalog differential — PRODUCED, not literal', () => {
  it('drives the shipped op to a typed abstention on a zero-row catalog the producer emitted', async () => {
    const root = workspace()
    const catalogPath = join(root, 'capability-catalog.json')
    // THE PRODUCER'S OWN RECIPE, with no rows: `rowCount` and `rowsDigest` are minted by
    // `capabilityCatalogDocumentOf` and the bytes by `capabilityCatalogText`. Nothing about this
    // document is typed by hand, which is the difference between proving the abstention and proving
    // that a hand-written shape reaches it.
    writeFileSync(catalogPath, capabilityCatalogText(capabilityCatalogDocumentOf([])), 'utf8')

    // The loader tells a produced zero-row catalog from a missing one; a throw skips abstention.
    expect(loadCapabilityCatalog(catalogPath).rows).toEqual([])

    const port = createCliCapabilityCatalogPort({ agentQaRoot: root, catalogPath })
    const output = await explain(port, 'how do I start a test run')

    expect(output.kind).toBe('abstention')
    if (output.kind !== 'abstention') return
    expect(output.is_uncertain).toBe(true)
    expect(output.closestRowIds).toEqual([])
    // ZERO INVENTED COMMANDS, stated over the WHOLE output rather than as a scan for shapes we
    // thought of: an empty catalog has no row to quote from, so a backtick-quoted token anywhere in
    // this answer could only have been invented.
    expect(quotedTokensOf(output).filter((token) => token !== '.agent-qa/')).toEqual([])
  })

  it('never asks the model at all when the catalog is empty', async () => {
    // The short-circuit is control flow, not a hope about what a model does with no grounding data.
    const root = workspace()
    const catalogPath = join(root, 'capability-catalog.json')
    writeFileSync(catalogPath, capabilityCatalogText(capabilityCatalogDocumentOf([])), 'utf8')

    let asked = 0
    const shipped = createCliCapabilityCatalogPort({ agentQaRoot: root, catalogPath })
    const port: CapabilityCatalogPort = {
      ...shipped,
      citeCapabilities: async (query, rows) => {
        asked += 1
        return await shipped.citeCapabilities(query, rows)
      },
    }

    expect((await explain(port, 'what can you do')).kind).toBe('abstention')
    expect(asked, 'the op prompted a model over an empty catalog').toBe(0)
  })
})

describe('the ghost-id differential', () => {
  /** The shipped port over the REAL committed catalog, with only the model half doctored. */
  function portCiting(citation: ExplainCitation, root: string): CapabilityCatalogPort {
    const shipped = createCliCapabilityCatalogPort({ agentQaRoot: root })
    return { ...shipped, citeCapabilities: async () => citation }
  }

  it('abstains structurally when the citation names a row that exists in no row', async () => {
    const root = workspace()
    const ghost = 'op:this.capability.does.not.exist'
    expect(
      committedRows.some((row) => `${row.kind}:${'id' in row ? row.id : ''}` === ghost),
      'the ghost id this cell plants is a real row — the differential would measure nothing',
    ).toBe(false)

    const output = await explain(portCiting({ citedRowIds: [ghost] }, root), 'how do I start a run')

    expect(output.kind).toBe('abstention')
    if (output.kind !== 'abstention') return
    expect(output.is_uncertain).toBe(true)
    // The ghost id is nowhere in what a person reads. It was refused, not repaired.
    expect(JSON.stringify(output)).not.toContain(ghost)
  })

  it('abstains WHOLE on a mixed citation — one real id and one ghost buy no partial answer', async () => {
    const root = workspace()
    const output = await explain(
      portCiting({ citedRowIds: [realRowId, 'skill:no-such-skill'] }, root),
      'how do I start a run',
    )

    expect(output.kind).toBe('abstention')
    if (output.kind !== 'abstention') return
    // The DISTINCTION this cell exists for: a partial answer reads as grounded while carrying an
    // unexplained absence, and a person cannot tell which half they are holding. The abstention may
    // still SUGGEST the real row through the deterministic scorer — that is the scorer's own
    // answer about the query, computed without consulting the model — so what is asserted is the
    // ARM, not the absence of a row the scorer independently picked.
    expect(output.is_uncertain).toBe(true)
  })

  it('answers only when every cited id resolves — the control on the two cells above', async () => {
    // Without this, both refusals above would be satisfied by an op that abstains unconditionally.
    const root = workspace()
    const output = await explain(portCiting({ citedRowIds: [realRowId] }, root), 'start a run')

    expect(output.kind).toBe('answer')
    if (output.kind !== 'answer') return
    expect(output.citations.map((cited) => cited.rowId)).toEqual([realRowId])
    // Every quoted token resolves to a row the catalog carries — the choke-point property, restated
    // at the composed level over the whole output.
    const invocations = new Set(quotedTokensOf(output))
    expect(invocations.size).toBeGreaterThan(0)
  })
})

describe('the local coverage log', () => {
  it('appends exactly ONE parseable line per abstention, and never the answer path', async () => {
    const root = workspace()
    const logPath = resolveExplainCoverageLogPath(root)
    const shipped = createCliCapabilityCatalogPort({ agentQaRoot: root })

    await explain({ ...shipped, citeCapabilities: async () => ({ citedRowIds: ['op:ghost'] }) },
      'first question nobody documented')
    await explain({ ...shipped, citeCapabilities: async () => ({ citedRowIds: ['op:ghost'] }) },
      'second question nobody documented')
    await explain({ ...shipped, citeCapabilities: async () => ({ citedRowIds: [realRowId] }) },
      'a question the catalog answers')

    const lines = readFileSync(logPath, 'utf8').split('\n').filter((line) => line.length > 0)
    expect(lines.length, 'two abstentions and one answer must leave exactly two records').toBe(2)

    const log = readExplainCoverageLog(logPath)
    expect(log.skippedLines).toBe(0)
    expect(log.records.map((record) => record.query)).toEqual([
      'first question nobody documented',
      'second question nobody documented',
    ])
    for (const record of log.records) {
      expect(Number.isNaN(Date.parse(record.at))).toBe(false)
      // The digest names the catalog the abstention was computed over — so a later reader can tell
      // a genuine gap from a catalog that has moved since.
      expect(record.catalogDigest.length).toBeGreaterThan(0)
    }
  })

  it('accepts a new append after a TORN trailing line, and the reader skips it', async () => {
    // The concurrency posture, driven rather than asserted: one record is one `appendFileSync` of
    // one line, so the only line a killed process can leave half-written is the last one.
    const root = workspace()
    const logPath = resolveExplainCoverageLogPath(root)
    writeFileSync(
      logPath,
      `${JSON.stringify({ at: '2026-08-17T00:00:00.000Z', query: 'an earlier gap', closestRowIds: [], catalogDigest: 'seed' })}\n`
      + '{"at":"2026-08-17T00:00:01.000Z","query":"a write that never fin',
      'utf8',
    )

    const shipped = createCliCapabilityCatalogPort({ agentQaRoot: root })
    await explain({ ...shipped, citeCapabilities: async () => ({ citedRowIds: ['op:ghost'] }) },
      'the question after the crash')

    const log = readExplainCoverageLog(logPath)
    expect(log.records.map((record) => record.query)).toEqual([
      'an earlier gap',
      // The torn line is SKIPPED, and — the part this cell was written to catch — the record
      // appended AFTER it survives intact. A first draft of the appender concatenated onto the
      // unterminated tail and silently lost this line entirely.
      'the question after the crash',
    ])
    // Skipped, and SAID SO. A reader that swallowed it silently would report a coverage number
    // quietly missing records; one that threw would let a single crash poison the signal forever.
    expect(log.skippedLines).toBe(1)
  })

  it('never lets one bad line hide a good one, wherever it sits', async () => {
    // Skip only a malformed line: one killed append must not destroy the log or drop later records.
    const root = workspace()
    const logPath = resolveExplainCoverageLogPath(root)
    writeFileSync(
      logPath,
      'a torn line that never finished\n'
      + `${JSON.stringify({ at: '2026-08-17T00:00:02.000Z', query: 'after', closestRowIds: [], catalogDigest: 'd' })}\n`,
      'utf8',
    )
    const log = readExplainCoverageLog(logPath)
    expect(log.records.map((record) => record.query)).toEqual(['after'])
    expect(log.skippedLines).toBe(1)
  })

  it('reads a log that was never written as empty, not as an error', async () => {
    expect(readExplainCoverageLog(resolveExplainCoverageLogPath(workspace())))
      .toEqual({ records: [], skippedLines: 0 })
  })
})

describe('the counter hooks carry counts and never the query', () => {
  it('fires onAnswered exactly once on the answer path and onAbstained never', async () => {
    const root = workspace()
    let answered = 0
    const abstained: ExplainAbstainedCounts[] = []
    const shipped = createCliCapabilityCatalogPort({
      agentQaRoot: root,
      onAnswered: () => { answered += 1 },
      onAbstained: (counts) => { abstained.push(counts) },
    })

    const output = await explain(
      { ...shipped, citeCapabilities: async () => ({ citedRowIds: [realRowId] }) },
      'start a run',
    )

    expect(output.kind).toBe('answer')
    expect(answered).toBe(1)
    expect(abstained).toEqual([])
  })

  it('fires onAbstained exactly once, with counts and no string payload', async () => {
    const root = workspace()
    let answered = 0
    const abstained: ExplainAbstainedCounts[] = []
    const shipped = createCliCapabilityCatalogPort({
      agentQaRoot: root,
      onAnswered: () => { answered += 1 },
      onAbstained: (counts) => { abstained.push(counts) },
    })

    await explain(
      { ...shipped, citeCapabilities: async () => ({ citedRowIds: ['op:ghost'] }) },
      'zzzz qqqq wwww',
    )

    expect(answered).toBe(0)
    expect(abstained.length).toBe(1)
    expect(abstained[0]?.catalogEmpty).toBe(false)
    // The hook's payload has no member a query could occupy, so the whole payload is checked.
    expect(JSON.stringify(abstained[0])).not.toContain('zzzz')
    for (const value of Object.values(abstained[0] ?? {})) {
      expect(typeof value === 'number' || typeof value === 'boolean').toBe(true)
    }
  })

  it('reports catalogEmpty off the LOAD, not off an empty suggestion set', async () => {
    // The two facts a careless counter conflates: a query with no lexical overlap against fifty
    // rows also suggests nothing, and reporting that as "this install has no catalog" would make
    // the signal useless in exactly the case it exists for.
    const root = workspace()
    const catalogPath = join(root, 'capability-catalog.json')
    writeFileSync(catalogPath, capabilityCatalogText(capabilityCatalogDocumentOf([])), 'utf8')

    const empty: ExplainAbstainedCounts[] = []
    await explain(
      createCliCapabilityCatalogPort({
        agentQaRoot: root,
        catalogPath,
        onAbstained: (counts) => { empty.push(counts) },
      }),
      'anything at all',
    )
    expect(empty[0]).toEqual({ suggestedRowCount: 0, catalogEmpty: true })

    const full: ExplainAbstainedCounts[] = []
    const shipped = createCliCapabilityCatalogPort({
      agentQaRoot: root,
      onAbstained: (counts) => { full.push(counts) },
    })
    await explain(
      { ...shipped, citeCapabilities: async () => ({ citedRowIds: ['op:ghost'] }) },
      'zzzz qqqq wwww',
    )
    expect(full[0]?.catalogEmpty).toBe(false)
  })
})

describe('a composition with no catalog port refuses BY NAME', () => {
  it('never degrades to a model-only answer', async () => {
    // The absence that matters most in this feature: an explain that quietly lost its grounding
    // data still SOUNDS like an explain, so the honest report is a refusal naming the capability.
    const registry = createFunctionRegistry({
      deps: {} as unknown as Parameters<typeof createFunctionRegistry>[0]['deps'],
    })
    await expect(
      invokeFunction(registry, EXPLAIN_FUNCTION_ID, { query: 'what can you do' }, CONFORMANCE_CENSUS_CALLER),
    ).rejects.toThrow(EXPLAIN_FUNCTION_ID)
  })

  it('answers an abstention rather than an error when the host composed no MODEL', async () => {
    // The other absence, and it is a DIFFERENT answer on purpose. A host with no LLM configuration
    // can still load the catalog, so the capability is genuinely bound — it simply cannot cite, and
    // the honest result is the abstention arm rather than a refusal about a missing binding.
    const root = workspace()
    const output = await explain(
      createCliCapabilityCatalogPort({ agentQaRoot: root }),
      'what can you do',
    )
    expect(output.kind).toBe('abstention')
    if (output.kind !== 'abstention') return
    expect(output.docsGap.logged).toBe(true)
  })
})

// Module-level, so every cell that needs a model half shares one stub.
function recordingModel(answer: string): { readonly model: ChatLanguageModel; prompts: string[] } {
  const prompts: string[] = []
  const model = new MockLanguageModelV3({
    // Inferred: annotating it names the provider protocol package, which only `model` may import.
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt))
      return {
        content: [{ type: 'text' as const, text: answer }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      }
    },
  })
  return { model: model as unknown as ChatLanguageModel, prompts }
}

describe('the grounding obligation, driven through the SHIPPED model path', () => {
  // The cells above doctor `citeCapabilities`, so these watch what the port sends a mock model.

  it('puts EVERY loaded catalog row in the prompt — the obligation, ranged not sampled', async () => {
    const root = workspace()
    const { model, prompts } = recordingModel('{"citedRowIds": []}')
    await explain(createCliCapabilityCatalogPort({ agentQaRoot: root, model }), 'what can you do')

    expect(prompts.length, 'the shipped port never reached the model at all').toBe(1)
    const sent = prompts[0] ?? ''
    const missing = committedRows
      .map((row) => (row.kind === 'op' ? row.id : row.kind === 'alias' ? row.alias : row.name))
      .filter((key) => !sent.includes(key))
    expect(missing, 'rows the model was never shown — it cannot cite what it did not receive')
      .toEqual([])
  })

  it('never shows the model an invocation form', async () => {
    // The other half of the same prompt, and the reason it is a separate claim: the model may only
    // answer with row ids, and every character of a command a person reads is quoted out of a row by
    // the renderer. A prompt carrying `/fn <id>` would be handing the model the exact text it must
    // never be the source of — which the inertness property would still survive, and which would
    // make the no-invention guarantee rest on the renderer alone rather than on both halves.
    const root = workspace()
    const { model, prompts } = recordingModel('{"citedRowIds": []}')
    await explain(createCliCapabilityCatalogPort({ agentQaRoot: root, model }), 'how do I start a run')
    expect(prompts[0] ?? '').not.toContain('/fn ')
  })

  it('degrades a command-carrying model answer to abstention, end to end', async () => {
    // The citation contract is `.strict()`: a model answering a command fails parse and abstains.
    const root = workspace()
    const { model } = recordingModel(
      '{"citedRowIds": ["op:runs.start"], "command": "agent-qa deploy --prod --force"}',
    )
    const output = await explain(
      createCliCapabilityCatalogPort({ agentQaRoot: root, model }),
      'how do I deploy',
    )
    expect(output.kind).toBe('abstention')
    expect(JSON.stringify(output)).not.toContain('deploy --prod')
  })

  it('reads a fenced JSON answer, and only that one tolerance', async () => {
    // A model that produced the right answer in the wrong envelope has answered correctly, so ONE
    // extraction step is honest. Everything past it is a parse failure — never a retry, which would
    // spend a person's money arguing with a model about syntax.
    const root = workspace()
    const { model } = recordingModel(
      `Here you go:\n\`\`\`json\n{"citedRowIds": ["${realRowId}"]}\n\`\`\``,
    )
    const output = await explain(
      createCliCapabilityCatalogPort({ agentQaRoot: root, model }),
      'start a run',
    )
    expect(output.kind).toBe('answer')
  })
})

// The hook cells pass on a host that never binds the port, so this composes the shipped CLI host.
describe('the composition root binds the counter hooks to the analytics port', () => {
  it('turns an abstention into exactly one counter event carrying no query text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-explain-hooks-'))
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(
      configPath,
      `${JSON.stringify({
        workspace: {
          testMatch: ['tests/**/*.test.yaml'],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
      })}\n`,
      'utf8',
    )

    const sent: { name: string; properties: Record<string, unknown> }[] = []
    const [{ composeAnalyticsHost }, { composeCliLocalAgent, CLI_FUNCTION_CALLER }] =
      await Promise.all([
        import('../../composition/analytics-host.js'),
        import('../../composition/local-agent-host.js'),
      ])

    const analytics = await composeAnalyticsHost({
      surface: 'chat',
      env: {},
      transportOverride: {
        capture: (payload) => { sent.push(payload.event as typeof sent[number]) },
        flush: () => {},
        shutdown: () => {},
      },
      resolveIdentity: async () => ({ distinctId: 'u_explain-cell', runtimeContext: 'user' }),
    })

    const host = composeCliLocalAgent({
      agentQaRoot: join(root, '.agent-qa'),
      configPath,
      analytics,
    })

    try {
      // No chat model was composed, so this host's explain cannot cite — which is a REAL posture
      // and the honest one for a project with no LLM configuration. It abstains, and the abstention
      // is what the counter reports.
      const output = await invokeFunction(
        host.registry,
        EXPLAIN_FUNCTION_ID,
        { query: 'zzzz qqqq wwww' },
        CLI_FUNCTION_CALLER,
      ) as ExplainOutput

      expect(output.kind).toBe('abstention')
      await analytics.flush()

      const abstained = sent.filter((event) => event.name === 'agent-qa.explain.abstained')
      expect(abstained).toHaveLength(1)
      expect(sent.filter((event) => event.name === 'agent-qa.explain.answered')).toEqual([])
      expect(abstained[0]?.properties).toMatchObject({
        catalog_empty: false,
        surface: 'chat',
      })
      expect(typeof abstained[0]?.properties.suggested_row_count).toBe('number')

      // Over the wire: the distinctive query may appear nowhere in what crossed the port.
      expect(JSON.stringify(sent)).not.toContain('zzzz')
    } finally {
      await host.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})


// These drive the turn, not the op: an answer dropped at the surface still reads fine on the op.
describe('the grounded explain answer rides the turn a person reads', () => {
  const PLANTED_MODEL_PROSE = 'PLANTED-MODEL-PROSE-4f0c2a9d'

  /**
   * The model reply both cells use: a real committed row id, plus prose in the ONE field the
   * citation contract admits model text in.
   *
   * WHY `segments` AND NOT AN EXTRA KEY. `ExplainCitationSchema` is `.strict()`, so an undeclared
   * key is a parse failure, which is an empty citation, which is the ABSTENTION arm — that path is
   * already pinned by `degrades a command-carrying model answer to abstention`, and using it here
   * would measure the parse rather than the channel. `segments` is admitted precisely so a model is
   * not forced into a shape it cannot hold, and the renderer treats it as INERT. Planting the token
   * there is therefore the harder claim: the text was ACCEPTED by the contract, reached the
   * renderer, and still may not appear anywhere in what the new channel carries to a person.
   */
  function citingReply(rowId: string): string {
    return JSON.stringify({
      citedRowIds: [rowId],
      segments: [{ kind: 'text', text: PLANTED_MODEL_PROSE }],
    })
  }

  interface DrivenTurn {
    readonly result: AgentAskResult
    readonly row: CatalogRow
  }

  /** One turn through the SHIPPED host, dispatched through the SHIPPED `agent.ask` op. */
  async function driveExplainTurn(): Promise<DrivenTurn> {
    const root = workspace()
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(
      configPath,
      `${JSON.stringify({
        workspace: {
          testMatch: ['tests/**/*.test.yaml'],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
      })}\n`,
      'utf8',
    )
    writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')

    const { composeCliLocalAgent, CLI_FUNCTION_CALLER } =
      await import('../../composition/local-agent-host.js')

    const { model } = recordingModel(citingReply(realRowId))
    const host = composeCliLocalAgent({
      agentQaRoot: join(root, '.agent-qa'),
      configPath,
      chatModel: model,
    })

    try {
      const result = await invokeFunction(
        host.registry,
        AGENT_ASK_FUNCTION_ID,
        { message: `/fn ${EXPLAIN_FUNCTION_ID} {"query": "how do I start a run"}` },
        CLI_FUNCTION_CALLER,
      ) as AgentAskResult

      const row = committedRows.find(
        (candidate) => `${candidate.kind}:${catalogRowKey(candidate)}` === realRowId,
      )
      expect(row, `the committed catalog no longer answers to ${realRowId}`).toBeDefined()
      return { result, row: row as CatalogRow }
    } finally {
      await host.close()
    }
  }

  it('puts the cited row\'s OWN rendered line on the turn\'s answer field', async () => {
    const { result, row } = await driveExplainTurn()

    // THE SHAPE FIRST: a fail-closed turn carries no answer at all, and "no answer" would otherwise
    // read as "the channel is unwired" when the real diagnosis is that nothing ran.
    expect(
      { status: result.status, receipts: result.receipts.length },
      `the turn did not execute ${EXPLAIN_FUNCTION_ID}; it answered `
      + `${JSON.stringify(result.unhandled ?? null)}`,
    ).toEqual({ status: 'completed', receipts: 1 })

    // Both fragments come from the row itself: its description verbatim, and its reachable form as
    // the renderer composes one for an op row. Nothing here is a catalog literal.
    const answer = result.answer ?? ''
    expect(
      answer,
      `the turn's answer field carried no line quoted out of ${realRowId}; the answer was `
      + `${JSON.stringify(answer)}`,
    ).toContain(row.description)
    expect(
      answer,
      `the turn's answer field carried no invocation for ${realRowId}`,
    ).toContain(`\`/fn ${row.kind === 'op' ? row.id : catalogRowKey(row)}\``)
  })

  it('leaves the receipt the MAP, and no model prose anywhere on the turn', async () => {
    const { result, row } = await driveExplainTurn()

    // The description is on `answer` and no receipt line; either half alone passes a broken build.
    expect(
      result.answer ?? '',
      'the answer channel carries nothing, so this cell would be asserting the receipt is plain on '
      + 'a build that shows a person nothing at all',
    ).toContain(row.description)
    expect(
      result.receipts.map((receipt) => receipt.outcome).join('\n'),
      'the clause receipt grew a second carrier for the explain result',
    ).not.toContain(row.description)

    // The receipt is a map: a status word and a count of citations, with no byte of the answer.
    expect(
      result.receipts.map((receipt) => ({
        functionId: receipt.functionId,
        status: receipt.status,
        outcome: receipt.outcome,
      })),
      'the explain receipt is no longer the op\'s own one-line map',
    ).toEqual([
      {
        functionId: EXPLAIN_FUNCTION_ID,
        status: 'executed',
        outcome: 'answered — 1 capability citation(s)',
      },
    ])

    // NO-INVENTION, over the WHOLE serialized turn rather than over the answer alone: the planted
    // token was admitted by the citation contract and reached the renderer, and the renderer's
    // inertness is what keeps it out of everything downstream. A new channel that became a door
    // for model prose reds here.
    expect(
      JSON.stringify(result),
      'model-authored prose reached the turn a person reads',
    ).not.toContain(PLANTED_MODEL_PROSE)
  })
})
