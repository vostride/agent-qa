// The scaffold writes in its own call, so no confirm or apply verb sits between it and authoring.

import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { describe, expect, it } from 'vitest'

import {
  CROSS_BOUNDARY_REASONS,
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  utf8Decode,
  utf8Encode,
} from '@vostride/agent-qa-schema'
import type {
  AgentAskInput,
  AgentAskResult,
  ChatSessionEvent,
  ChatSessionHandle,
  ChatSessionHeader,
  FunctionCaller,
  SessionLogPort,
} from '@vostride/agent-qa-schema'

import type {
  ConfigFilesPortLike,
  ConfigPathFacts,
  ConfigScaffoldContentPortLike,
  ConfigValidatePortLike,
  ConfigWritePortLike,
} from '../../config-mutation/ports.js'
import { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from '../../functions/ops/authoring-draft-write.js'
import {
  CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
  configProjectScaffoldSpec,
} from '../../functions/ops/config-project-scaffold.js'
// An id no registry holds, so the cells pin that the scaffold route never dispatches it.
const CONFIG_PROPOSAL_APPLY_FUNCTION_ID = 'config.proposal.apply'
import {
  WRITE_TEST_UNCONFIGURED_DETAIL,
  resolveWriteTestRoute,
} from '../../config-mutation/write-test-route.js'
import { CHAT_RESOLVER_TABLE } from '../resolver-table.js'
import { deterministicOverrideStrategy } from '../reconcile.js'
import { splitClauses } from '../clause-split.js'
import { createTurnEngine } from '../turn-engine.js'
import type { TurnEngineDeps } from '../turn-engine.js'
import { toToolName } from '../tool-names.js'
import type { ChatBindingStage, PlannerStagePort } from '../ports.js'

const PLANNER_CALLER: FunctionCaller = {
  surface: 'chat',
  origin: 'agent',
}

function memoryLog(): SessionLogPort & { readonly events: ChatSessionEvent[] } {
  const events: ChatSessionEvent[] = []
  const header: ChatSessionHeader = {
    schemaVersion: CURRENT_CHAT_SESSION_SCHEMA_VERSION,
    sessionId: 'scaffold-route-session',
    createdAt: '1970-01-01T00:00:00.000Z',
    model: 'unbound',
    toolsetHash: 'hash-0',
  }
  return {
    events,
    open(): Promise<ChatSessionHandle> {
      return Promise.resolve({
        header,
        events: [...events],
        refusedLines: [],
        append(event: ChatSessionEvent): Promise<void> {
          events.push(event)
          return Promise.resolve()
        },
        turnBoundary: () => Promise.resolve(),
        close: () => Promise.resolve(),
      })
    },
  }
}

interface Harness {
  readonly ordering: string[]
  readonly inputs: { functionId: string; input: unknown }[]
  // Renders snapshot `ordering` rather than push into it, so `ordering` records invocations only.
  readonly presented: { text: string; orderingAtRender: string[] }[]
  /**
   * What each invocation RESOLVED to.
   *
   * So a cell can compare a rendered surface against the op's OWN answer rather than against a copy
   * of the fixture — the difference between measuring that this proposal was shown and measuring
   * that something with the right shape was.
   */
  readonly answers: { functionId: string; answer: unknown }[]
  // A fixed turn id and a counting clock make two runs of one road write byte-identical streams.
  readonly events: ChatSessionEvent[]
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}

// The real scaffold spec over in-memory ports; two are doubles agent cannot import.

const SCAFFOLD_CONFIG_FILE = 'agent-qa.config.yaml'
const SCAFFOLD_HOOKS_FILE = 'hooks.yaml'
const SCAFFOLD_GITIGNORE = '.gitignore'

// A project that declares a model, so it can chat, and declares no target to test against.
const ZERO_TARGET_CONFIG = `# this project's own configuration

workspace:
  hooksFile: hooks.yaml

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra

use:
  llm: judge
`

const SEEDED_GITIGNORE = '# the project\'s own rules\ndist/\n'

/**
 * The document's SHAPE at each path, spelled as `createConfigFilesPort` spells it.
 *
 * NAMES AND NEVER VALUES, which is `ConfigPathFacts`' own contract: a port that answered what is AT
 * a path would be the unmasked config reader reached through the back door of a mutation helper.
 */
function inspectFacts(configText: string, paths: readonly string[]): readonly ConfigPathFacts[] {
  const document = parseDocument(configText)
  return paths.map((path) => {
    const node = document.getIn(path.split('.'), true)
    if (node === undefined || node === null) return { path, present: false }
    if (isSeq(node)) {
      return { path, present: true, kind: 'sequence' as const, length: node.items.length }
    }
    if (isMap(node)) {
      return {
        path,
        present: true,
        kind: 'map' as const,
        keys: node.items.map((item) => String(isScalar(item.key) ? item.key.value : item.key)),
      }
    }
    return { path, present: true, kind: 'scalar' as const }
  })
}

/** One publication the direct writer received: the files, by path. */
interface Published {
  readonly paths: readonly string[]
}

interface ScaffoldOpFixture {
  readonly deps: Parameters<typeof configProjectScaffoldSpec.invoke>[1]
  /** Every publication the REAL op made, so a cell reads what it actually wrote. */
  readonly published: Published[]
}

function scaffoldOpFixture(options: {
  /** The committed configuration, or absent for a project that has none at all. */
  readonly configText?: string
  /** The committed hooks file, or absent when the project has none. */
  readonly hooksText?: string
} = {}): ScaffoldOpFixture {
  const published: Published[] = []

  const configFiles: ConfigFilesPortLike = {
    read: () => Promise.resolve({
      configFile: SCAFFOLD_CONFIG_FILE,
      hooksFile: SCAFFOLD_HOOKS_FILE,
      files: [
        { path: SCAFFOLD_GITIGNORE, bytes: utf8Encode(SEEDED_GITIGNORE) },
        options.configText === undefined
          ? { path: SCAFFOLD_CONFIG_FILE }
          : { path: SCAFFOLD_CONFIG_FILE, bytes: utf8Encode(options.configText) },
        options.hooksText === undefined
          ? { path: SCAFFOLD_HOOKS_FILE }
          : { path: SCAFFOLD_HOOKS_FILE, bytes: utf8Encode(options.hooksText) },
      ],
    }),
    inspect: ({ bytes, paths }) => Promise.resolve(
      inspectFacts(bytes === undefined ? '' : utf8Decode(bytes), paths),
    ),
    setField: () => Promise.reject(new Error('the scaffold performs no field edit')),
    mintHookId: () => 'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper',
  }

  const configValidate: ConfigValidatePortLike = {
    validate: () => Promise.resolve({ ok: true }),
  }

  // FAITHFUL TO THE TWO MODES THE ONE PRODUCER HAS: a whole configuration when the project has
  // none, and the person's own bytes with exactly one target entry inserted when it has one that
  // declares no targets. A hooks file that already exists is left out of the answer entirely.
  const scaffoldContent: ConfigScaffoldContentPortLike = {
    render: (input) => {
      const merged = input.existingConfig === undefined
        ? `registry:\n  targets:\n    ${input.targetName}:\n`
          + `      platform: web\n      url: ${input.baseUrl}\n`
        : (() => {
            const document = parseDocument(utf8Decode(input.existingConfig.bytes))
            document.setIn(
              ['registry', 'targets', input.targetName],
              { platform: 'web', url: input.baseUrl },
            )
            return document.toString()
          })()
      const hooksPresent = input.existingConfig?.hooksPresent ?? false
      return Promise.resolve([
        {
          path: input.existingConfig?.path ?? SCAFFOLD_CONFIG_FILE,
          bytes: utf8Encode(merged),
        },
        ...(hooksPresent
          ? []
          : [{
            path: input.existingConfig?.hooksPath ?? SCAFFOLD_HOOKS_FILE,
            bytes: utf8Encode('hooks: []\n'),
          }]),
        {
          path: SCAFFOLD_GITIGNORE,
          bytes: utf8Encode(
            `${input.existingGitignore === undefined ? '' : utf8Decode(input.existingGitignore)}`
            + '# agent-qa init:start\n# agent-qa init:end\n',
          ),
        },
      ])
    },
  }

  const configWrite: ConfigWritePortLike = {
    applyFields: () => Promise.reject(new Error('the scaffold publishes whole files')),
    publishFiles: ({ files }) => {
      published.push({ paths: files.map((file) => file.path) })
      return Promise.resolve({ kind: 'published' as const, written: files.map((file) => file.path) })
    },
  }

  return {
    deps: {
      configFiles,
      configValidate,
      configWrite,
      scaffoldContent,
    } as Parameters<typeof configProjectScaffoldSpec.invoke>[1],
    published,
  }
}

// Hoisted so a cell can assert the refusal sentence does not carry the port's error.
const PRESENT_FAILURE_ERROR = 'the pipe closed'

function harness(options: {
  // Absent means the dep is not bound at all.
  readonly targets?: readonly string[]
  readonly scaffoldAnswer?: unknown
  // The ordering cell depends on what the scaffold answers, so it runs the real spec.
  readonly realScaffold?: ScaffoldOpFixture
  // A flag rather than a second harness, so headless and bound hosts run the same assembly.
  readonly noPresent?: boolean
  // Each failing arm records first, so a broken surface differs from one never reached.
  readonly presentFailure?: 'throws' | 'rejects'
} = {}): Harness {
  const ordering: string[] = []
  const inputs: { functionId: string; input: unknown }[] = []
  const presented: { text: string; orderingAtRender: string[] }[] = []
  const answers: { functionId: string; answer: unknown }[] = []
  let clock = 0

  // The planner is what turns a free-text utterance into an `authoring.draft.write` call — the same
  // path production takes, because `write_test` is not in the deterministic resolver table.
  const planner: PlannerStagePort = {
    plan: ({ clauses }) => Promise.resolve({
      toolCalls: clauses.map((clause) => ({
        toolName: toToolName(AUTHORING_DRAFT_WRITE_FUNCTION_ID),
        input: { intent: clause.text },
      })),
    }),
  }

  // What each seat answers, hoisted out of the recorder below so that recorder stays ONE shape:
  // record the call, resolve the answer, record the answer.
  const answerFor = (functionId: string, input: unknown): Promise<unknown> => {
    if (functionId === CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID) {
      if (options.realScaffold !== undefined) {
        return configProjectScaffoldSpec.invoke(
          input as { readonly domain: string },
          options.realScaffold.deps,
        ) as Promise<unknown>
      }
      return Promise.resolve(options.scaffoldAnswer ?? {
        outcome: 'applied',
        summaryLine: 'configure this project for https://booking.com as target booking-com',
        files: ['.gitignore', 'agent-qa.config.yaml', 'hooks.yaml'],
        fields: ['registry.targets.booking-com.platform', 'registry.targets.booking-com.url'],
        crossBoundary: true,
        crossBoundaryReasons: ['new-origin'],
        shownDiff: '--- /dev/null\n+++ b/agent-qa.config.yaml\n',
      })
    }
    return Promise.resolve({ ok: true })
  }

  // CAPTURED rather than constructed inline, so the stream this run wrote can be read back off the
  // Harness. Nothing about the binding changes: the same instance is handed to the same dep.
  const sessionLog = memoryLog()

  const deps: TurnEngineDeps = {
    table: CHAT_RESOLVER_TABLE,
    split: splitClauses,
    reconcile: deterministicOverrideStrategy,
    sessionLog,
    mint: {
      forStage: (_stage: ChatBindingStage): FunctionCaller => PLANNER_CALLER,
    },
    invoke: async (functionId, input) => {
      ordering.push(functionId)
      inputs.push({ functionId, input })
      const answer = await answerFor(functionId, input)
      answers.push({ functionId, answer })
      // The envelope carries the legacy verdict, because the route reads only the payload.
      return { payload: answer, verdict: { status: 'executed' as const, outcome: '' }, foldLines: [] }
    },
    planner,
    ...(options.noPresent === true
      ? {}
      : {
        present: (text: string) => {
          presented.push({ text, orderingAtRender: [...ordering] })
          // RECORD, THEN FAIL. The attempt is the thing a cell needs to see; a double that failed
          // before recording would make "bound and broken" indistinguishable from "never reached".
          if (options.presentFailure === 'throws') throw new Error(PRESENT_FAILURE_ERROR)
          if (options.presentFailure === 'rejects') {
            return Promise.reject(new Error(PRESENT_FAILURE_ERROR))
          }
          return undefined
        },
      }),
    ...(options.targets === undefined
      ? {}
      : { configuredTargets: () => Promise.resolve(options.targets as readonly string[]) }),
    now: () => {
      clock += 1
      return `1970-01-01T00:00:0${String(clock % 10)}.000Z`
    },
    mintTurnId: () => 'turn-fixed',
  }

  const engine = createTurnEngine(deps)
  return {
    ordering,
    inputs,
    presented,
    answers,
    events: sessionLog.events,
    runTurn: (input) => engine.runTurn(input),
  }
}

describe('the write_test route is deterministic and narrow', () => {
  it('routes a configured target name, a hostname, and neither — by TOKEN, never by substring', () => {
    expect(resolveWriteTestRoute({
      intent: 'write a test for the checkout on shop',
      configuredTargetNames: ['shop', 'admin'],
    })).toEqual({ kind: 'configured', name: 'shop' })

    // `workshop` CONTAINS `shop`. A substring match would configure the wrong project.
    expect(resolveWriteTestRoute({
      intent: 'write a test for the workshop booking page',
      configuredTargetNames: ['shop'],
    })).toEqual({ kind: 'passthrough' })

    expect(resolveWriteTestRoute({
      intent: 'write a test for booking.com',
      configuredTargetNames: [],
    })).toEqual({ kind: 'scaffold', domain: 'booking.com', targetName: 'booking-com' })

    // The hostname's DERIVED name is already configured — that is the target they have, spelled as
    // a domain, and routing it to a scaffold would send them to `already-configured` for nothing.
    expect(resolveWriteTestRoute({
      intent: 'write a test for booking.com',
      configuredTargetNames: ['booking-com'],
    })).toEqual({ kind: 'configured', name: 'booking-com' })
  })

  it('never offers the scaffold in a project that already declares targets', () => {
    // `readme.md` and `index.html` parse as hostnames, so the scaffold precondition is the project.
    for (const intent of [
      'write a test that checks the readme.md rendering',
      'write a test for the index.html landing page',
      'write a test for booking.com checkout',
    ]) {
      expect(resolveWriteTestRoute({ intent, configuredTargetNames: ['shop'] }), intent)
        .toEqual({ kind: 'passthrough' })
    }

    // The same tokens in a project that declares nothing still reach the scaffold.
    expect(resolveWriteTestRoute({
      intent: 'write a test that checks the readme.md rendering',
      configuredTargetNames: [],
    })).toEqual({ kind: 'scaffold', domain: 'readme.md', targetName: 'readme-md' })
  })

  it('REFUSES only a project with no targets and an utterance with no hostname', () => {
    // The rejection corpus. Every row is a real write_test request; the only ones that refuse are
    // the ones with nothing at all to author against.
    for (const intent of [
      'write a test for the checkout flow',
      'write a test that logs in and buys something',
      'write a test for not_a_domain.x',
      'write a test for the shop',
    ]) {
      expect(resolveWriteTestRoute({ intent, configuredTargetNames: [] }), intent)
        .toEqual({ kind: 'refuse' })
    }

    // THE SAME UTTERANCES IN A CONFIGURED PROJECT PASS THROUGH. This is the half that stops the
    // refusal from being a rule about wording: the precondition is the PROJECT.
    for (const intent of [
      'write a test for the checkout flow',
      'write a test that logs in and buys something',
    ]) {
      expect(resolveWriteTestRoute({ intent, configuredTargetNames: ['shop'] }), intent)
        .toEqual({ kind: 'passthrough' })
    }
  })
})

describe('one turn: detect, scaffold, author', () => {
  it('dispatches authoring untouched for an ordinary request in a configured project', async () => {
    const test = harness({ targets: ['shop'] })
    const result = await test.runTurn({ message: 'write a test for the login flow' })

    expect(result.status).toBe('completed')
    // EXACTLY ONE invocation, and it is the authoring one. A route that intercepted here would add
    // a scaffold to this list and fail by count rather than by message.
    expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
  })

  it('does not scaffold a target the project already declares', async () => {
    const test = harness({ targets: ['booking-com'] })
    await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
  })

  it('scaffolds through the REAL op, which writes in its own call, and authors AFTER it', async () => {
    // No configured targets, so the real scaffold op decides its own answer.
    const scaffoldOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
    const test = harness({ targets: [], realScaffold: scaffoldOp })
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('completed')
    // The op really WROTE, once, and what it wrote is the merge: the person's configuration beside
    // the two files this project does not have. Read off the writer rather than off the turn, so a
    // chain that completed on some other answer cannot satisfy it.
    expect(scaffoldOp.published).toHaveLength(1)
    expect([...(scaffoldOp.published[0]?.paths ?? [])].sort())
      .toEqual(['.gitignore', 'agent-qa.config.yaml', 'hooks.yaml'])
    // The order is the claim: the scaffold, then authoring against the new target, nothing between.
    expect(test.ordering).toEqual([
      CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
    ])
    expect(test.ordering).not.toContain(CONFIG_PROPOSAL_APPLY_FUNCTION_ID)
    // The domain handed to the scaffold is the one the gate derived from the utterance.
    expect(test.inputs[0]?.input).toEqual({ domain: 'booking.com' })
    // The receipt names what was written, in the op's own file list.
    const receipt = test.events.find((event) =>
      event.kind === 'clause_receipt'
      && (event as { functionId: string }).functionId === CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID) as
      { status: string; outcome: string } | undefined
    expect(receipt?.status).toBe('executed')
    expect(receipt?.outcome).toMatch(/^applied: /)
    for (const path of ['.gitignore', 'agent-qa.config.yaml', 'hooks.yaml']) {
      expect(receipt?.outcome, path).toContain(path)
    }
  })

  it('authors NOTHING when the scaffold\'s write stopped part way, and says where', async () => {
    // The chain stops after the scaffold only when the scaffold did not finish writing.
    const detail = 'wrote .gitignore, then stopped: agent-qa.config.yaml changed after this call read '
      + 'it, and hooks.yaml was not reached. Nothing was rolled back; the written files hold the new bytes.'
    const test = harness({
      targets: [],
      scaffoldAnswer: {
        outcome: 'interrupted',
        summaryLine: 'configure this project for https://booking.com as target booking-com',
        written: ['.gitignore'],
        failed: { path: 'agent-qa.config.yaml', reason: 'file-changed' },
        unwritten: ['hooks.yaml'],
        detail,
      },
    })
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('fail_closed')
    expect(test.ordering).toEqual([CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID])
    expect(test.ordering).not.toContain(AUTHORING_DRAFT_WRITE_FUNCTION_ID)
    // The answer is the scaffold's own account of what it wrote, carried through verbatim.
    expect(result.unhandled?.reason).toBe(detail)
    // Nothing was rendered as a receipt of a change that did not complete.
    expect(test.presented).toEqual([])
  })

  it('refuses an unconfigured project with no hostname, and invokes nothing at all', async () => {
    const test = harness({ targets: [] })
    const result = await test.runTurn({ message: 'write a test for the checkout flow' })

    expect(result.status).toBe('fail_closed')
    // The refusal precedes every effect, so not even the scaffold runs.
    expect(test.ordering).toEqual([])
    expect(result.unhandled?.reason).toBe(WRITE_TEST_UNCONFIGURED_DETAIL)
    // It asks for the two things a person can supply, and does NOT hand their own words back as a
    // candidate origin. The presence halves above are what make this absence non-vacuous.
    expect(result.unhandled?.reason).toContain('write a test for example.com')
    expect(result.unhandled?.reason).not.toContain('checkout')
  })

  it('reports the scaffold\'s own refusal and dispatches nothing', async () => {
    // `unrenderable-diff` is reachable from zero targets via a non-UTF-8 `.gitignore`.
    const test = harness({
      targets: [],
      scaffoldAnswer: {
        outcome: 'refused',
        reason: 'unrenderable-diff',
        detail: '.gitignore holds bytes that are not valid UTF-8',
      },
    })
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('fail_closed')
    expect(test.ordering).toEqual([CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID])
    expect(result.unhandled?.reason).toBe('.gitignore holds bytes that are not valid UTF-8')
  })

  // Every blocked or no-change scaffold answers with its own reason.
  it('a schema-blocked scaffold says the result would not be valid, with the issue',
    async () => {
      const test = harness({
        targets: [],
        scaffoldAnswer: {
          outcome: 'blocked',
          summaryLine: 'configure this project for https://booking.com as target booking-com — blocked: '
            + 'the resulting configuration is not valid',
          blockedReason: 'schema-fail',
          paths: ['agent-qa.config.yaml'],
          validationIssues: ['agent-qa.config.yaml: use.timeout: Expected string'],
        },
      })
      const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

      expect(result.status).toBe('fail_closed')
      const reason = result.unhandled?.reason ?? ''
      expect(reason).toContain('not valid')
      expect(reason).toContain('agent-qa.config.yaml: use.timeout: Expected string')
      expect(reason).not.toContain('Name the site')
    })

  it('a no-change scaffold says the configuration already holds it', async () => {
    const test = harness({
      targets: [],
      scaffoldAnswer: { outcome: 'no-change', path: 'configure this project for https://booking.com' },
    })
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('fail_closed')
    const reason = result.unhandled?.reason ?? ''
    expect(reason).toContain('already holds')
    expect(reason).toContain('nothing was written')
    expect(reason).not.toContain('Name the site')
  })

  it('the unconfigured refusal promises no review step', () => {
    expect(WRITE_TEST_UNCONFIGURED_DETAIL).not.toMatch(/review/i)
    expect(WRITE_TEST_UNCONFIGURED_DETAIL).toContain('write the configuration')
    expect(WRITE_TEST_UNCONFIGURED_DETAIL).toContain('write a test for example.com')
  })

  it('passes a hostname-shaped NON-SITE token through in a configured project',
    async () => {
      // Without the from-zero precondition, `readme.md` would scaffold a target for `readme-md`.
      const scaffoldOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const test = harness({ targets: ['shop'], realScaffold: scaffoldOp })
      const message = 'write a test that checks the readme.md rendering'
      const result = await test.runTurn({ message })

      expect(result.status).toBe('completed')
      // The reference dispatch comes from a host that binds no vocabulary, so the route never runs.
      const unrouted = harness()
      await unrouted.runTurn({ message })
      expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
      expect(test.inputs).toEqual(unrouted.inputs)
      expect(test.inputs).toHaveLength(1)
      expect((test.inputs[0]?.input as { intent?: string }).intent).toBe(message)
      // And the scaffold op was never reached at all, so nothing was written on the way past.
      expect(scaffoldOp.published).toHaveLength(0)
    })

  it('ONE utterance, TWO project classes: zero targets scaffolds, one target passes through',
    async () => {
      // The same words against both project classes, so the decision is a property of the project.
      const message = 'write a test for booking.com checkout'

      const fromZero = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const zero = harness({ targets: [], realScaffold: fromZero })
      const zeroResult = await zero.runTurn({ message })
      expect(zeroResult.status).toBe('completed')
      expect(zero.ordering).toEqual([
        CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
        AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      ])
      expect(fromZero.published).toHaveLength(1)

      const configuredOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const configured = harness({ targets: ['shop'], realScaffold: configuredOp })
      const configuredResult = await configured.runTurn({ message })
      expect(configuredResult.status).toBe('completed')
      expect(configured.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
      expect(configuredOp.published).toHaveLength(0)
    })

  it('renders THIS change — summary, files, true diff — AFTER the scaffold wrote it and BEFORE authoring',
    async () => {
      // The render is a receipt of a change on disk, shown once before authoring uses it.
      const scaffoldOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const test = harness({ targets: [], realScaffold: scaffoldOp })
      const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

      expect(result.status).toBe('completed')
      expect(test.ordering).toEqual([
        CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
        AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      ])

      // EXACTLY ONE render.
      expect(test.presented).toHaveLength(1)
      const render = test.presented[0]

      // THE ORDERING, read off the snapshot taken AT RENDER TIME: the scaffold had written and the
      // authoring dispatch had not started.
      expect(render?.orderingAtRender).toEqual([CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID])

      // THE CONTENT IS THIS CHANGE'S, taken from the op's OWN resolved answer.
      const answer = test.answers.find(
        (row) => row.functionId === CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
      )?.answer as {
        readonly outcome: string
        readonly summaryLine: string
        readonly files: readonly string[]
        readonly shownDiff: string
        readonly crossBoundary: boolean
        readonly crossBoundaryReasons: readonly string[]
      }
      expect(answer.outcome).toBe('applied')
      expect(render?.text).toContain(answer.summaryLine)
      expect(answer.files.length).toBeGreaterThan(0)
      for (const path of answer.files) expect(render?.text, path).toContain(path)

      // THE TRUE `shownDiff`, BYTE FOR BYTE AND UNTRUNCATED — never a re-derivation.
      expect(answer.shownDiff).toContain(SCAFFOLD_CONFIG_FILE)
      expect(answer.shownDiff.split('\n').length).toBeGreaterThan(3)
      expect(render?.text).toContain(answer.shownDiff)
      expect(render?.text.endsWith(answer.shownDiff)).toBe(true)

      // AND THE RENDER IS EXACTLY THE DECLARED PARTS, in order, with nothing invented on the way to
      // the person: the boundary line, the summary, the files, the diff.
      const boundaryLine = 'CROSSES A TRUST BOUNDARY — crossBoundary: true; '
        + `crossBoundaryReasons: ${answer.crossBoundaryReasons.join(', ')}`
      expect(answer.crossBoundary).toBe(true)
      expect(render?.text)
        .toBe([boundaryLine, answer.summaryLine, ...answer.files, answer.shownDiff].join('\n'))
    })

  it('an UNBOUND present does not stop the route: the change is written and authoring follows',
    async () => {
      // A host with no surface logs the receipt and authors, as a host with one does.
      const scaffoldOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const test = harness({ targets: [], realScaffold: scaffoldOp, noPresent: true })
      const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

      expect(test.presented).toEqual([])
      expect(result.status).toBe('completed')
      expect(test.ordering).toEqual([
        CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
        AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      ])
      expect(test.ordering).not.toContain(CONFIG_PROPOSAL_APPLY_FUNCTION_ID)
      expect(scaffoldOp.published).toHaveLength(1)

      // THE SESSION RECORD CARRIES THE RECEIPT: the scaffold's, naming the files it wrote, then the
      // authoring dispatch's.
      const receipted = test.events
        .filter((event) => event.kind === 'clause_receipt')
        .map((event) => (event as { functionId: string }).functionId)
      expect(receipted).toContain(CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID)
      expect(receipted).toContain(AUTHORING_DRAFT_WRITE_FUNCTION_ID)
      expect(receipted).not.toContain(CONFIG_PROPOSAL_APPLY_FUNCTION_ID)
    })

  // An `applied` answer naming no file stops the turn; display fields render only when present.

  /** The stub producer's applied answer, minus whichever field a cell is measuring. */
  const DISPLAYABLE_ANSWER = {
    outcome: 'applied',
    summaryLine: 'configure this project for https://booking.com as target booking-com',
    files: ['.gitignore', 'agent-qa.config.yaml', 'hooks.yaml'],
    fields: ['registry.targets.booking-com.platform', 'registry.targets.booking-com.url'],
    crossBoundary: true,
    crossBoundaryReasons: ['new-origin'],
    shownDiff: '--- /dev/null\n+++ b/agent-qa.config.yaml\n',
  } as const

  /** A receipt missing a display field still renders the rest and the turn authors. */
  async function expectReceiptWithout(scaffoldAnswer: Record<string, unknown>): Promise<string> {
    const test = harness({ targets: [], scaffoldAnswer })
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('completed')
    expect(test.ordering).toEqual([
      CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
      AUTHORING_DRAFT_WRITE_FUNCTION_ID,
    ])
    expect(test.presented).toHaveLength(1)
    const text = test.presented[0]?.text ?? ''
    for (const path of DISPLAYABLE_ANSWER.files) expect(text, path).toContain(path)
    // No blank line stands in for the missing part (the diff's own trailing newline aside).
    expect(text.startsWith('\n')).toBe(false)
    expect(text).not.toContain('\n\n')
    return text
  }

  it('a receipt with NO summary line renders the rest, and the turn authors', async () => {
    const { summaryLine: _summaryLine, ...withoutSummary } = DISPLAYABLE_ANSWER
    const text = await expectReceiptWithout(withoutSummary)
    expect(text).not.toContain(DISPLAYABLE_ANSWER.summaryLine)
  })

  it('an answer with NO file list wrote nothing to author against, so the turn stops', async () => {
    const { files: _files, ...withoutFiles } = DISPLAYABLE_ANSWER
    const test = harness({ targets: [], scaffoldAnswer: withoutFiles })
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('fail_closed')
    expect(test.ordering).toEqual([CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID])
    expect(test.presented).toEqual([])
    expect(result.unhandled?.reason).toContain('without naming a file it wrote')
    expect(result.unhandled?.reason).not.toBe(WRITE_TEST_UNCONFIGURED_DETAIL)
  })

  it('a receipt with NO rendered diff renders the rest, and the turn authors', async () => {
    const { shownDiff: _shownDiff, ...withoutDiff } = DISPLAYABLE_ANSWER
    const text = await expectReceiptWithout(withoutDiff)
    expect(text).not.toContain('+++ b/')
  })

  it('an EMPTY rendered diff adds no blank line to the receipt', async () => {
    const text = await expectReceiptWithout({ ...DISPLAYABLE_ANSWER, shownDiff: '' })
    expect(text).toContain(DISPLAYABLE_ANSWER.summaryLine)
    // The receipt ends with the last file: the empty diff contributed no line at all.
    expect(text.endsWith('hooks.yaml')).toBe(true)
  })

  it('a present that THROWS does not decide the turn: the change is written and authoring follows',
    async () => {
      // A broken render port does not refuse the turn: healthy and broken runs dispatch the same.
      const message = 'write a test for booking.com checkout'

      const healthyOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const healthy = harness({ targets: [], realScaffold: healthyOp })
      const healthyResult = await healthy.runTurn({ message })
      expect(healthyResult.status).toBe('completed')

      const brokenOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const broken = harness({
        targets: [], realScaffold: brokenOp, presentFailure: 'throws',
      })
      const brokenResult = await broken.runTurn({ message })

      // The render was attempted exactly once, after the scaffold.
      expect(broken.presented).toHaveLength(1)
      expect(broken.presented[0]?.orderingAtRender)
        .toEqual([CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID])

      expect(brokenResult.status).toBe('completed')
      expect(broken.ordering).toEqual(healthy.ordering)
      expect(broken.ordering).toEqual([
        CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
        AUTHORING_DRAFT_WRITE_FUNCTION_ID,
      ])
      expect(brokenOp.published).toHaveLength(1)
      // The broken port gains no voice in the turn: its error reaches no result and no event.
      expect(JSON.stringify(brokenResult)).not.toContain(PRESENT_FAILURE_ERROR)
      expect(JSON.stringify(broken.events)).not.toContain(PRESENT_FAILURE_ERROR)
    })

  it('a present that REJECTS does not decide it either — the port type\'s other arm',
    async () => {
      // The twin over `Promise<void>`: one await covers both arms of the port's type.
      const message = 'write a test for booking.com checkout'

      const healthyOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const healthy = harness({ targets: [], realScaffold: healthyOp })
      const healthyResult = await healthy.runTurn({ message })
      expect(healthyResult.status).toBe('completed')

      const brokenOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const broken = harness({
        targets: [], realScaffold: brokenOp, presentFailure: 'rejects',
      })
      const brokenResult = await broken.runTurn({ message })

      expect(broken.presented).toHaveLength(1)
      expect(broken.presented[0]?.orderingAtRender)
        .toEqual([CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID])

      expect(brokenResult.status).toBe('completed')
      expect(broken.ordering).toEqual(healthy.ordering)
      expect(brokenOp.published).toHaveLength(1)
      expect(JSON.stringify(brokenResult)).not.toContain(PRESENT_FAILURE_ERROR)
      expect(JSON.stringify(broken.events)).not.toContain(PRESENT_FAILURE_ERROR)
    })


  // The receipt repeats the op's two fields saying whether the change crosses a trust boundary.

  it('tells the person the change CROSSES A BOUNDARY, and why, above the rest of the receipt',
    async () => {
      // THE REAL OP ANSWERS IT (produced-not-literal). A scaffold writes a target that did not
      // exist, so the classifier's own verdict is `new-origin`.
      const scaffoldOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const test = harness({ targets: [], realScaffold: scaffoldOp })
      const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

      expect(result.status).toBe('completed')
      expect(test.presented).toHaveLength(1)
      const render = test.presented[0]

      // Before the authoring dispatch builds on the change.
      expect(render?.orderingAtRender).not.toContain(AUTHORING_DRAFT_WRITE_FUNCTION_ID)

      const answer = test.answers.find(
        (row) => row.functionId === CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID,
      )?.answer as {
        readonly outcome: string
        readonly crossBoundary: boolean
        readonly crossBoundaryReasons: readonly string[]
        readonly summaryLine: string
      }
      expect(answer.outcome).toBe('applied')
      expect(answer.crossBoundary).toBe(true)
      expect(answer.crossBoundaryReasons.length).toBeGreaterThan(0)

      // BOTH FIELDS, IN THE BYTES THE PERSON READS, every reason VERBATIM off the answer.
      expect(render?.text).toContain('crossBoundary: true')
      expect(render?.text).toContain('crossBoundaryReasons:')
      for (const reason of answer.crossBoundaryReasons) {
        expect(render?.text, reason).toContain(reason)
      }

      // ABOVE THE REST OF THE JOIN.
      const boundaryAt = render?.text.indexOf('crossBoundary: true') ?? -1
      const summaryAt = render?.text.indexOf(answer.summaryLine) ?? -1
      expect(boundaryAt).toBeGreaterThanOrEqual(0)
      expect(summaryAt).toBeGreaterThan(boundaryAt)
    })

  it('adds NO boundary line to a change that crosses none — the common path stays quiet',
    async () => {
      const test = harness({
        targets: [],
        scaffoldAnswer: { ...DISPLAYABLE_ANSWER, crossBoundary: false, crossBoundaryReasons: [] },
      })
      const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

      expect(result.status).toBe('completed')
      expect(test.presented).toHaveLength(1)
      const text = test.presented[0]?.text ?? ''

      // NOT A SINGLE BYTE OF THE BOUNDARY VOCABULARY.
      expect(text).not.toContain('crossBoundary')
      expect(text).not.toContain('CROSSES A TRUST BOUNDARY')
      for (const reason of CROSS_BOUNDARY_REASONS) expect(text, reason).not.toContain(reason)

      // AND THE REST OF THE RECEIPT IS UNTOUCHED.
      expect(text).toContain(DISPLAYABLE_ANSWER.summaryLine)
      expect(text).toContain(DISPLAYABLE_ANSWER.shownDiff)
    })

  it('does not run at all on a host that binds no vocabulary', async () => {
    // With the dep absent, the from-zero case's only guard is the authoring loop's own backstop.
    const test = harness()
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('completed')
    expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
  })
})
