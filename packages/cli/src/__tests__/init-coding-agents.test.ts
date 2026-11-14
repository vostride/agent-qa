// Checks which coding agents init pre-checks from markers and the host, the question init draws
// and the --agents flag.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { S_CHECKBOX_INACTIVE, S_CHECKBOX_SELECTED } from '@clack/prompts'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliRefusal } from '../composition/cli-refusal.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { createInitCommand } from '../commands/init.js'
import {
  INIT_AGENT_OPTIONS,
  detectCodingAgents,
  parseInitAgentsFlag,
} from '../commands/init-agents.js'
import type { ProjectIo } from '../commands/project-host.js'
import { createClackUi } from '../init-ui/clack-ui.js'
import type { InitUi } from '../init-ui/init-ui.js'
import { brandPalette } from '../init-ui/palette.js'
import { KEY, clackStreams, type ClackStreams } from './clack-keys.js'
import { cleanupTempProjects, fakeRunner, tempProject } from './project-fixtures.js'

afterEach(cleanupTempProjects)

function recordingIo(): ProjectIo & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    exists: (path) => existsSync(path),
    readText: (path) => {
      reads.push(path)
      return undefined
    },
    realpath: async (path) => {
      reads.push(path)
      return path
    },
  }
}

function refusalOf(value: string): CliRefusal {
  try {
    parseInitAgentsFlag(value)
  } catch (error) {
    if (error instanceof CliRefusal) return error
    throw error
  }
  throw new Error(`--agents ${value} was accepted`)
}

function plainLines(refusal: CliRefusal): string[] {
  return refusal.message.split('\n')
}

describe('the coding agents question', () => {
  it('offers Claude Code and Codex with the files each writes', () => {
    expect(INIT_AGENT_OPTIONS).toEqual([
      { value: 'claude-code', label: 'Claude Code', hint: '.claude/skills, .mcp.json' },
      { value: 'codex', label: 'Codex', hint: '.agents/skills, .codex/config.toml' },
    ])
  })
})

describe('detectCodingAgents', () => {
  it('pre-checks Claude Code for a .claude folder in the project', async () => {
    const { root, home } = tempProject('agents-claude-dir')
    mkdirSync(join(root, '.claude'))
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env: {} })).toEqual([
      'claude-code',
    ])
  })

  it('pre-checks Codex for an .agents folder in the project', async () => {
    const { root, home } = tempProject('agents-agents-dir')
    mkdirSync(join(root, '.agents'))
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env: {} })).toEqual([
      'codex',
    ])
  })

  it('pre-checks Codex for a .codex folder in the home folder', async () => {
    const { root, home } = tempProject('agents-home-codex')
    mkdirSync(join(home, '.codex'))
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env: {} })).toEqual([
      'codex',
    ])
  })

  it('pre-checks Claude Code for a .claude.json file in the home folder', async () => {
    const { root, home } = tempProject('agents-home-claude-json')
    writeFileSync(join(home, '.claude.json'), '{}')
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env: {} })).toEqual([
      'claude-code',
    ])
  })

  it('pre-checks both agents when nothing is detected', async () => {
    const { root, home } = tempProject('agents-nothing')
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env: {} })).toEqual([
      'claude-code',
      'codex',
    ])
  })

  it('pre-checks both agents in their usual order when both are detected', async () => {
    const { root, home } = tempProject('agents-both')
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, '.mcp.json'), '{}')
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env: {} })).toEqual([
      'claude-code',
      'codex',
    ])
  })

  it('pre-checks Claude Code when init runs inside Claude Code', async () => {
    const { root, home } = tempProject('agents-host-claude')
    expect(
      await detectCodingAgents({ projectDir: root, homeDir: home, env: { CLAUDECODE: '1' } }),
    ).toEqual(['claude-code'])
  })

  it('pre-checks Codex when init runs inside Codex', async () => {
    const { root, home } = tempProject('agents-host-codex')
    const env = { CODEX_SANDBOX: 'seatbelt' }
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env })).toEqual(['codex'])
  })

  it('treats another host as no signal', async () => {
    const { root, home } = tempProject('agents-host-other')
    mkdirSync(join(root, '.agents'))
    expect(
      await detectCodingAgents({ projectDir: root, homeDir: home, env: { CURSOR_AGENT: '1' } }),
    ).toEqual(['codex'])
  })

  it('detects a CLAUDE.md without reading what it holds', async () => {
    const { root, home } = tempProject('agents-no-read')
    writeFileSync(join(root, 'CLAUDE.md'), 'secret\n')
    writeFileSync(join(home, '.claude.json'), '{"token":"secret"}')
    const io = recordingIo()
    expect(await detectCodingAgents({ projectDir: root, homeDir: home, env: {}, io })).toEqual([
      'claude-code',
    ])
    expect(io.reads).toEqual([])
  })
})

