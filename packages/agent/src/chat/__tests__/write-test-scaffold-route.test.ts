// The write_test → scaffold → author handoff, in ONE turn (395-08, D-14/D-15 · CFGM-05).
//
// 2026-09-30, 432-11 D-05/D-14: THE SCAFFOLD WRITES IN ITS OWN CALL. There is no proposal, no
// `config.proposal.apply` and no confirm between the scaffold and the authoring dispatch; the
// receipt of what was written is rendered where a surface exists, and a surface that is absent or
// broken no longer stops the turn. The cells that pinned the confirm are re-spelled in place to the
// direct behaviour: the chain is scaffold then author, and a scaffold that did not write stops it.
//
// THE SEAM THE PLAN NAMED DOES NOT EXIST, AND THIS FILE IS WHERE THAT WAS RESOLVED. The plan says
// to branch "where the chat turn resolves a write_test request's target against
// configuredTargetNames". `AuthoringDraftWriteInputSchema` carries `intent` and an optional
// `scope`; there is no target on the request at all, and the one that ends up in a draft is
// decided INSIDE the loop by a model, at `loop.ts:583`/`:647`, after an LLM call. So the branch
// asks the question that IS answerable before dispatch — given this project's vocabulary and the
// words a person typed, is there anything to author against — and the loop's own backstop is
// untouched (RESEARCH Pitfall 6).
//
// WHAT MAKES EACH CELL RED:
//
//   (R1) passthrough    — a route that intercepted ordinary requests. A configured project asked
//                         for "the login flow" must dispatch authoring and NOTHING else; the spy
//                         records every invocation, so a stray scaffold fails by count.
//   (R2) configured     — a route that scaffolded a target the project already declares. The
//                         utterance names `booking.com`, the project declares `booking-com`, and
//                         the only invocation must be the authoring one.
//   (R3) scaffold+author— a chain that authored without configuring, or one that configured
//                         without authoring. Asserted as an ORDERED list of invocations, so a
//                         turn that did the right things in the wrong order fails too.
//   (R4) no confirm     — 432-11: the scaffold's own call wrote the files, so no apply verb is
//                         invoked between it and the authoring dispatch.
//   (R5) interrupted    — a chain that authored anyway after the scaffold's write stopped part way.
//                         The cell asserts ZERO authoring invocations and a `fail_closed` turn
//                         carrying the scaffold's own account of what it wrote.
//   (R6) headless       — no surface to render on is not a reason to stop: the receipt is logged and
//                         the chain authors, as every other host does.
//   (R7) refusal        — a route that guessed. An unconfigured project asked for "the checkout
//                         flow" invokes NOTHING at all — not even the scaffold — and the refusal
//                         names both continuations without echoing the words back as an origin.
//   (R8) blocked/refused— a scaffold that answered `refused` and a chain that dispatched authoring
//                         anyway. The proposal's own detail is what the turn reports. Its fixture's
//                         refusal is one the REAL op can produce in this project class (395-12): a
//                         canned `already-configured` would be a refusal a zero-target project can
//                         no longer earn, which is the vacuity (R3/R4) was just repaired for.
//   (R9) unbound        — a host that binds no vocabulary. The route must not run at all, so the
//                         shipped dispatch is byte-for-byte what it was before this seam existed.
//  (R10) WR-05          — a scaffold arm with no from-zero precondition. `readme.md` PARSES as a
//                         hostname, so in a project that declares targets the pre-395-12 route
//                         resolved `scaffold` and the turn ended in `already-configured` for
//                         `readme-md` — a site nobody named, traded for a working dispatch. The
//                         cell asserts the authoring dispatch is EXACTLY what 394 ships.
//  (R11) both classes   — a route that decided on the WORDING. ONE utterance, TWO project classes,
//                         in one cell: zero targets scaffolds and one configured target passes
//                         through. Neither half can be satisfied by a constant.
//
// THE ROUTE RESOLVER IS ALSO MEASURED DIRECTLY, with a rejection corpus, because a refusal rule
// needs corpus cases it REJECTS or every cell is drawn from inside the rule's own assumption.

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
// 2026-10-01 (432-17): the config apply op is deleted with the inbox; its retired id is spelled here
// so the cells keep pinning that the scaffold route never dispatches it.
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

