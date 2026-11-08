// Checks which coding agents init pre-checks from markers and the host, and the --agents flag.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CliRefusal } from '../composition/cli-refusal.js'
import {
  INIT_AGENT_OPTIONS,
  detectCodingAgents,
  parseInitAgentsFlag,
} from '../commands/init-agents.js'
import type { ProjectIo } from '../commands/project-host.js'
import { cleanupTempProjects, tempProject } from './project-fixtures.js'

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