describe('parseInitAgentsFlag', () => {
  it('reads none as no agents', () => {
    expect(parseInitAgentsFlag('none')).toEqual([])
  })

  it('reads all as both agents', () => {
    expect(parseInitAgentsFlag('all')).toEqual(['claude-code', 'codex'])
  })

  it('reads all anywhere in the list as both agents', () => {
    expect(parseInitAgentsFlag('codex,all')).toEqual(['claude-code', 'codex'])
  })

  it('reads one agent as that agent', () => {
    expect(parseInitAgentsFlag('codex')).toEqual(['codex'])
  })

  it('reads a list in the usual agent order, ignoring spaces', () => {
    expect(parseInitAgentsFlag('codex, claude-code')).toEqual(['claude-code', 'codex'])
  })

  it('returns an array for every accepted value', () => {
    for (const value of ['none', 'all', 'codex,all', 'codex', 'codex,claude-code']) {
      expect(Array.isArray(parseInitAgentsFlag(value))).toBe(true)
    }
  })

  it('refuses none combined with another agent with exit 2', () => {
    for (const value of ['none,codex', 'all,none']) {
      const refusal = refusalOf(value)
      expect(refusal.exitCode).toBe(2)
      expect(plainLines(refusal)).toEqual([
        '--agents none cannot be combined with other agents. Use claude-code, codex, all or none.',
      ])
    }
  })

  it('refuses an unknown agent with exit 2, naming the accepted values', () => {
    const refusal = refusalOf('cursor')
    expect(refusal.exitCode).toBe(2)
    expect(plainLines(refusal)).toEqual([
      'Unknown coding agent "cursor". Use claude-code, codex, all or none.',
    ])
  })
})

const AGENTS_QUESTION = 'Which coding agents should agent-qa set up?'

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-coding-agents', runtimeContext: 'user' }),
  })

// Real Clack on test streams; each multiselect answer is kept so a cell reads what init was told.
function answeredRail(streams: ClackStreams): { ui: InitUi; answers: unknown[][] } {
  const rail = createClackUi({
    input: streams.input,
    output: streams.output,
    palette: brandPalette({ background: 'dark', level: 0 }),
    columns: streams.output.columns,
  })
  const answers: unknown[][] = []
  const ui: InitUi = {
    ...rail,
    multiselect: async (q) => {
      const answer = await rail.multiselect(q)
      answers.push(answer)
      return answer
    },
  }
  return { ui, answers }
}

interface AgentsRun {
  drawn: string
  text: string
  answers: unknown[][]
}

async function agentsOnTheRail(
  project: { root: string; home: string },
  keys: readonly string[],
): Promise<AgentsRun> {
  const streams = clackStreams()
  const { ui, answers } = answeredRail(streams)
  const parent = new Command()
  const command = createInitCommand({
    cwd: project.root,
    host: { homedir: project.home, env: {}, run: fakeRunner() },
    isTTY: true,
    composeAnalytics: silentAnalytics,
    ui,
  })
  parent.exitOverride()
  command.exitOverride()
  parent.addCommand(command)
  const done = parent.parseAsync(
    [
      'node',
      'test',
      'init',
      '--platform',
      'web',
      '--llm',
      'claude-code',
      '--pm',
      'none',
    ],
  )
  await streams.waitFor(AGENTS_QUESTION)
  const drawn = stripVTControlCharacters(streams.text())
  await streams.press(...keys)
  await done
  return {
    drawn: drawn.slice(drawn.indexOf(AGENTS_QUESTION)),
    text: stripVTControlCharacters(streams.text()),
    answers,
  }
}

function lineWith(text: string, label: string): string {
  const line = text.split('\n').find((entry) => entry.includes(label))
  expect(line, `the question drew ${label}`).toBeDefined()
  return line!
}

describe('the coding agents question in init', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lists both agents with what each writes, checks Claude Code for a .claude folder, and Enter takes it', async () => {
    const project = tempProject('agents-rail-claude')
    mkdirSync(join(project.root, '.claude'))

    const run = await agentsOnTheRail(project, [KEY.down, KEY.enter])

    expect(lineWith(run.drawn, 'Claude Code')).toContain(
      `${S_CHECKBOX_SELECTED} Claude Code (.claude/skills, .mcp.json)`,
    )
    expect(lineWith(run.drawn, 'Codex')).toContain(`${S_CHECKBOX_INACTIVE} Codex`)
    expect(run.text).toContain('Codex (.agents/skills, .codex/config.toml)')
    expect(run.answers).toEqual([['claude-code']])
  })

  it('unchecking Claude Code and pressing Enter sets up no agent', async () => {
    const project = tempProject('agents-rail-none')
    mkdirSync(join(project.root, '.claude'))

    const run = await agentsOnTheRail(project, [KEY.space, KEY.enter])

    expect(run.answers).toEqual([[]])
  })

  it('checks both agents when nothing is detected', async () => {
    const run = await agentsOnTheRail(tempProject('agents-rail-both'), [KEY.enter])

    expect(lineWith(run.drawn, 'Claude Code')).toContain(S_CHECKBOX_SELECTED)
    expect(lineWith(run.drawn, 'Codex')).toContain(S_CHECKBOX_SELECTED)
    expect(run.answers).toEqual([['claude-code', 'codex']])
  })
})