// 2026-10-01 (432-28, D-12): the retired `grantedScopes`, `safeMode` and `sessionId` caller fields
// are dropped; nothing read them.
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
  /**
   * Every mid-turn render, each carrying a SNAPSHOT of `ordering` taken at the moment it happened
   * (395-13).
   *
   * The snapshot rather than a marker pushed into `ordering` itself, and that is deliberate:
   * `ordering` keeps recording INVOCATIONS ONLY, so every expected array in the cells below is the
   * array it always was and a render's position is read off a copy instead of by widening the thing
   * six other cells assert on.
   */
  readonly presented: { text: string; orderingAtRender: string[] }[]
  /**
   * What each invocation RESOLVED to.
   *
   * So a cell can compare a rendered surface against the op's OWN answer rather than against a copy
   * of the fixture — the difference between measuring that this proposal was shown and measuring
   * that something with the right shape was.
   */
  readonly answers: { functionId: string; answer: unknown }[]
  /**
   * The session events THIS run wrote, live (395-17).
   *
   * Exposed because the display-only claim has a second half nothing measured: D-14 says a
   * presentation port shows and never decides, and "never decides" includes the log. The harness
   * pins a fixed turn id and a counting clock, so two runs of the same road write byte-identical
   * streams and a cell can compare them whole rather than asserting on a chosen field.
   */
  readonly events: ChatSessionEvent[]
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}

// -----------------------------------------------------------------------------------------------
// THE REAL SCAFFOLD OP, BEHIND THE CHAIN (395-12 · the R3/R4 vacuity closed IN PLACE, not siblinged)
//
// WHAT WAS WRONG WITH THE OLD FIXTURE, stated because the repair is only legible against it. The
// happy-path cell drove a scaffold DOUBLE that answered `proposed` in a project whose configured
// set was `['other-site']` — a project in which the REAL op answered `refused / already-configured`,
// which cell (R8) in this same file shows converts into a whole-turn refusal. The chain's ORDER was
// therefore pinned against an answer no shipped build could produce: the ordering held while the
// capability did not, and 395-VERIFICATION reproduced both halves live and scored SC-5 failed.
//
// THE REPAIR IS THE REAL REGISTERED SPEC, never a second double that answers differently.
// `configProjectScaffoldSpec.invoke` runs here over in-memory ports, so `parseHostnameToken`, the
// declared-target predicate, the candidate assembly, the cross-boundary classifier and the
// publication are all production's. Two of the four ports are doubles for a BOUNDARY reason
// rather than a convenience one: `configValidate` is `core`'s `AgentQaConfigSchema` and
// `scaffoldContent` is the shared content module beside `agent-qa init`, and `packages/agent` may
// import neither. Both are measured against their real implementations in
// `cli/src/composition/__tests__/config-scaffold.test.ts`, over a real git repository.
//
// `configFiles.inspect` IS FAITHFUL, and it is the one that carries this cell's claim. It is the
// shipped host's own `parseDocument` → `getIn` → `keys` read, spelled over the same `yaml` API — a
// DEV dependency of this package, so a test may parse what this package's source may not.
// -----------------------------------------------------------------------------------------------

const SCAFFOLD_CONFIG_FILE = 'agent-qa.config.yaml'
const SCAFFOLD_HOOKS_FILE = 'hooks.yaml'
const SCAFFOLD_GITIGNORE = '.gitignore'

/**
 * A project that CAN chat — it declares a model — and has nothing to write a test against.
 *
 * THIS IS SC-5's SERVING CLASS, and it is not a hypothetical: `resolveCliChatCapabilities` reads
 * the chat model out of `registry.llms`, which lives in the config file, so a project able to hold
 * a conversation at all is a project that HAS one. The pre-fix predicate refused exactly those.
 */
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

/** One publication the direct writer received (432-11): the files, by path. */
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

/**
 * What a broken display port says when it fails.
 *
 * HOISTED so a cell can assert the refusal sentence does NOT carry it (395-19 · T-395-53). A
 * refusal derived from the failed port would be the port gaining a voice in the turn through the
 * back door of an error path — the thing RULING 2 closed, re-opened by the arm that replaced it.
 */
const PRESENT_FAILURE_ERROR = 'the pipe closed'

