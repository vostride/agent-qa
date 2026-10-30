// The member executor is a double; the core, `startRun` and the event and handoff stores are real.

import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEventEnvelope, RunSession } from '@vostride/agent-qa-schema'

import { buildRunPorts } from '../run-composition.js'
import type { RunExecutionContext } from '../run-composition.js'
import {
  createRunInvocationCore,
  RunIdAlreadyInUseError,
  RunIdNotMintedError,
} from '../run-invocation-core.js'
import type { RunAssemblyContext, RunConfig } from '../run-invocation-core.js'
// The retired gate's action name, kept as a literal so cells can assert no row names it.
const RETIRED_RUN_START_ACTION = 'run:start'

const portBuilds = vi.hoisted(() => ({ order: [] as string[] }))
vi.mock('../run-composition.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../run-composition.js')>()
  return {
    ...actual,
    buildRunPorts: (input: Parameters<typeof actual.buildRunPorts>[0]) => {
      portBuilds.order.push('buildRunPorts')
      return actual.buildRunPorts(input)
    },
  }
})

let projectDir: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'run-core-'))
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

function agentQaRoot(): string {
  return join(projectDir, '.agent-qa')
}

/**
 * The recording assembler: a real one-member `RunConfig` whose executor is the only double.
 *
 * `calls` is the instrument the deny-path cell turns on — the core must not reach assembly at all
 * when the verdict is deny, and a call COUNT is what makes "no side effects" checkable rather than
 * asserted about the effects a reader happened to think of.
 */
function recordingAssembler(): {
  calls: RunAssemblyContext[]
  assemble: (context: RunAssemblyContext) => RunConfig
} {
  const calls: RunAssemblyContext[] = []
  return {
    calls,
    assemble(context: RunAssemblyContext): RunConfig {
      calls.push(context)
      return {
        runId: context.runId as RunConfig['runId'],
        scope: { tier: 'product', key: 'fixture-product' },
        executionContext: context.executionContext,
        buildOrdinal: 1,
        configDigests: { suiteConfigDigest: 'suite-d', testConfigDigest: 'test-d' },
        members: [{ testId: 't1', name: 'the only member', filePath: 'tests/one.yaml' }],
        executor: async (member) => ({
          name: member.name,
          filePath: member.filePath,
          status: 'passed',
          steps: [{ name: 'a step', status: 'passed', duration: 1 }],
          duration: 1,
        }),
        // The core's own ports, so the test covers where persistence is rooted, not only assembly.
        ports: context.ports,
      }
    },
  }
}

// A fixture predicate, because the canonical id shape lives in a package this one may not name.
const FIXTURE_MINTED_RUN_ID = (value: string): boolean => /^run_[a-z_]+$/.test(value)

interface CoreInput {
  executionContext?: RunExecutionContext
  assemble?: (context: RunAssemblyContext) => RunConfig
  onSession?: (session: RunSession) => void
  mintRunId?: () => string
  // Defaults to the fixture predicate above.
  isMintedRunId?: (value: string) => boolean
}

function makeCore(input: CoreInput): ReturnType<typeof createRunInvocationCore> {
  return createRunInvocationCore({
    configPath: join(projectDir, 'agent-qa.config.yaml'),
    agentQaRoot: agentQaRoot(),
    executionContext: input.executionContext ?? 'ci',
    mintRunId: input.mintRunId ?? (() => 'run_minted_by_the_core'),
    isMintedRunId: input.isMintedRunId ?? FIXTURE_MINTED_RUN_ID,
    assembleRun: input.assemble ?? recordingAssembler().assemble,
    ...(input.onSession === undefined ? {} : { onSession: input.onSession }),
  })
}

/** Read the run's events back through the SAME construction the composition's evidence check uses. */
function recordedEvents(runId: string): RunEventEnvelope[] {
  return [...buildRunPorts({ configDir: projectDir, runId }).eventLog.read(0)]
}

