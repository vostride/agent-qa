// `agent-qa ask` at a terminal: what a person is SHOWN before they are asked (395-22 · CFGM-05 ·
// SC-5 · the owner's 2026-08-15 CR-04 ruling, completed on the UNBOUND-present arm).
//
// THE SCAFFOLD WRITES IN ITS OWN CALL and nothing asks. There is no
// apply to approve, so the render is a receipt of a change already on disk and a missing surface no
// longer stops the turn. Both cells are re-spelled in place: (A2) a headless ask configures and
// authors with no prompt, (A1) a bound surface is shown the change after it was written.
//
// THIS FILE IS 395-VERIFICATION's SCRATCH CELL MADE PERMANENT. Gap round 4 wrote one acceptance
// cell, drove `agent.ask` through the PRODUCTION composition — `composeCliLocalAgent` plus the
// shipped confirm, only the streams substituted — over a real git repository holding a config with
// ZERO targets, and measured the complete set of bytes reaching the person's terminal before the
// decision:
//
//   ["agent-qa: fn:config.proposal.apply needs your approval. Proceed? [y/N] "]
//
// No summary line, no file list, no diff. Then it DELETED the cell. A measurement that falsifies a
// success criterion and leaves nothing behind is a measurement the next round has to re-take, and
// this phase has now been caught five consecutive times hardening a two-armed condition on the arm
// somebody happened to drive. So the drive lives here.
//
// TWO CELLS, TWO INDEPENDENT MECHANISMS:
//
//   (A2) NO presentation port bound, a real confirm bound — the shipped pre-fix `ask` shape. The
//        route must REFUSE at the displayability precondition: the confirm spy is never called, the
//        turn fails closed carrying the fixed refusal sentence, and the proposal stays filed
//        exactly once so nothing a person asked for is lost. This is Task 1's mechanism
//        (`turn-engine.ts`'s precondition) measured through the production composition.
//
//   (A1) The presentation port BOUND to a recorder, the confirm answering yes — the guard-ACCEPTS
//        control. The render must reach the surface BEFORE the confirm's first call and the turn
//        must proceed. This is Task 2's mechanism (`ask.ts`'s `chatPresent` binding) plus the proof
//        that Task 1's precondition does not OVER-REFUSE a bound, healthy present.
//
// WHY BOTH IN ONE FILE. They are the two halves of one sentence — "present, then confirm, then
// apply" — and a reader who finds only the refusal cannot tell a route that refuses correctly from
// a route that refuses always. The control is what makes the refusal a divergence this file
// produced rather than a road nobody travels.
//
// THE PLANNER IS SCRIPTED AND THE REST IS PRODUCTION'S. Everything between the utterance and the
// terminal is the shipped composition; what is substituted is the LLM's willingness to emit the
// `write_test` clause, which is the same nondeterminism SC-5's own live lane lives with. Nothing
// here asserts what a model WOULD emit — the claim is about what the route does with a clause.

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
// safety publishes no confirm port; the shape an old host bound is spelled
// locally so the spies below can still be smuggled in and shown never to be called.
interface ConfirmPort {
  readonly surface: 'tty-prompt'
  readonly ask: (action: unknown) => boolean
}

const CONFIG_FILE = 'agent-qa.config.yaml'

/** The utterance the round-4 verification drove, verbatim. */
const UTTERANCE = 'write a test for booking.com checkout'

/**
 * A configuration that declares an LLM and NO TARGETS — SC-5's serving class.
 *
 * A project able to hold a conversation at all is a project that HAS a config file, because
 * `resolveCliChatCapabilities` reads the chat model out of `registry.llms`. Zero targets is what
 * puts the utterance on the from-zero road.
 */
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
  // COMMITTED, never merely written: the scaffold re-reads the committed set at proposal time
  // so a dirty fixture would measure D-05's two-commit road instead of this one.
  writeFileSync(configPath, ZERO_TARGET_CONFIG)
  // 2026-10-14 (441-06, E3): ask refuses a project whose secrets file is missing.
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
      // THE SHIPPED PRE-FIX SHAPE, EXACTLY. `ask.ts` bound no `chatPresent` and passed no confirm,
      // so `composeCliLocalAgent` supplied `createTtyConfirmPort()` — a real prompt a person can
      // answer. Here the confirm is a SPY standing in for that prompt and nothing else is
      // substituted: the same registry, the same route, the same op, the same durable store.
      const planner = scriptedWriteTestPlanner()
      const ask = vi.fn((_action: unknown) => true)
      const confirm: ConfirmPort = { surface: 'tty-prompt', ask }
      const host = composeCliLocalAgent({
        agentQaRoot,
        configPath,
        // the input declares no confirm; the spy is smuggled past the type.
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

      // NO PROMPT ABOUT THE CONFIGURATION. There is no apply verb to be asked about;
      // whatever the gate still asks until 432-13 removes it, none of it names a config op.
      const askedAbout = ask.mock.calls.map((call) => JSON.stringify(call))
      expect(askedAbout.filter((asked) => asked.includes('config.'))).toEqual([])

      // THE CONFIG WAS WRITTEN AND THE TURN WENT ON TO AUTHOR against it; nothing was filed.
      expect(configuredBooking()).toBe(true)
      expect(result.status).not.toBe('fail_closed')
      expect(filedProposals()).toHaveLength(0)
    })

  it('with the port bound the change is RENDERED once it is written, and nothing asks for it',
    async () => {
      // THE GUARD-ACCEPTS CONTROL, and it carries two claims at once.
      //
      // FIRST, TASK 1's PRECONDITION DOES NOT OVER-REFUSE. A route that refused always would satisfy
      // (A2) perfectly and destroy the feature; this cell is what makes (A2)'s refusal a divergence
      // rather than a constant. Same composition, same utterance, same op — one binding different.
      //
      // SECOND, TASK 2's BINDING PUTS THE RENDER IN THE RIGHT PLACE. `ask.ts` now hands
      // `composeCliLocalAgent` a `chatPresent` writing to `process.stdout`, which is the stream
      // `createTtyConfirmPort` prompts on; here that writer is a recorder and the prompt is a spy,
      // and BOTH APPEND TO ONE ORDERED LIST. The ordering claim is read off that shared list rather
      // than inferred from two independent counters — a render that arrived after the commit would
      // satisfy neither half of "reviewable binds at approval time".
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
        // the input declares no confirm; the spy is smuggled past the type.
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

      // THE RENDER HAPPENED, EXACTLY ONCE, FIRST, AND AFTER THE WRITE: at the moment the receipt
      // reached the surface, the configuration it describes was already on disk. Nothing asked
      // before it.
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

      // AND THE TURN PROCEEDED: the far end of SC-5's sentence — authoring runs against the project
      // the person just configured, and the configuration really is on disk.
      expect(result.status).not.toBe('fail_closed')
      expect(filedProposals()).toHaveLength(0)
    })
})
