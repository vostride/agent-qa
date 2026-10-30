// A headless ask configures and authors with no prompt; a bound surface sees the change after it.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  AGENT_ASK_FUNCTION_ID,
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { AgentAskResult } from '@vostride/agent-qa-schema'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
// Safety publishes no confirm port, so its shape is spelled here and the spies show it never runs.
interface ConfirmPort {
  readonly surface: 'tty-prompt'
  readonly ask: (action: unknown) => boolean
}

const CONFIG_FILE = 'agent-qa.config.yaml'

/** The utterance the from-zero drive uses, verbatim. */
const UTTERANCE = 'write a test for booking.com checkout'

// Zero targets puts the utterance on the from-zero road; the chat model comes from `registry.llms`.
const ZERO_TARGET_CONFIG = `# my own agent-qa configuration

workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra

use:
  llm: judge
  mobile:
    appState: preserve
  parallel: false
`

const SEEDED_GITIGNORE = '# the project\'s own rules\ndist/\n.agent-qa/\n'

let root: string
let configPath: string
let agentQaRoot: string

function git(...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

/**
 * A model that emits exactly one `authoring.draft.write` tool call (the `scriptedPlanner` idiom
 * from `agent-local`'s hermetic chat lane).
 *
 * THE TOOL NAME IS DERIVED FROM THE IMPORTED ID rather than typed, so an op renamed at its
 * declaration reds here instead of leaving this cell agreeing with a string nothing dispatches.
 */
function scriptedWriteTestPlanner(): { model: unknown; calls: () => number } {
  let reached = 0
  const model = {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId: 'fixture:ask-present-road',
    supportedUrls: {},
    doGenerate: () => {
      reached += 1
      return Promise.resolve({
        content: [{
          type: 'tool-call' as const,
          toolCallId: 'scripted-0',
          toolName: AUTHORING_DRAFT_WRITE_FUNCTION_ID.replaceAll('.', '_'),
          input: JSON.stringify({ intent: UTTERANCE }),
        }],
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      })
    },
    doStream: (): never => {
      throw new Error('this lane never streams')
    },
  }
  return { model, calls: () => reached }
}

/** The target the scaffold wrote into the config on disk, if any. */
function configuredBooking(): boolean {
  try {
    return readFileSync(configPath, 'utf8').includes('booking-com:')
  } catch {
    return false
  }
}

/** Every proposal record the composition durably filed, read the way a person's inbox reads them. */
function filedProposals(): string[] {
  const dir = join(agentQaRoot, 'proposals')
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ask-present-road-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')
  mkdirSync(agentQaRoot, { recursive: true })

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa ask-present-road test')
  git('config', 'user.email', 'ask-present-road@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), SEEDED_GITIGNORE)
  writeFileSync(join(root, 'README.md'), 'a project with a model and no targets\n')
  // Committed, not merely written: the scaffold re-reads the committed set at proposal time.
  writeFileSync(configPath, ZERO_TARGET_CONFIG)
  // Ask refuses a project whose secrets file is missing.
  writeFileSync(join(root, '.env.secrets.local'), '')
  git('add', '--', '.gitignore', 'README.md', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'the project configures a model and no targets')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('agent-qa ask, at a terminal, over a project with nothing to test against', () => {
  it('with NO presentation port bound the scaffold still writes and the turn authors — nothing asks',
    async () => {
      // Only the confirm is a spy; the registry, route, op and durable store are the shipped ones.
      const planner = scriptedWriteTestPlanner()
      const ask = vi.fn((_action: unknown) => true)
      const confirm: ConfirmPort = { surface: 'tty-prompt', ask }
      const host = composeCliLocalAgent({
        agentQaRoot,
        configPath,
        // The input declares no confirm, so the spy is smuggled past the type.
        ...{ confirm } as object,
        chatModel: planner.model as never,
      })

      let result: AgentAskResult
      try {
        result = await runSafetyScope(
          { executionContext: 'local-interactive' },
          async () => await invokeFunction(
            host.registry, AGENT_ASK_FUNCTION_ID, { message: UTTERANCE }, CLI_FUNCTION_CALLER,
          ) as AgentAskResult,
        )
      } finally {
        await host.close()
      }

      // NON-VACUITY FIRST: the clause really did reach the planner and really did route. A cell
      // whose confirm count is zero because nothing happened would prove nothing at all.
      expect(planner.calls()).toBeGreaterThanOrEqual(1)

      // No prompt names a config op: there is no apply verb to ask about.
      const askedAbout = ask.mock.calls.map((call) => JSON.stringify(call))
      expect(askedAbout.filter((asked) => asked.includes('config.'))).toEqual([])

      // THE CONFIG WAS WRITTEN AND THE TURN WENT ON TO AUTHOR against it; nothing was filed.
      expect(configuredBooking()).toBe(true)
      expect(result.status).not.toBe('fail_closed')
      expect(filedProposals()).toHaveLength(0)
    })

  it('with the port bound the change is RENDERED once it is written, and nothing asks for it',
    async () => {
      // The control: a bound present proceeds, so the headless refusal is not a constant.
      const planner = scriptedWriteTestPlanner()
      const events: string[] = []
      const rendered: string[] = []
      const configuredAtRender: boolean[] = []
      const ask = vi.fn(() => {
        events.push('confirm')
        return true
      })
      const confirm: ConfirmPort = { surface: 'tty-prompt', ask }
      const host = composeCliLocalAgent({
        agentQaRoot,
        configPath,
        // The input declares no confirm, so the spy is smuggled past the type.
        ...{ confirm } as object,
        chatPresent: (text: string) => {
          events.push('present')
          rendered.push(text)
          configuredAtRender.push(configuredBooking())
        },
        chatModel: planner.model as never,
      })

      let result: AgentAskResult
      try {
        result = await runSafetyScope(
          { executionContext: 'local-interactive' },
          async () => await invokeFunction(
            host.registry, AGENT_ASK_FUNCTION_ID, { message: UTTERANCE }, CLI_FUNCTION_CALLER,
          ) as AgentAskResult,
        )
      } finally {
        await host.close()
      }

      // The render ran once, after the configuration reached disk.
      expect(rendered).toHaveLength(1)
      expect(events.indexOf('present')).toBe(0)
      expect(configuredAtRender).toEqual([true])

      // AND WHAT WAS RENDERED IS THIS CHANGE: its summary line, the config file it touched, and a
      // true unified diff. Asserted as properties of the real op's own answer rather than as a
      // literal, so a re-derived or truncated render reds here.
      const text = rendered[0] ?? ''
      expect(text).toContain('booking.com')
      expect(text).toContain(CONFIG_FILE)
      expect(text).toContain('@@')
      expect(text.split('\n').length).toBeGreaterThan(3)

      // The turn proceeds: authoring runs against the project the person just configured.
      expect(result.status).not.toBe('fail_closed')
      expect(filedProposals()).toHaveLength(0)
    })
})