// A content digest, because a same-length rewrite is invisible to mtime or size.
function artifactDigests(runDir: string): Record<string, string> {
  if (!existsSync(runDir)) return {}
  const digests: Record<string, string> = {}
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    digests[entry.name] = createHash('sha256')
      .update(readFileSync(join(runDir, entry.name)))
      .digest('hex')
  }
  return digests
}

// Both audit trails are read, so a returning writer of either is seen.
function recordedAuditRows(runId: string): Array<Record<string, unknown>> {
  const slug = runId.replaceAll('/', '-')
  return ['execution_audit.jsonl', 'guardrail_audit.jsonl'].flatMap((file) => {
    const path = join(agentQaRoot(), 'runs', slug, file)
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  })
}

describe('the invocation core — the allow leg, end to end', () => {
  it('runs a request through assembly → startRun → handoff, under the production root', async () => {
    const assembler = recordingAssembler()
    const sessions: RunSession[] = []
    const core = makeCore({
      assemble: assembler.assemble,
      onSession: (session) => sessions.push(session),
    })

    const started = await core.execute({ patterns: ['tests/one.yaml'] })

    expect(started.runId).toBe('run_minted_by_the_core')
    expect(assembler.calls).toHaveLength(1)
    // The assembler is handed the SAME id the caller is acknowledged with — a run that reported one
    // id and started under another would make every later `runs.get` a lookup of a different run.
    expect(assembler.calls[0].runId).toBe(started.runId)

    // The bridge hook fired once, with the session the run is happening on.
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(started.runId)

    // `type`, which is the envelope's own field name — the bus writes `{seq, ts, runId, type,
    // payload}`. Asserted off the jsonl the run really left behind rather than off a subscriber,
    // because what a later reader (`runs.get`, the dashboard bridge) sees is the durable log.
    const types = recordedEvents(String(started.runId)).map((event) => event.type)
    expect(types[0]).toBe('runStarted')
    expect(types).toContain('runFinished')

    // The handoff — the run's durable record — is on disk under the same root, which is what makes
    // the acknowledgment readable back by `runs.get` rather than a claim.
    const slug = String(started.runId).replaceAll('/', '-')
    expect(existsSync(join(agentQaRoot(), 'runs', slug, 'handoff.json'))).toBe(true)

    // No run-start decision row: nothing decided. This cell runs in `ci` on purpose.
    const rows = recordedAuditRows(String(started.runId))
    expect(rows.filter((row) => row.action === RETIRED_RUN_START_ACTION)).toEqual([])
  })

  it('carries the request markers onto the run and only the literal true', async () => {
    const assembler = recordingAssembler()
    const core = makeCore({ assemble: assembler.assemble })

    const started = await core.execute({ gateRun: true })

    const runStarted = recordedEvents(String(started.runId))[0]
    expect(runStarted.type).toBe('runStarted')
    const slug = String(started.runId).replaceAll('/', '-')
    const handoff = JSON.parse(
      readFileSync(join(agentQaRoot(), 'runs', slug, 'handoff.json'), 'utf8'),
    ) as { gateRun?: true; excludedFromOutcomes?: true }
    expect(handoff.gateRun).toBe(true)
    // The OTHER axis was never asserted by the caller, so it must be absent rather than false.
    expect(Object.hasOwn(handoff, 'excludedFromOutcomes')).toBe(false)
  })

  it('honours a caller-minted run id (the additive request field the child env variable used to be)', async () => {
    const core = makeCore({})

    const started = await core.execute({ runId: 'run_from_the_door' as never })

    expect(started.runId).toBe('run_from_the_door')
    expect(recordedEvents('run_from_the_door')).not.toHaveLength(0)
  })
})

