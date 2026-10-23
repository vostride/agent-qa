import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({}),
}))

import { createQueueCommand } from '../queue.js'
import { createDaemonCommand } from '../daemon.js'
import { createKnowledgeCommand } from '../knowledge.js'

/**
 * The three-queue vocabulary pin (JOBQ-07 / D-21 / D-22).
 *
 * A snapshot of whatever the help happens to say would pass forever and prove nothing, so this
 * file asserts a RELATION instead: every singular occurrence of the word "queue" in the help must
 * carry exactly one of three qualifiers, and the set of qualifiers found must be all three. A
 * regression that collapses two queues onto one name shrinks the set; a regression that says bare
 * "queue" adds a qualifier that is not in the set. Both redden here.
 */
const CANONICAL_ORDER = ['run queue', 'curation queue', 'agent job queue'] as const
const QUALIFIERS = ['run', 'curation', 'agent job'] as const

/**
 * What `agent-qa queue --help` actually prints.
 *
 * `helpInformation()` is NOT that text: commander renders `addHelpText` only on the output path,
 * so asserting against `helpInformation()` would silently exempt the disambiguation block this
 * plan exists to ship.
 */
function helpOutput(cmd = createQueueCommand()): string {
  let buffer = ''
  cmd.configureOutput({ writeOut: (str) => (buffer += str) })
  cmd.outputHelp()
  return buffer
}

/**
 * Occurrences of the command's own NAME are exempt, and only there: D-22 ratifies that the v1
 * command stays `agent-qa queue`, so commander's usage line is the one place a bare token is
 * correct. Dropping the whole line rather than the token keeps the exemption narrow enough that
 * prose can never hide behind it.
 */
function proseOf(help: string): string {
  return help
    .split('\n')
    .filter((line) => !line.startsWith('Usage:'))
    .join('\n')
}

function qualifiersIn(prose: string): string[] {
  const found = new Set<string>()
  // Both boundaries, not just the trailing one. The trailing lookahead alone made the relation
  // fire inside `requeue` — a VERB whose last five letters happen to spell the noun — and would
  // have forced the 413-14 subcommand to be named something other than what it does. A compound
  // word is not an unqualified use of the noun; a bare "the queue" still is, and the control cell
  // below still reddens on it.
  const singular = /(?<![\w-])queue(?![\w-])/g
  for (let m = singular.exec(prose); m !== null; m = singular.exec(prose)) {
    const before = prose.slice(0, m.index)
    const qualifier = QUALIFIERS.find((q) => before.endsWith(`${q} `))
    found.add(qualifier ?? `UNQUALIFIED:${JSON.stringify(before.slice(-24))}`)
  }
  return [...found].sort()
}

describe('agent-qa queue help text — the three-queue vocabulary', () => {
  it('keeps the command named "queue" (D-22)', () => {
    expect(createQueueCommand().name()).toBe('queue')
  })

  it('names all three queues', () => {
    const help = helpOutput()
    for (const name of CANONICAL_ORDER) {
      expect(help).toContain(name)
    }
  })

  it('qualifies every "queue" it prints, with all three qualifiers and nothing else', () => {
    expect(qualifiersIn(proseOf(helpOutput()))).toEqual([...QUALIFIERS].sort())
  })

  it('enumerates the three in canonical order', () => {
    const help = helpOutput()
    const positions = CANONICAL_ORDER.map((name) => help.indexOf(name))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('points at the published page that names the same three queues', () => {
    expect(helpOutput()).toContain('See https://vostride.com/docs/agent-qa/daemon.')
  })

  it('detects a collapsed vocabulary — the control for the assertion above', () => {
    // The regression this file exists to catch, applied to a copy of the help text: the curation
    // queue renamed onto the agent job queue's name. Without this control, a green suite could
    // mean the relation holds or that it is unfalsifiable.
    const collapsed = proseOf(helpOutput()).replaceAll('curation queue', 'agent job queue')
    expect(qualifiersIn(collapsed)).not.toEqual([...QUALIFIERS].sort())

    const unqualified = proseOf(helpOutput()).replace('the run queue', 'the queue')
    expect(qualifiersIn(unqualified).some((q) => q.startsWith('UNQUALIFIED:'))).toBe(true)
  })
})

describe('agent-qa daemon help text — the same three-queue vocabulary', () => {
  it('names, qualifies, and orders the same three queues', () => {
    const help = helpOutput(createDaemonCommand())
    for (const name of CANONICAL_ORDER) expect(help).toContain(name)
    expect(qualifiersIn(proseOf(help))).toEqual([...QUALIFIERS].sort())

    const positions = CANONICAL_ORDER.map((name) => help.indexOf(name))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})

describe('agent-qa knowledge drain help text — the same three-queue vocabulary', () => {
  it('names the curation queue it drains without collapsing the other two queues', () => {
    const drain = createKnowledgeCommand().commands.find((command) => command.name() === 'drain')
    expect(drain).toBeDefined()
    const help = helpOutput(drain!)

    for (const name of CANONICAL_ORDER) expect(help).toContain(name)
    expect(qualifiersIn(proseOf(help))).toEqual([...QUALIFIERS].sort())

    const positions = CANONICAL_ORDER.map((name) => help.indexOf(name))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})
