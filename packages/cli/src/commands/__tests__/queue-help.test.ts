import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({}),
}))

import { createQueueCommand } from '../queue.js'
import { createDaemonCommand } from '../daemon.js'
import { createKnowledgeCommand } from '../knowledge.js'

// Each bare `queue` in the help carries a `CANONICAL_ORDER` qualifier, and every one appears.
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

// The usage line names the command `queue`; dropping that whole line keeps prose from hiding there.
function proseOf(help: string): string {
  return help
    .split('\n')
    .filter((line) => !line.startsWith('Usage:'))
    .join('\n')
}

function qualifiersIn(prose: string): string[] {
  const found = new Set<string>()
  // Both boundaries are guarded, so a compound like `requeue` does not count as the noun.
  const singular = /(?<![\w-])queue(?![\w-])/g
  for (let m = singular.exec(prose); m !== null; m = singular.exec(prose)) {
    const before = prose.slice(0, m.index)
    const qualifier = QUALIFIERS.find((q) => before.endsWith(`${q} `))
    found.add(qualifier ?? `UNQUALIFIED:${JSON.stringify(before.slice(-24))}`)
  }
  return [...found].sort()
}

describe('agent-qa queue help text — the three-queue vocabulary', () => {
  it('keeps the command named "queue"', () => {
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