describe('the invocation core asks nobody', () => {
  it('a run starts in ci, local-headless and local-interactive with no confirm or trust', async () => {
    const cases = [
      { executionContext: 'ci', runId: 'run_in_ci' },
      { executionContext: 'local-headless', runId: 'run_headless' },
      { executionContext: 'local-interactive', runId: 'run_interactive' },
    ] as const
    for (const scene of cases) {
      const assembler = recordingAssembler()
      const core = makeCore({
        executionContext: scene.executionContext,
        assemble: assembler.assemble,
        mintRunId: () => scene.runId,
      })

      const started = await core.execute({})

      expect(started.runId, scene.runId).toBe(scene.runId)
      expect(assembler.calls, scene.runId).toHaveLength(1)
      // The context the door carried is still the one the run records.
      expect(assembler.calls[0]!.executionContext).toBe(scene.executionContext)
      expect(recordedEvents(scene.runId)[0]?.type).toBe('runStarted')
      // No run-start decision was recorded, because none was taken.
      expect(
        recordedAuditRows(scene.runId).filter((row) => row.action === RETIRED_RUN_START_ACTION),
      ).toEqual([])
    }
  })

  it('the source asks nobody: no evaluate, confirm, trust or reader member remains', () => {
    const code = stripComments(readFileSync(CORE_SOURCE_PATH, 'utf8'))
    expect(code).not.toMatch(/\bevaluate\s*\(/)
    expect(code).not.toMatch(/options\.(confirm|trust|reader)\b/)
    expect(code).not.toMatch(/readonly (confirm|trust|reader)\?/)
    // Non-vacuity: the stripped file still holds the core.
    expect(code).toContain('export function createRunInvocationCore(')
  })
})

// Source hygiene: each scan is self-checked against its own members before it judges the core.

// A name in prose is not code; the `[^:]` guard keeps a URL's `//` from reading as a comment.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Each member answers what ambient state the process holds; the core answers to its door instead.
const AMBIENT_RESOLVERS = [
  'resolveRunExecutionContext',
  'detectExecutionContext',
  'getActiveExecutionContext',
  'setActiveExecutionContextResolver',
  ['getActive', 'AuditSink'].join(''),
  ['setActive', 'AuditSinkResolver'].join(''),
  'runSafetyScope',
  'AsyncLocalStorage',
] as const

const CORE_SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'run-invocation-core.ts',
)

describe('the core hygiene census, pinned to the core file', () => {
  it('the scanner sees what it forbids — the predicate self-check, before any verdict about the core', () => {
    // (i) each member of the complete set is detected in code…
    for (const resolver of AMBIENT_RESOLVERS) {
      const planted = `import { ${resolver} } from '@vostride/agent-qa-safety'\nconst ctx = ${resolver}()\n`
      expect(
        stripComments(planted).includes(resolver),
        `the scan cannot see ${resolver} — it would pass the core vacuously`,
      ).toBe(true)
    }
    // (ii) …and NOT in prose, which is the case the core file actually presents.
    expect(stripComments('// this file never calls getActiveExecutionContext\n')).not.toContain(
      'getActiveExecutionContext',
    )
    expect(stripComments('/* no resolveRunExecutionContext here */\nconst x = 1\n')).not.toContain(
      'resolveRunExecutionContext',
    )
    // (iii) and the stripper does not eat code it should keep.
    expect(stripComments("const url = 'https://example.com' // trailing\n")).toContain(
      "https://example.com",
    )
  })

  it('the core reads no ambient context', () => {
    const code = stripComments(readFileSync(CORE_SOURCE_PATH, 'utf8'))

    for (const resolver of AMBIENT_RESOLVERS) {
      expect(code, `${resolver} is reachable from the core's CODE`).not.toContain(resolver)
    }
  })

  it('no evaluate() call site lives in the core, and the evaluate pin names no core file', () => {
    const code = stripComments(readFileSync(CORE_SOURCE_PATH, 'utf8'))
    expect(code.match(/\bevaluate\s*\(/g) ?? []).toEqual([])
    expect(code).not.toContain('@vostride/agent-qa-safety\'\nimport { evaluate')

    // Read as TEXT rather than imported, because agent-local does not depend on the arch package.
    const pin = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'arch', 'src', 'lint', 'evaluate-pin.ts'),
      'utf8',
    )
    expect(pin).not.toContain("'packages/agent-local/src/composition/run-invocation-core.ts':")
    expect(pin).not.toMatch(/export const EVALUATE_PIN\b/)
    expect(pin).toContain('export function parseModuleStatements')
  })

  it('the door hook sits below the id refusals and above the ports and assembly', () => {
    const code = stripComments(readFileSync(CORE_SOURCE_PATH, 'utf8'))
    const execute = code.slice(code.indexOf('async execute(request: RunsStartInput)'))
    const hook = execute.indexOf('await options.afterRefusal?.()')
    // Non-vacuity: the call is in the execute body, once.
    expect(hook).toBeGreaterThan(0)
    expect(execute.split('options.afterRefusal?.(').length - 1).toBe(1)
    expect(hook).toBeGreaterThan(execute.indexOf('refuseUnavailableRunId('))
    expect(execute.indexOf('await evaluate(')).toBe(-1)
    expect(hook).toBeLessThan(execute.indexOf('buildRunPorts('))
    expect(hook).toBeLessThan(execute.indexOf('options.assembleRun('))
  })

  // Nothing decides a run, so the assembler finds no decision row: the run's audit trail is empty
  // when assembly is reached.
  it('nothing has been decided or recorded by the time assembly is reached (the ordering, from inside)', async () => {
    let rowsVisibleToAssembly: Array<Record<string, unknown>> = []
    const inner = recordingAssembler()
    const core = makeCore({
      mintRunId: () => 'run_ordering_probe',
      assemble: (context) => {
        rowsVisibleToAssembly = recordedAuditRows('run_ordering_probe')
        return inner.assemble(context)
      },
    })

    await core.execute({})

    expect(rowsVisibleToAssembly).toEqual([])
    // Non-vacuity: assembly really was reached.
    expect(inner.calls).toHaveLength(1)
  })
})

