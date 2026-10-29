// The closed canon's behavioural pin.
//
// Two properties are load-bearing here and both are about what the table REFUSES. The first is
// that its alias set is exactly D-06's canon and nothing else — the table is a cap, and a cap that
// grows without anybody noticing is not one. The second is that resolution is BINARY: a near-miss
// resolves to nothing at all rather than to a best guess, because this path OVERRIDES a model's
// plan and an overriding path with a false-positive rate is worse than no override.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ENTITIES_RESOLVE_FUNCTION_ID } from '../../functions/ops/entities-ids.js'
import { RUNS_DIGEST_FUNCTION_ID } from '../../functions/ops/runs-digest.js'
import { RUNS_LIST_FUNCTION_ID } from '../../functions/ops/runs-list.js'
import { RUNS_START_FUNCTION_ID } from '../../functions/ops/runs-start.js'
import { CHAT_DIRECTIVES, CHAT_HELP_ENTRIES, CHAT_RESOLVER_TABLE, resolveClause } from '../resolver-table.js'
import type { ChatResolverEntry } from '../resolver-table.js'

/** The one call every case makes. */
function resolve(clause: string): ChatResolverEntry | undefined {
  const resolution = resolveClause(CHAT_RESOLVER_TABLE, clause)
  return resolution.kind === 'resolved' ? resolution.entry : undefined
}

function aliasOf(clause: string): string | undefined {
  const resolution = resolveClause(CHAT_RESOLVER_TABLE, clause)
  return resolution.kind === 'resolved' ? resolution.alias : undefined
}

describe('CHAT_RESOLVER_TABLE — the closed canon', () => {
  // `proposals` and `pin` left the canon with the inbox and the op gate.
  it('is exactly the canon: no more aliases, no fewer', () => {
    expect(CHAT_RESOLVER_TABLE.map((rule) => rule.alias)).toEqual([
      'run',
      'status',
      'test-ref',
      'digest',
      'model',
      'fn',
      'help',
      'quit',
    ])
  })

  it('has no alias twice — the first-match walk is over distinct names', () => {
    const aliases = CHAT_RESOLVER_TABLE.map((rule) => rule.alias)
    expect(new Set(aliases).size).toBe(aliases.length)
  })

  it('does not carry the two excluded verbs', () => {
    expect(resolve('/tools')).toBeUndefined()
    expect(resolve('/compact')).toBeUndefined()
  })
})

// chat resolution routes no pin directive and no proposal inbox. Direct
// knowledge and config changes are reached by their own ids through the one `/fn` branch.
describe('chat resolution carries no approval route', () => {
  it('/pin and the proposals inbox no longer resolve, and help names neither', () => {
    expect(resolveClause(CHAT_RESOLVER_TABLE, '/pin fn:runs.start')).toEqual({ kind: 'unresolved' })
    expect(resolveClause(CHAT_RESOLVER_TABLE, 'proposals')).toEqual({ kind: 'unresolved' })
    expect([...CHAT_DIRECTIVES]).toEqual(['model', 'help', 'quit'])
    expect(CHAT_RESOLVER_TABLE.map((rule) => rule.alias)).not.toContain('pin')
    expect(CHAT_RESOLVER_TABLE.map((rule) => rule.alias)).not.toContain('proposals')
    expect(CHAT_HELP_ENTRIES.map((entry) => entry.alias).sort()).toEqual(
      CHAT_RESOLVER_TABLE.map((rule) => rule.alias).sort(),
    )
  })

  it('direct knowledge and config changes resolve to their own op ids', () => {
    expect(resolve('/fn knowledge.forget {"recordId":"mem_1"}')).toEqual({
      kind: 'op',
      functionId: 'knowledge.forget',
      input: { recordId: 'mem_1' },
    })
    expect(resolve('/fn config.field.set {"path":"use.timeout","value":45000}')).toEqual({
      kind: 'op',
      functionId: 'config.field.set',
      input: { path: 'use.timeout', value: 45000 },
    })
  })
})

describe('resolveClause — the op-bound canon', () => {
  it('binds `run <test-ref>` to the run-start op, ref passed through as a pattern', () => {
    expect(resolve('run test 42')).toEqual({
      kind: 'op',
      functionId: RUNS_START_FUNCTION_ID,
      input: { patterns: ['test 42'] },
    })
    expect(aliasOf('run test 42')).toBe('run')
  })

  it('binds bare `status` to the runs listing read', () => {
    expect(resolve('status')).toEqual({
      kind: 'op',
      functionId: RUNS_LIST_FUNCTION_ID,
      input: {},
    })
  })

  it('binds `test <n>` and a bare short-ID to the never-guess resolution ladder', () => {
    expect(resolve('test 42')).toEqual({
      kind: 'op',
      functionId: ENTITIES_RESOLVE_FUNCTION_ID,
      input: { ref: 'test 42' },
    })
    expect(resolve('TST-001')).toEqual({
      kind: 'op',
      functionId: ENTITIES_RESOLVE_FUNCTION_ID,
      input: { ref: 'TST-001' },
    })
    expect(aliasOf('TST-001')).toBe('test-ref')
  })

  it('binds `digest <run>` to the digest op with the ref passed through verbatim', () => {
    expect(resolve('digest RUN-9')).toEqual({
      kind: 'op',
      functionId: RUNS_DIGEST_FUNCTION_ID,
      input: { runId: 'RUN-9' },
    })
  })

  // RE-SPELLED 2026-09-30 from 'binds bare `proposals` to the whole inbox': the alias is
  // gone. 2026-10-01: the inbox op is deleted too, so `/fn proposals.list` resolves to a
  // passthrough naming an id the registry answers as an unknown function.
  it('binds no bare `proposals` alias; the inbox read is reached through /fn', () => {
    expect(resolve('proposals')).toBeUndefined()
    expect(resolve('/fn proposals.list')).toEqual({
      kind: 'op',
      functionId: 'proposals.list',
      input: {},
    })
  })

  it('is case-insensitive on the verb a person typed', () => {
    expect(resolve('STATUS')).toEqual(resolve('status'))
    expect(resolve('Digest RUN-9')).toEqual(resolve('digest RUN-9'))
  })
})