function harness(options: {
  /** Absent ⇒ the dep is not bound at all, which is cell (R9)'s whole subject. */
  readonly targets?: readonly string[]
  readonly scaffoldAnswer?: unknown
  /**
   * Drive the REAL registered `config.project.scaffold` spec instead of a canned answer (395-12).
   *
   * The cell that pins the chain's ORDER is the one cell in this file whose claim depends on what
   * the scaffold actually answers, so it is the one cell that may not be told the answer.
   */
  readonly realScaffold?: ScaffoldOpFixture
  /**
   * Bind NO presentation port, which is every headless host (395-13).
   *
   * Present by default, because the surface under test is the one production binds; this flag is
   * the absent-safe half, and it is a flag rather than a second harness so both hosts run the same
   * assembly.
   */
  readonly noPresent?: boolean
  /**
   * Bind a present that FAILS, in whichever of the port type's two arms is named (395-17).
   *
   * `(text) => void | Promise<void>` can fail synchronously or by rejecting, and a host binding a
   * real stream can do either — so the third state of this port (bound, and broken) gets a double
   * per arm. Both RECORD first: the render was attempted, and that observation must survive the
   * failure or a cell could not tell a broken surface from one that was never reached.
   */
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
      // 432-39 (D-02/D-12): the port takes no session; the caller carries none.
      forStage: (_stage: ChatBindingStage): FunctionCaller => PLANNER_CALLER,
    },
    invoke: async (functionId, input) => {
      ordering.push(functionId)
      inputs.push({ functionId, input })
      const answer = await answerFor(functionId, input)
      answers.push({ functionId, answer })
      // 399.1: the envelope, carrying the legacy verdict — these cells are about the write-test
      // ROUTE, and the payload is the only member the route reads.
      return { payload: answer, verdict: { status: 'executed' as const, outcome: '' }, foldLines: [] }
    },
    planner,
    // 395-13 D-14: the surface a person reads mid-turn. BOUND BY DEFAULT, because the host under
    // test is the one production composes; `noPresent` is the absent-safe half.
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
    // A HOSTNAME-SHAPED TOKEN THAT IS NOT A SITE. `readme.md` and `index.html` both satisfy
    // `parseHostnameToken` — a dot, legal labels, an alphabetic final label — so before 395-12 the
    // scaffold arm fired on them in ANY project, and a configured project's turn ended in
    // `already-configured` for `readme-md`. The precondition is the project, in both arms.
    for (const intent of [
      'write a test that checks the readme.md rendering',
      'write a test for the index.html landing page',
      'write a test for booking.com checkout',
    ]) {
      expect(resolveWriteTestRoute({ intent, configuredTargetNames: ['shop'] }), intent)
        .toEqual({ kind: 'passthrough' })
    }

    // THE OTHER SIDE IN THE SAME CELL, so neither half can be a constant: the identical tokens in a
    // project that declares NOTHING still reach the scaffold, which is the road SC-5 needs open.
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
  it('(R1) dispatches authoring untouched for an ordinary request in a configured project', async () => {
    const test = harness({ targets: ['shop'] })
    const result = await test.runTurn({ message: 'write a test for the login flow' })

    expect(result.status).toBe('completed')
    // EXACTLY ONE invocation, and it is the authoring one. A route that intercepted here would add
    // a scaffold to this list and fail by count rather than by message.
    expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
  })

  it('(R2) does not scaffold a target the project already declares', async () => {
    const test = harness({ targets: ['booking-com'] })
    await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
  })

  it('(R3/R4) scaffolds through the REAL op, which writes in its own call, and authors AFTER it', async () => {
    // THE FIXTURE IS THE FIX (395-12). An EMPTY configured set, and a committed configuration that
    // declares a model and ZERO targets — the class that can reach a chat turn at all. The
    // invocation reaches `configProjectScaffoldSpec` and `scaffoldConfigProject` for real; nothing
    // here tells it what to answer.
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
    // THE ORDER IS THE CLAIM: the scaffold, then the authoring dispatch against the target that
    // now exists. (R4) 432-11: nothing in between — no apply verb, so no confirm.
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

  it('(R5/R6) authors NOTHING when the scaffold\'s write stopped part way, and says where', async () => {
    // TARGETS EMPTY SINCE 395-12 (WR-05): the from-zero class is the one in which a scaffold is
    // offered at all. 432-11: there is no confirm to decline; the one way the chain stops after the
    // scaffold is that the scaffold did not finish writing.
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

  it('(R7) refuses an unconfigured project with no hostname, and invokes nothing at all', async () => {
    const test = harness({ targets: [] })
    const result = await test.runTurn({ message: 'write a test for the checkout flow' })

    expect(result.status).toBe('fail_closed')
    // NOT EVEN A SCAFFOLD. D-15's refusal is above every effect, so a guess costs nothing and
    // leaves nothing behind.
    expect(test.ordering).toEqual([])
    expect(result.unhandled?.reason).toBe(WRITE_TEST_UNCONFIGURED_DETAIL)
    // It asks for the two things a person can supply, and does NOT hand their own words back as a
    // candidate origin. The presence halves above are what make this absence non-vacuous.
    expect(result.unhandled?.reason).toContain('write a test for example.com')
    expect(result.unhandled?.reason).not.toContain('checkout')
  })

  it('(R8) reports the scaffold\'s own refusal and dispatches nothing', async () => {
    // TARGETS EMPTY, AND THE REFUSAL IS ONE THE REAL OP CAN PRODUCE HERE (395-12). 395-02's
    // `unrenderable-diff` is reachable from zero: it is what the op answers when the project's own
    // `.gitignore` holds bytes that are not valid UTF-8.
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

  // 2026-10-03 (quick 261003-cpv, 432 review WR-03): every blocked or no-change scaffold answers
  // with its own reason. The fallback "this project has no configuration … name the site" was wrong
  // here: the person named the site, and the scaffold said why it wrote nothing.
  // 2026-10-14 (441-18, D-15): 'a guardrail-blocked scaffold says the guardrail found a secret, and
  // where' is deleted with the route's guardrail branch; no scaffold is blocked for a secret.
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

  // 2026-10-03 (quick 261003-cpv, 432 review WR-02): the refusal describes the no-review model.
  it('the unconfigured refusal promises no review step', () => {
    expect(WRITE_TEST_UNCONFIGURED_DETAIL).not.toMatch(/review/i)
    expect(WRITE_TEST_UNCONFIGURED_DETAIL).toContain('write the configuration')
    expect(WRITE_TEST_UNCONFIGURED_DETAIL).toContain('write a test for example.com')
  })

  it('(R10) passes a hostname-shaped NON-SITE token through in a configured project',
    async () => {
      // RED, MEASURED BY MUTATION rather than quoted from history: with WR-05's precondition
      // removed, `readme.md` parses as a hostname and this turn scaffolds and WRITES a target for
      // `readme-md`, a site nobody named. What is lost is 394's plain authoring dispatch, which is
      // what this cell pins.
      const scaffoldOp = scaffoldOpFixture({ configText: ZERO_TARGET_CONFIG })
      const test = harness({ targets: ['shop'], realScaffold: scaffoldOp })
      const message = 'write a test that checks the readme.md rendering'
      const result = await test.runTurn({ message })

      expect(result.status).toBe('completed')
      // EXACTLY WHAT 394 SHIPS — and the reference is PRODUCED rather than typed. The same message
      // is driven through a host that binds no vocabulary at all (cell (R9)'s class), where the
      // route provably does not run, and the two dispatches are compared whole.
      const unrouted = harness()
      await unrouted.runTurn({ message })
      expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
      expect(test.inputs).toEqual(unrouted.inputs)
      expect(test.inputs).toHaveLength(1)
      expect((test.inputs[0]?.input as { intent?: string }).intent).toBe(message)
      // And the scaffold op was never reached at all, so nothing was written on the way past.
      expect(scaffoldOp.published).toHaveLength(0)
    })

  it('(R11) ONE utterance, TWO project classes: zero targets scaffolds, one target passes through',
    async () => {
      // THE CORPUS DISCIPLINE R7 established, applied to the scaffold arm: the same words against
      // both classes in one cell, so the route's decision is measured as a property of the PROJECT.
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

  it('(R12) renders THIS change — summary, files, true diff — AFTER the scaffold wrote it and BEFORE authoring',
    async () => {
      // 432-11: the render is a RECEIPT of a change already on disk, shown once, between the write
      // and the authoring dispatch that builds on it.
      //
      // THE REAL OP ANSWERS IT. Nothing here tells the scaffold what to say, so what is compared is
      // the change this chain actually made.
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

  it('(R13′) an UNBOUND present does not stop the route: the change is written and authoring follows',
    async () => {
      // 432-11 D-14: the render used to be a PRECONDITION of an approval (395-22 · CR-03). There is
      // no approval now: the scaffold wrote the files in its own call, so a host with no surface —
      // every headless `ask` — logs the receipt and authors, exactly as a host with one does.
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

  // -----------------------------------------------------------------------------------------------
  // (R16)-(R19) — THE PER-FIELD RECEIPT MATRIX (395-22, re-spelled by 432-11).
  //
  // A receipt renders what the answer has. The one field the route cannot do without is the file
  // list: an `applied` answer that names no file wrote nothing a test could be authored against,
  // so it stops the turn. The display fields are rendered when present and skipped when absent or
  // empty, and none of them stops a turn whose files are already written.
  // -----------------------------------------------------------------------------------------------

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

  it('(R16) a receipt with NO summary line renders the rest, and the turn authors', async () => {
    const { summaryLine: _summaryLine, ...withoutSummary } = DISPLAYABLE_ANSWER
    const text = await expectReceiptWithout(withoutSummary)
    expect(text).not.toContain(DISPLAYABLE_ANSWER.summaryLine)
  })

  it('(R17) an answer with NO file list wrote nothing to author against, so the turn stops', async () => {
    const { files: _files, ...withoutFiles } = DISPLAYABLE_ANSWER
    const test = harness({ targets: [], scaffoldAnswer: withoutFiles })
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('fail_closed')
    expect(test.ordering).toEqual([CONFIG_PROJECT_SCAFFOLD_FUNCTION_ID])
    expect(test.presented).toEqual([])
    // RE-SPELLED 2026-10-03 (quick 261003-cpv, WR-03): its own sentence, not "name the site".
    expect(result.unhandled?.reason).toContain('without naming a file it wrote')
    expect(result.unhandled?.reason).not.toBe(WRITE_TEST_UNCONFIGURED_DETAIL)
  })

  it('(R18) a receipt with NO rendered diff renders the rest, and the turn authors', async () => {
    const { shownDiff: _shownDiff, ...withoutDiff } = DISPLAYABLE_ANSWER
    const text = await expectReceiptWithout(withoutDiff)
    expect(text).not.toContain('+++ b/')
  })

  it('(R19) an EMPTY rendered diff adds no blank line to the receipt', async () => {
    const text = await expectReceiptWithout({ ...DISPLAYABLE_ANSWER, shownDiff: '' })
    expect(text).toContain(DISPLAYABLE_ANSWER.summaryLine)
    // The receipt ends with the last file: the empty diff contributed no line at all.
    expect(text.endsWith('hooks.yaml')).toBe(true)
  })

  it('(R14) a present that THROWS does not decide the turn: the change is written and authoring follows',
    async () => {
      // THE PORT'S THIRD STATE, bound and BROKEN. 395-17's RULING 2 stands: no host binding may take
      // the turn down. 432-11: the render is a receipt of a change already written, so its failure
      // no longer refuses the turn either — the healthy run and the broken run dispatch the same.
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

      // THE RENDER WAS ATTEMPTED, EXACTLY ONCE, where (R12) puts it.
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

  it('(R15) a present that REJECTS does not decide it either — the port type\'s other arm',
    async () => {
      // THE TWIN, over `Promise<void>`. One await covers both arms of the port's type, and this
      // cell is what says so. Its assertions are (R14)'s, repeated rather than shared.
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


  // -----------------------------------------------------------------------------------------------
  // (R20)/(R21) — RC-2: THE BOUNDARY A PERSON IS TOLD ABOUT (399.1, criterion 4).
  //
  // The receipt says what the change does and whether it crosses a trust boundary — a new origin,
  // a hook this project will run — verbatim off the op's own two fields.
  // -----------------------------------------------------------------------------------------------

  it('(R20) tells the person the change CROSSES A BOUNDARY, and why, above the rest of the receipt',
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

  it('(R21) adds NO boundary line to a change that crosses none — the common path stays quiet',
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

  it('(R9) does not run at all on a host that binds no vocabulary', async () => {
    // The dep is ABSENT. The shipped dispatch is exactly what it was before this seam existed —
    // including for the from-zero case, whose only guard on such a host is the authoring loop's own
    // backstop, which this plan did not touch.
    const test = harness()
    const result = await test.runTurn({ message: 'write a test for booking.com checkout' })

    expect(result.status).toBe('completed')
    expect(test.ordering).toEqual([AUTHORING_DRAFT_WRITE_FUNCTION_ID])
  })
})