// Refusals land above assembly, so absence is the claim; each paired control proves the run.
describe('the invocation core — the identity step refuses before anything', () => {
  it('REFUSES an id this system would not have minted, by name, having written nothing', async () => {
    const assembler = recordingAssembler()
    const core = makeCore({ assemble: assembler.assemble })

    await expect(core.execute({ runId: 'not-a-minted-id' as never })).rejects.toThrow(
      RunIdNotMintedError,
    )

    // Nothing was minted, read or written: no run directory at all, so no audit row, no events.
    expect(existsSync(join(agentQaRoot(), 'runs'))).toBe(false)
    expect(assembler.calls).toEqual([])
  })

  it('THE CONTROL — one field different (a minted id) and the same request runs', async () => {
    const assembler = recordingAssembler()
    const core = makeCore({ assemble: assembler.assemble })

    const started = await core.execute({ runId: 'run_a_minted_shape' as never })

    expect(started.runId).toBe('run_a_minted_shape')
    expect(assembler.calls).toHaveLength(1)
    // The run directory the refusal cell finds absent is the one this control writes.
    expect(recordedEvents('run_a_minted_shape')[0]?.type).toBe('runStarted')
  })

  it('the predicate is ASKED about the caller-named id, and only about that one', async () => {
    const asked: string[] = []
    const core = makeCore({
      isMintedRunId: (value) => { asked.push(value); return true },
      mintRunId: () => 'run_the_core_minted_it',
    })

    await core.execute({})
    // A minted id is the system's own; asking a caller's predicate about it would be the core
    // second-guessing the mint it was handed.
    expect(asked).toEqual([])

    await core.execute({ runId: 'run_the_caller_named_it' as never })
    expect(asked).toEqual(['run_the_caller_named_it'])
  })

  it('REFUSES an id that already names a run, and the victim is byte-identical after', async () => {
    const victimId = 'run_the_victim'
    const core = makeCore({})

    await core.execute({ runId: victimId as never })
    const runDir = join(agentQaRoot(), 'runs', victimId)
    const before = artifactDigests(runDir)
    // Non-vacuity: the victim holds the artifacts a collision would tamper with.
    expect(Object.keys(before).sort()).toEqual(
      expect.arrayContaining(['events.jsonl', 'handoff.json']),
    )

    const second = makeCore({})
    await expect(second.execute({ runId: victimId as never })).rejects.toThrow(
      RunIdAlreadyInUseError,
    )

    expect(artifactDigests(runDir)).toEqual(before)
  })

  it('the collision refusal lands ABOVE assembly — no row, no second event, no assembly', async () => {
    const victimId = 'run_the_second_victim'
    await makeCore({}).execute({ runId: victimId as never })

    const rowsBefore = recordedAuditRows(victimId).length
    const eventsBefore = recordedEvents(victimId).length
    expect(rowsBefore).toBe(0)
    expect(eventsBefore).toBeGreaterThan(0)

    const assembler = recordingAssembler()
    const hooks: number[] = []
    const second = createRunInvocationCore({
      configPath: join(projectDir, 'agent-qa.config.yaml'),
      agentQaRoot: agentQaRoot(),
      executionContext: 'ci',
      mintRunId: () => 'run_never_minted',
      isMintedRunId: FIXTURE_MINTED_RUN_ID,
      assembleRun: assembler.assemble,
      afterRefusal: async () => {
        hooks.push(1)
      },
    })

    await expect(second.execute({ runId: victimId as never })).rejects.toThrow(
      RunIdAlreadyInUseError,
    )

    // The refusal is above the door's own hook — so nothing between the request and the run's own
    // directory ran.
    expect(hooks).toEqual([])
    expect(assembler.calls).toEqual([])
    expect(recordedAuditRows(victimId)).toHaveLength(rowsBefore)
    expect(recordedEvents(victimId)).toHaveLength(eventsBefore)
  })

  it('the MINT-YOUR-OWN path is untouched — no predicate call, no collision question', async () => {
    let collisionsAsked = 0
    const core = makeCore({
      isMintedRunId: () => { collisionsAsked += 1; return true },
      mintRunId: () => 'run_minted_twice_over',
    })

    const first = await core.execute({})
    expect(first.runId).toBe('run_minted_twice_over')
    expect(collisionsAsked).toBe(0)

    // …and a MINTED id colliding with itself is not this refusal's business either: the core does
    // not police its own mint, which is the door's contract to keep. Stated so a later reader does
    // not read the collision refusal as a uniqueness guarantee over minted ids.
    const again = await core.execute({})
    expect(again.runId).toBe('run_minted_twice_over')
  })

  it('the two refusals are named and distinguishable from each other', () => {
    expect(new RunIdNotMintedError('x').name).toBe('RunIdNotMintedError')
    expect(new RunIdAlreadyInUseError('x').name).toBe('RunIdAlreadyInUseError')
    expect(new RunIdNotMintedError('x')).not.toBeInstanceOf(RunIdAlreadyInUseError)
  })

  it('the shape predicate is REQUIRED, with no default and no fallback (source)', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'run-invocation-core.ts'),
      'utf8',
    )
    // `readonly isMintedRunId:` and not `readonly isMintedRunId?:` — an optional predicate with a
    // permissive fallback is the accept-any-string defect wearing a type.
    expect(source).toContain('readonly isMintedRunId: (value: string) => boolean')
    expect(source).not.toContain('isMintedRunId?')
    expect(source).not.toMatch(/options\.isMintedRunId\s*\?\?/)
    // The compiler agrees, and it said so: dropping the option from the two fixtures in this
    // package produced, verbatim,
    //   run-invocation-core.test.ts(107,34): error TS2345: Argument of type '{ … }' is not
    //   assignable to parameter of type 'RunInvocationCoreOptions'.
    //   run-invocation-evidence.test.ts(112,34): error TS2345: … same shape …
    // — which is the half a source assertion cannot make and a type can.
  })

  it('NO defensive catch was added on the start path (re-run as a census)', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'run-invocation-core.ts'),
      'utf8',
    )
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toMatch(/\bcatch\b/)
    expect(code).not.toMatch(/\.catch\s*\(/)
    // Non-vacuity: the stripper left the file's actual code behind.
    expect(code).toContain('await options.afterRefusal?.()')
  })
})