describe('resolveClause — the /fn passthrough', () => {
  it('resolves any registry id through ONE branch, with no body meaning no input', () => {
    expect(resolve('/fn runs.list')).toEqual({
      kind: 'op',
      functionId: RUNS_LIST_FUNCTION_ID,
      input: {},
    })
  })

  it('parses a JSON object body, the `fn --input` precedent', () => {
    expect(resolve('/fn runs.get {"runId":"RUN-1"}')).toEqual({
      kind: 'op',
      functionId: 'runs.get',
      input: { runId: 'RUN-1' },
    })
  })

  it('resolves an op id no registry knows, so invokeFunction refuses it by name', () => {
    // The backstop is FREE: the table validates no id, `invokeFunction` step 1 raises
    // `UnknownFunctionError` naming it, and the turn fails with that name in the receipt.
    expect(resolve('/fn write_test {"name":"2fa"}')).toEqual({
      kind: 'op',
      functionId: 'write_test',
      input: { name: '2fa' },
    })
  })

  it('does not resolve a malformed or non-object body — a near-miss is not a partial match', () => {
    expect(resolve('/fn runs.get {not json}')).toBeUndefined()
    expect(resolve('/fn runs.get RUN-1')).toBeUndefined()
    expect(resolve('/fn runs.get [1,2]')).toBeUndefined()
  })

  it('does not resolve `/fn` with no op id at all', () => {
    expect(resolve('/fn')).toBeUndefined()
    expect(resolve('/fn   ')).toBeUndefined()
  })
})

describe('resolveClause — the directive canon', () => {
  // RE-SPELLED 2026-09-30 from 'resolves /model and /pin to directives that name NO
  // registry op': `/pin` is no longer a directive.
  it('resolves /model to a directive that names NO registry op, and /pin to nothing', () => {
    expect(resolve('/model claude-opus-5')).toEqual({
      kind: 'directive',
      directive: 'model',
      argument: 'claude-opus-5',
    })
    expect(resolve('/pin config-write')).toBeUndefined()
  })

  it('resolves the REPL chrome verbs, which take no argument', () => {
    expect(resolve('/help')).toEqual({ kind: 'directive', directive: 'help' })
    expect(resolve('/quit')).toEqual({ kind: 'directive', directive: 'quit' })
  })

  it('gives a directive entry no functionId — a directive is not a capability', () => {
    const entry = resolve('/help')
    expect(entry).toBeDefined()
    expect(Object.keys(entry!)).not.toContain('functionId')
  })
})

describe('resolveClause — binary resolution, no partial matches', () => {
  it.each([
    ['propsals', 'a misspelled alias'],
    ['statuss', 'a near-miss on a bare verb'],
    ['run', 'a verb missing its required argument'],
    ['digest', 'a digest with no run named'],
    ['/model', 'a directive missing its required argument'],
    ['/pin', 'the retired pin verb, bare'],
    ['test', 'a test-ref with nothing referenced'],
    ['show me the digest', 'ordinary prose that mentions a canonical word'],
    ['status please', 'a bare verb with anything at all after it'],
    ['/tools', 'an excluded verb'],
  ])('does not resolve %j (%s)', (clause) => {
    expect(resolveClause(CHAT_RESOLVER_TABLE, clause)).toEqual({ kind: 'unresolved' })
  })

  it('reads a whole compound utterance as ONE clause, which is why the splitter is upstream', () => {
    // The table is fed CLAUSES, never a raw turn. Handed one anyway, `run test 42 and status`
    // binds the entire remainder as a single pattern — not a bug in the table but the reason
    // `clause-split.ts` runs before it. Pinned so nobody "fixes" it by teaching this file a
    // second conjunction grammar.
    expect(resolve('run test 42 and status')).toEqual({
      kind: 'op',
      functionId: RUNS_START_FUNCTION_ID,
      input: { patterns: ['test 42 and status'] },
    })
  })

  it('reports unresolved as a variant, never as a low-confidence resolution', () => {
    const resolution = resolveClause(CHAT_RESOLVER_TABLE, 'propsals')
    expect(Object.keys(resolution)).toEqual(['kind'])
  })
})

describe('the table as a structure', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../resolver-table.ts', import.meta.url)),
    'utf8',
  )

  it('names every registry op by an IMPORTED constant, never a string literal', () => {
    // The `/fn` branch takes its id from the clause, which is the one legitimate non-constant
    // source. Every other `functionId:` site must be an identifier.
    const literalBindings = source
      .split('\n')
      .filter((line) => /functionId: *['"`]/.test(line) && !line.trimStart().startsWith('//'))
    expect(literalBindings).toEqual([])
  })

  it('has no fractional-confidence member anywhere in the resolution vocabulary', () => {
    // Stage-1 resolution is binary by construction. A confidence number would be the
    // first half of a threshold, and a threshold is how an overriding path acquires a
    // false-positive rate. Comment mentions are fine; a field is not.
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    expect(codeLines.filter((line) => /confidence/i.test(line))).toEqual([])
  })
})