// The assembler writes a row to any sink its context offers; the retired key is spelled in parts.
describe('the run directory after a completed run', () => {
  it('a completed run leaves no guardrail audit file in its run directory', async () => {
    const inner = recordingAssembler()
    const retiredKey = ['audit', 'Sink'].join('')
    const core = makeCore({
      mintRunId: () => 'run_with_no_audit_file',
      assemble: (context) => {
        const offered = (context as unknown as Record<string, unknown>)[retiredKey] as
          | { appendGuardrailAudit(row: Record<string, unknown>): unknown }
          | undefined
        offered?.appendGuardrailAudit({ action: 'pass', channel: 'planner' })
        return inner.assemble(context)
      },
    })

    const started = await core.execute({})

    const runDir = join(agentQaRoot(), 'runs', String(started.runId))
    expect(recordedEvents(String(started.runId)).map((event) => event.type)).toContain('runFinished')
    expect(existsSync(join(runDir, 'handoff.json'))).toBe(true)
    expect(readdirSync(runDir)).not.toContain('guardrail_audit.jsonl')
  })
})

describe('the post-refusal hook', () => {
  function hookedCore(input: {
    afterRefusal: () => Promise<void>
    mintRunId?: () => string
    assemble?: (context: RunAssemblyContext) => RunConfig
  }): ReturnType<typeof createRunInvocationCore> {
    return createRunInvocationCore({
      configPath: join(projectDir, 'agent-qa.config.yaml'),
      agentQaRoot: agentQaRoot(),
      executionContext: 'ci',
      mintRunId: input.mintRunId ?? (() => 'run_minted_by_the_core'),
      isMintedRunId: FIXTURE_MINTED_RUN_ID,
      assembleRun: input.assemble ?? recordingAssembler().assemble,
      afterRefusal: input.afterRefusal,
    })
  }

  it('the post-refusal hook never runs for a refused request', async () => {
    await makeCore({}).execute({ runId: 'run_already_in_use' as never })
    const refusals: Array<[string, () => Promise<unknown>, new (...args: never[]) => Error]> = [
      ['an unminted run id', () => hookedCore({ afterRefusal: hook }).execute({ runId: 'not-a-minted-id' as never }), RunIdNotMintedError],
      ['an in-use run id', () => hookedCore({ afterRefusal: hook }).execute({ runId: 'run_already_in_use' as never }), RunIdAlreadyInUseError],
    ]
    const calls: string[] = []
    let current = ''
    async function hook(): Promise<void> { calls.push(current) }
    for (const [name, attempt, refusal] of refusals) {
      current = name
      await expect(attempt(), name).rejects.toThrow(refusal)
    }
    expect(calls).toEqual([])
  })

  it('the post-refusal hook runs once before any port on an allowed request', async () => {
    portBuilds.order.length = 0
    const assembler = recordingAssembler()
    const core = hookedCore({
      afterRefusal: async () => {
        portBuilds.order.push('afterRefusal')
        expect(assembler.calls).toHaveLength(0)
      },
      assemble: assembler.assemble,
      mintRunId: () => 'run_allowed_with_hook',
    })

    await core.execute({})

    expect(portBuilds.order.filter((entry) => entry === 'afterRefusal')).toHaveLength(1)
    expect(portBuilds.order.indexOf('afterRefusal')).toBeGreaterThanOrEqual(0)
    expect(portBuilds.order.indexOf('afterRefusal')).toBeLessThan(portBuilds.order.indexOf('buildRunPorts'))
    expect(assembler.calls).toHaveLength(1)
  })

  it('a hook that throws leaves no run directory', async () => {
    const assembler = recordingAssembler()
    const failure = new Error('the post-refusal hook failed')
    const core = hookedCore({
      afterRefusal: async () => { throw failure },
      assemble: assembler.assemble,
      mintRunId: () => 'run_hook_throws',
    })

    await expect(core.execute({})).rejects.toBe(failure)
    expect(existsSync(join(agentQaRoot(), 'runs', 'run_hook_throws'))).toBe(false)
    expect(assembler.calls).toEqual([])
  })
})
