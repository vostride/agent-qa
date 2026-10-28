// THE FN/CHAT/MCP DOOR'S `runs.start` GATE (Phase 401 plan 05 — D-01/D-05/D-06/D-07/D-16).
//
// There is no gate on this road: the op-level gate and the core's `evaluate()` are gone, and a
// well-formed request with a free run id is never refused.
//
// WHAT IS UNDER TEST is the door a caller actually reaches: `composeCliLocalAgent` → the 384
// registry → `invokeFunction` → the REAL op-level gate → the bound run invocation → this host's
// DEFAULT run execution → the in-process drive → the core's ONE `evaluate()`. Nothing on that path
// is substituted. `input.runExecution` is never supplied by any cell in this file, because the
// subject IS the default: a cell that injected a port would be measuring its own argument.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 2026-10-19 (444.1-24, D-39): each drive and its detached tail are awaited before removal.
const tails = vi.hoisted(() => [] as Array<Promise<void>>)

vi.mock('../in-process-run-execution.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../in-process-run-execution.js')>()
  return {
    ...original,
    runInProcessCliRun: (...args: Parameters<typeof original.runInProcessCliRun>) => {
      const drive = original.runInProcessCliRun(...args)
      tails.push(drive.then((outcome) => outcome.settled, () => undefined))
      return drive
    },
  }
})

import { invokeFunction } from '@vostride/agent-qa-agent'
import { generateRunId } from '@vostride/agent-qa-ids'
import { RunIdAlreadyInUseError, RunIdNotMintedError } from '@vostride/agent-qa-agent-local'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
import type { RunStartAcknowledgement, RunsStartInput } from '@vostride/agent-qa-schema'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import type { ComposeCliLocalAgentInput } from '../local-agent-host.js'
import {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  createInProcessFixture,
  eventTypes,
  runDirs,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import type { AuditRow } from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

/**
 * The audit row, plus the one field this plan's cells turned on. Since 432-13 no row is written on
 * this road at all; the type stays because `opAuditRows` still reads the file to say so.
 *
 * `trustSource` is what `resolveAsk` stamps when a standing approval, a credential or session trust
 * carried an ask — the ONLY trace a consumed grant leaves on a row, and therefore the whole of the
 * grant-isolation measurement below. Widened HERE rather than on the shared fixture's `AuditRow`
 * (401-04's), because a helper two other plans read should not grow a field for one plan's cells.
 */
type GateAuditRow = AuditRow & { readonly trustSource?: string }

type Fixture = ReturnType<typeof createInProcessFixture>

/**
 * The OP-level gate's rows, which land somewhere else entirely.
 *
 * The registry's file was `execution_audit.jsonl` under `agentQaRoot`; the core's was under
 * `runs/<slug(runId)>/`. Two files — which is why this helper exists beside `auditRows` (the
 * run-dir reader) instead of being folded into it.
 */
function opAuditRows(fixture: Fixture): GateAuditRow[] {
  const path = join(fixture.agentQaRoot, 'execution_audit.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GateAuditRow)
}

/** An empty browsers root, so a member's failure is a property of the fixture, not of the machine. */
function pinEmptyBrowsersRoot(fixture: Fixture): void {
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
}

/**
 * Compose the SHIPPED host and invoke `runs.start` through the SHIPPED dispatcher.
 *
 * Everything a door may answer is passed here and nothing else is: no `runExecution`, no producer,
 * no assembler. What comes back is what a real MCP or chat caller gets.
 */
async function invokeRunsStart(
  fixture: Fixture,
  request: RunsStartInput,
  door: Partial<Pick<ComposeCliLocalAgentInput, 'resolveExecutionContext'>> = {},
): Promise<RunStartAcknowledgement> {
  pinEmptyBrowsersRoot(fixture)
  const { registry } = composeCliLocalAgent({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    ...door,
  })
  return await invokeFunction(
    registry,
    'runs.start',
    request,
    CLI_FUNCTION_CALLER,
  ) as RunStartAcknowledgement
}

/** Invoke and hand back whatever came out, so a cell can assert on a refusal without try/catch. */
async function invokeRunsStartOutcome(
  fixture: Fixture,
  request: RunsStartInput,
  door: Partial<Pick<ComposeCliLocalAgentInput, 'resolveExecutionContext'>> = {},
): Promise<{ ack?: RunStartAcknowledgement; error?: unknown }> {
  try {
    return { ack: await invokeRunsStart(fixture, request, door) }
  } catch (error) {
    return { error }
  }
}

// ---- ambient channels, varied against the door's own answer (D-07) ---------------------------
//
// Two of them, because there are two and a cell that defeated one would pass under a door reading
// the other: `getActiveExecutionContext` is the process-global the OP gate falls back to, and the
// CI marker is what `resolveRunExecutionContext()` — this door's OWN fallback — reads. Varying
// both, against a door that supplies its context explicitly, is what makes "the injected value
// wins" a measurement instead of a coincidence.

const shippedExecutionContextResolver = getActiveExecutionContext
let restoreAmbient: (() => void) | undefined

beforeEach(() => { restoreAmbient = undefined })
afterEach(() => {
  restoreAmbient?.()
  restoreAmbient = undefined
})
afterAll(async () => {
  await Promise.allSettled(tails.splice(0))
  removeInProcessFixtures()
})

function pinAmbient(value: 'ci' | 'local-interactive' | 'local-headless', ciMarker: boolean): void {
  const priorGithubActions = process.env.GITHUB_ACTIONS
  setActiveExecutionContextResolver(() => value as never)
  if (ciMarker) process.env.GITHUB_ACTIONS = 'true'
  else delete process.env.GITHUB_ACTIONS
  restoreAmbient = () => {
    setActiveExecutionContextResolver(() => shippedExecutionContextResolver())
    if (priorGithubActions === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = priorGithubActions
  }
}

// 432-13 (D-01/D-14/D-15): the fn/chat/MCP door's runs.start asks nobody. An undeclared or shared
// target starts from a CI or headless context with the one call, and no decision row is written at
// either gate because neither gate exists.
describe('C432-DOOR-NONPRODUCTION — the host door starts a non-production run in one call (432-13)', () => {
  it.each([
    ['undeclared', undefined, 'ci'],
    ['shared', 'shared', 'local-headless'],
  ] as const)(
    'C432-DOOR-NONPRODUCTION: a %s target (environment %s) from %s starts and is acknowledged, with no gate row',
    async (_label, environment, context) => {
      const target = new CountingTarget()
      await target.listen()
      try {
        const fixture = createInProcessFixture({
          origin: target.origin,
          ...(environment === undefined ? {} : { environment }),
        })
        pinAmbient(context === 'ci' ? 'ci' : 'local-interactive', context === 'ci')

        const { ack, error } = await invokeRunsStartOutcome(
          fixture,
          { patterns: [fixture.testPattern] },
          { resolveExecutionContext: () => context },
        )

        expect(error, `runs.start refused: ${String(error)}`).toBeUndefined()
        expect(ack!.testCount).toBe(1)
        expect(runDirs(fixture).map((dir) => dir.split('/').pop())).toContain(ack!.runId)
        expect(eventTypes(fixture)).toContain('runStarted')
        expect(buildOrdinalsExist(fixture)).toBe(true)
        expect(target.hits).toEqual(['/in-process-thing'])
        expect(auditRows(fixture).filter((row) => row.action === 'run:start')).toEqual([])
        expect(opAuditRows(fixture).filter((row) => row.action === 'fn:runs.start')).toEqual([])
      } finally {
        await target.close()
      }
    },
    120_000,
  )
})

// The stdout-silence half of the MCP posture is a property of every door: nothing asks.
describe('the fn/MCP door starts a run and asks nothing', () => {
  it('a shared target from a headless door is acknowledged with no decision row', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      pinAmbient('local-interactive', false)

      const { ack, error } = await invokeRunsStartOutcome(
        fixture,
        { patterns: [fixture.testPattern] },
        { resolveExecutionContext: () => 'local-headless' },
      )

      expect(error).toBeUndefined()
      expect(typeof ack!.runId).toBe('string')
      expect(ack!.testCount).toBe(1)
      expect(runDirs(fixture).map((dir) => dir.split('/').pop())).toContain(ack!.runId)
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(buildOrdinalsExist(fixture)).toBe(true)
      expect(target.hits).toEqual(['/in-process-thing'])
      expect(auditRows(fixture)).toEqual([])
      expect(opAuditRows(fixture)).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('THE MCP POSTURE — a door on a live terminal starts the run and writes NOTHING to stdout', async () => {
    // The stdout-silence half of the retired posture cell. Writing a prompt onto the process whose
    // stdout is the JSON-RPC channel breaks the connection; since 432-13 no door can prompt at all,
    // and this measures it on a terminal that would have accepted the bytes.
    const target = new CountingTarget()
    await target.listen()
    const realStdin = process.stdin
    const realStdout = process.stdout
    const written: string[] = []
    const fakeIn = new Readable({ read() { this.push(null) } }) as Readable & { isTTY?: boolean }
    fakeIn.isTTY = true
    const fakeOut = new Writable({
      write(chunk: unknown, _enc: unknown, done: () => void) { written.push(String(chunk)); done() },
    }) as Writable & { isTTY?: boolean }
    fakeOut.isTTY = true
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'shared' })
      pinAmbient('local-interactive', false)

      Object.defineProperty(process, 'stdin', { value: fakeIn, configurable: true })
      Object.defineProperty(process, 'stdout', { value: fakeOut, configurable: true })
      let outcome: Awaited<ReturnType<typeof invokeRunsStartOutcome>>
      try {
        outcome = await invokeRunsStartOutcome(
          fixture,
          { patterns: [fixture.testPattern] },
          { resolveExecutionContext: () => 'local-interactive' },
        )
      } finally {
        Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
        Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true })
      }

      expect(outcome.error).toBeUndefined()
      expect(outcome.ack).toBeDefined()
      expect(written.join('')).not.toMatch(/\[y\/N\]|approve|confirm/i)
      expect(eventTypes(fixture)).toContain('runStarted')
    } finally {
      await target.close()
    }
  }, 120_000)
})

describe('the empty-input and suite edges of a bare runs.start (401-05, INVK-02)', () => {
  it('AN ARGUMENT-LESS runs.start RESOLVES THE CONFIGURED DEFAULT SET — both members of it ran', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-interactive', false)

      const { ack } = await invokeRunsStartOutcome(
        fixture,
        {},
        { resolveExecutionContext: () => 'local-headless' },
      )

      expect(ack).toBeDefined()
      // TWO, and the number is the assertion. The fixture's `testMatch` admits `tests/direct.yaml`
      // AND `tests/member.yaml`, so "absent patterns means the configured default set" is only
      // true if BOTH are in the run the record describes. A door that quietly resolved one file,
      // or none, would still have produced an ack.
      expect(ack!.testCount).toBe(2)
      expect(eventTypes(fixture)).toContain('runStarted')
    } finally {
      await target.close()
    }
  }, 120_000)

  it('A SUITE PATTERN over the fn door runs the SUITE, and the MEMBER ran', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-headless', false)

      const { ack } = await invokeRunsStartOutcome(
        fixture,
        { patterns: [fixture.suitePattern] },
        { resolveExecutionContext: () => 'local-headless' },
      )

      expect(ack).toBeDefined()
      const events = eventTypes(fixture)
      expect(events).toContain('runStarted')
      // THE MEMBER RAN. Without this, a dispatcher that took the test path and assembled zero
      // members would pass on `runStarted` alone — which is the shape the retiring wire could
      // produce, because it forwarded patterns with no mode flag and let the child decide.
      expect(events).toContain('testStarted')
      expect(ack!.testCount).toBe(1)
      expect(target.hits).toEqual(['/in-process-thing'])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('an input naming scope is refused by the input check before anything is read', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-headless', false)

      const { error } = await invokeRunsStartOutcome(
        fixture,
        { scope: { tier: 'product', key: 'shop' } } as RunsStartInput,
        { resolveExecutionContext: () => 'local-headless' },
      )

      expect((error as Error).name).toBe('FunctionInputError')
      expect((error as Error).message).toContain('scope')
      // The strict input check runs before the binding, so nothing was read, decided or minted.
      expect(runDirs(fixture)).toEqual([])
      expect(buildOrdinalsExist(fixture)).toBe(false)
      expect(target.hits).toEqual([])
      expect(opAuditRows(fixture)).toEqual([])
      expect(auditRows(fixture)).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------
// THE TYPED DOOR'S IDENTITY REFUSALS, AND THE DOOR CENSUS (2026-08-23, plan 20 · CR-04).
//
// D-16's rule applied to a new refusal: reaching through the same seam is MEASURED per door, never
// assumed. The environment door is measured on the process a person starts
// (`commands/__tests__/run-gate.e2e.test.ts`); this file measures the typed door, where a caller
// gets a typed refusal instead of a stderr line and where a PATH-SHAPED id is answered by a
// different mechanism entirely — the codec, at parse, before the op is invoked at all.

/** The digest of every file in a run's directory. "Untouched" has to be a claim about bytes. */
function digestsUnder(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {}
  const digests: Record<string, string> = {}
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (!statSync(path).isFile()) continue
    digests[name] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return digests
}

describe('the typed door refuses a malformed or colliding run id (CR-04)', () => {
  it('a PATH-SHAPED id is refused by the CODEC, before the op runs at all', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-headless', false)

      const { ack, error } = await invokeRunsStartOutcome(
        fixture,
        { patterns: [fixture.testPattern], runId: '../../escape' as never },
        { resolveExecutionContext: () => 'local-headless' },
      )

      expect(ack).toBeUndefined()
      expect(error).toBeDefined()
      // Pre-fix this exact request was ACKNOWLEDGED, naming `../../escape`, with the run's own
      // artifacts written into `.agent-qa/runs/escape/`.
      expect(runDirs(fixture)).toEqual([])
      expect(existsSync(join(fixture.project, '.agent-qa', 'runs', 'escape'))).toBe(false)
      expect(target.hits).toEqual([])
      // 432-13: the op-gate row that discriminated this cell from the next is gone with the gate;
      // the next cell's typed `RunIdNotMintedError` is what tells the two refusals apart now.
      expect(opAuditRows(fixture)).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('an id the system would not have MINTED is refused by the core, by name', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-headless', false)

      const { ack, error } = await invokeRunsStartOutcome(
        fixture,
        { patterns: [fixture.testPattern], runId: 'not-a-minted-id' as never },
        { resolveExecutionContext: () => 'local-headless' },
      )

      expect(ack).toBeUndefined()
      expect(error).toBeInstanceOf(RunIdNotMintedError)
      expect((error as Error).message).toContain('not-a-minted-id')
      // It passed the CODEC — `not-a-minted-id` is a perfectly good path segment — so the op DID
      // run (432-13: with no gate row). The run itself never started.
      expect(opAuditRows(fixture)).toEqual([])
      expect(runDirs(fixture)).toEqual([])
      expect(buildOrdinalsExist(fixture)).toBe(false)
      expect(target.hits).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('a COLLIDING id is refused, and the victim run is byte-identical after', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-headless', false)
      const victimId = generateRunId()

      const first = await invokeRunsStart(
        fixture,
        { patterns: [fixture.testPattern], runId: victimId as never },
        { resolveExecutionContext: () => 'local-headless' },
      )
      expect(first.runId).toBe(victimId)
      const victimDir = join(fixture.project, '.agent-qa', 'runs', victimId)
      const before = digestsUnder(victimDir)
      // Non-vacuity: the victim really holds the artifacts a collision would tamper with.
      expect(Object.keys(before)).toContain('events.jsonl')
      expect(Object.keys(before)).toContain('handoff.json')
      const hitsAfterFirst = [...target.hits]

      const { ack, error } = await invokeRunsStartOutcome(
        fixture,
        { patterns: [fixture.testPattern], runId: victimId as never },
        { resolveExecutionContext: () => 'local-headless' },
      )

      expect(ack).toBeUndefined()
      expect(error).toBeInstanceOf(RunIdAlreadyInUseError)
      expect((error as Error).message).toContain(victimId)
      // THE WHOLE CLAIM, at bytes. Measured pre-fix through this very door: `events.jsonl` grew
      // 2111 → 4221 bytes (7 → 14 envelopes) and `handoff.json` was overwritten in place.
      expect(digestsUnder(victimDir)).toEqual(before)
      // No SECOND run directory either — the refusal did not divert the run elsewhere.
      expect(runDirs(fixture).map((dir) => dir.split('/').pop())).toEqual([victimId])
      // …and it cost the target nothing, so it landed above assembly.
      expect(target.hits).toEqual(hitsAfterFirst)
    } finally {
      await target.close()
    }
  }, 240_000)

  it('THE CONTROL — a minted, free id is acknowledged and the run happens under it', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })
      pinAmbient('local-headless', false)
      const mintedId = generateRunId()

      const ack = await invokeRunsStart(
        fixture,
        { patterns: [fixture.testPattern], runId: mintedId as never },
        { resolveExecutionContext: () => 'local-headless' },
      )

      // The run every refusal cell above says did not happen is this one: same door, same request,
      // one field different.
      expect(ack.runId).toBe(mintedId)
      expect(runDirs(fixture).map((dir) => dir.split('/').pop())).toEqual([mintedId])
      expect(eventTypes(fixture)).toContain('runStarted')
      expect(buildOrdinalsExist(fixture)).toBe(true)
      expect(target.hits).toEqual(['/in-process-thing'])
    } finally {
      await target.close()
    }
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------
// THE DOOR CENSUS — every production site that can name the run id a run executes under.
//
// TWO PREDICATES, DIFFERENT IN SHAPE, because one door is not a request field at all:
//
//   E1  REQUEST-shaped. Every production site that puts a `runId` onto the object the run seam
//       reads. Compared against a written role table, never against its own output.
//   E2  ENVIRONMENT-shaped. Every production read of `AGENT_QA_RUN_ID`. E1 cannot see this door's
//       ORIGIN — the value becomes an ordinary local long before it reaches a request literal —
//       and it is the ONE door the typed codec does not range.
//
// THE COMMENT STRIPPER IS PART OF THE PREDICATE, and the idiom this repo has been using is blind.
// `// … could not touch \`daemon/**\` that wave` (daemon/host.ts:642) is a LINE comment containing
// `/*`; a stripper that removes block comments first and line comments second treats that `/*` as
// the start of a block and swallows every byte up to the next `*/` — 1,816 characters of
// `daemon/host.ts`, and 10,575 of `android/src/adapter.ts`. Measured: under the two-pass stripper
// E1 below returns SIX files and the daemon door is not one of them. Under the one-pass
// alternation it returns seven. A census cannot be more complete than its stripper.
describe('the door census — every way a caller can name a run id (CR-04)', () => {
  const PACKAGES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

  /**
   * ONE PASS, so neither comment form can begin inside the other.
   *
   * The residual limitation, stated rather than left to be discovered: a comment opener inside a
   * STRING literal is still mistaken for one. What changes is the blast radius — a `/*` in a
   * string no longer swallows every byte up to the next `*` + `/`, it loses that one line.
   */
  function stripComments(source: string): string {
    return source.replace(
      /\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm,
      (_match, kept?: string) => kept ?? '',
    )
  }

  function shippedSourceFiles(): string[] {
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules'
            || entry.name === 'dist' || entry.name === 'coverage') continue
          walk(path)
          continue
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
        found.push(path)
      }
    }
    for (const pkg of readdirSync(PACKAGES_ROOT, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const src = join(PACKAGES_ROOT, pkg.name, 'src')
      if (existsSync(src)) walk(src)
    }
    return found
  }

  const REQUEST_RUN_ID_RE = /runId:\s*(?:asRunId\(|opts\.runId|request\.runId\b)/
  const ENV_RUN_ID_RE = /AGENT_QA_RUN_ID/

  /** Files the census MUST range, named rather than read off the scan (the 399/400 scar). */
  const REQUIRED_MEMBERS = [
    join('cli', 'src', 'commands', 'run.ts'),
    join('cli', 'src', 'commands', 'dashboard.ts'),
    join('cli', 'src', 'daemon', 'host.ts'),
    join('cli', 'src', 'composition', 'in-process-run-execution.ts'),
    join('agent', 'src', 'functions', 'ops', 'runs-start.ts'),
    join('mcp', 'src', 'mapping.ts'),
  ] as const

  /**
   * THE ROLE TABLE — every E1 site, and what it is. `reaches` answers the only question that
   * matters: does an id named here arrive at the invocation core's identity step, and therefore
   * inherit BOTH refusals? A site that did not would have to be routed through them or recorded,
   * with evidence, as unable to collide — and recording it here is what makes that visible.
   */
  const E1_SITES: Readonly<Record<string, { role: string; reaches: boolean; verdict: string }>> = {
    'agent-local/src/composition/run-invocation-core.ts': {
      role: 'the identity step itself',
      reaches: true,
      verdict:
        'not a door — this is where the refusals live. It matches E1 because the collision test '
        + 'reads `request.runId`, which is exactly the value under judgement.',
    },
    'cli/src/commands/run.ts': {
      role: 'door: `agent-qa run`, both paths',
      reaches: true,
      verdict:
        'THE DOOR THE CODEC DOES NOT RANGE — the request literal is built in-process from '
        + '`AGENT_QA_RUN_ID ?? generateRunId()`, so no parse happens. It reaches the core, which is '
        + 'why the shape refusal lives there. Cells: `commands/__tests__/run-gate.e2e.test.ts`.',
    },
    'cli/src/commands/dashboard.ts': {
      role: 'door: the dashboard run button',
      reaches: true,
      verdict:
        "names the enqueued row's id on a `RunsStartInput` and goes through `invokeFunction` — "
        + 'deliberately, per D-10, so it cannot skip the op gate. Same parse, same core.',
    },
    'cli/src/daemon/host.ts': {
      role: 'door: the daemon RPC',
      reaches: true,
      verdict:
        'a different COMPOSITION of the same op: it binds a `RunExecutionPort` over the drive, so '
        + 'the request it forwards is already parsed and the drive composes the core. THE SITE THE '
        + 'TWO-PASS STRIPPER HID — see this describe block\'s header.',
    },
    'cli/src/composition/in-process-run-execution.ts': {
      role: 'the drive',
      reaches: true,
      verdict:
        "not a caller door — it is the core's one composition. It forwards `request.runId` and "
        + 'mints a fallback, so every id above passes through here on its way to the identity step.',
    },
    'dashboard-server/src/execution/in-process-backend.ts': {
      role: 'door origin: the enqueued row',
      reaches: true,
      verdict:
        'hands `opts.runId` to the `invokeRun` port, which `commands/dashboard.ts` implements by '
        + 'invoking the op. The id is minted by the queue; the parse and the core are the row above.',
    },
    'cli/src/curation/post-run-tail.ts': {
      role: 'not a run-start site',
      reaches: false,
      verdict:
        'UNABLE TO COLLIDE, with evidence: it names the id of a run that has already FINISHED, to '
        + 'enqueue and drain that run\'s own post-run chain. It calls nothing that starts a run — '
        + '`run-door-invocation-census.test.ts` makes the complete-set claim that no file in this '
        + 'package acquires `startRun`, and the STARTRUN_PIN now build-enforces it repo-wide.',
    },
    'dashboard-ui/src/hooks/use-evidence-records.ts': {
      role: 'read: evidence for an existing run',
      reaches: false,
      verdict:
        'UNABLE TO COLLIDE: fetchRunEvidence reads records for an existing run through the '
        + 'dashboard evidence API. It does not invoke run creation; the hook remains scanned '
        + 'and the dedicated E1 read-classification cell pins this distinction.',
    },
  }

  it('the scanned set ranges the files the claim is about — the discovery self-check', () => {
    const scanned = shippedSourceFiles().map((path) => relative(PACKAGES_ROOT, path))
    expect(scanned.length).toBeGreaterThan(500)
    for (const member of REQUIRED_MEMBERS) {
      expect(scanned, `the census is not ranging ${member}`).toContain(member)
    }
  })

  it('the stripper sees a line comment that contains a block-comment opener', () => {
    // The exact shape that hid the daemon door. Under the two-pass idiom the `const` below
    // disappears with everything after it up to the next `*/`.
    const source = ['// could not touch `daemon/**` that wave', 'const x = 1', '/** doc */'].join('\n')
    expect(stripComments(source)).toContain('const x = 1')
    // …and it still removes what it is supposed to remove.
    expect(stripComments('const y = 2 // startRun used to be here')).not.toContain('used to be here')
    expect(stripComments('/* runId: asRunId(x) */\nconst z = 3')).not.toContain('asRunId')
    // The protocol-relative-URL trap.
    expect(stripComments("const u = 'https://example.com' // t")).toContain('https://example.com')
  })

  it('E1 — every production site naming a runId on a run request carries a role', () => {
    // Self-check first: the predicate can see the forms the doors actually use.
    expect(REQUEST_RUN_ID_RE.test('        runId: asRunId(runId),')).toBe(true)
    expect(REQUEST_RUN_ID_RE.test("  runId: opts.runId as RunsStartInput['runId'],")).toBe(true)
    expect(REQUEST_RUN_ID_RE.test('runDirFor({ configDir, runId: request.runId })')).toBe(true)
    expect(REQUEST_RUN_ID_RE.test('  runId: someOtherThing,')).toBe(false)

    const found = shippedSourceFiles()
      .filter((path) => REQUEST_RUN_ID_RE.test(stripComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(PACKAGES_ROOT, path).replaceAll(sep, '/'))

    expect(found.sort()).toEqual(Object.keys(E1_SITES).sort())
    for (const site of Object.values(E1_SITES)) {
      expect(site.verdict.trim()).not.toEqual('')
      expect(site.role.trim()).not.toEqual('')
    }
  })

  it('E2 — the environment door has exactly one production origin, and it is a listed site', () => {
    const found = shippedSourceFiles()
      .filter((path) => ENV_RUN_ID_RE.test(stripComments(readFileSync(path, 'utf8'))))
      .map((path) => relative(PACKAGES_ROOT, path).replaceAll(sep, '/'))

    expect(found).toEqual(['cli/src/commands/run.ts'])
    expect(Object.hasOwn(E1_SITES, found[0]!)).toBe(true)
    // …and that door does NOT parse, which is the whole reason the core carries the shape refusal.
    // Stated as a property of the file rather than as prose: the request it builds is a literal,
    // and `RunsStartInputSchema` is not named on the road from the environment read to the drive.
    const source = stripComments(readFileSync(join(PACKAGES_ROOT, ...found[0]!.split('/')), 'utf8'))
    expect(source).toContain('process.env.AGENT_QA_RUN_ID')
    expect(source).not.toContain('RunsStartInputSchema')
  })

  it('E1 — the evidence-read hook stays scanned and is classified as unable to start a run', () => {
    const file = 'dashboard-ui/src/hooks/use-evidence-records.ts'
    const source = stripComments(readFileSync(join(PACKAGES_ROOT, file), 'utf8'))
    expect(shippedSourceFiles()).toContain(join(PACKAGES_ROOT, file))
    expect(REQUEST_RUN_ID_RE.test(source)).toBe(true)
    expect(E1_SITES[file]?.reaches).toBe(false)
    expect(E1_SITES[file]?.role).toBe('read: evidence for an existing run')
    expect(source).toMatch(/fetchRunEvidence\(\{\s*runId:\s*asRunId\(runId\)/)
    expect(source).not.toMatch(/\b(?:startRun|invokeRun|invokeFunction)\s*\(/)
  })

  it('every E1 site either reaches the identity step or is recorded as unable to collide', () => {
    const bypassing = Object.entries(E1_SITES).filter(([, site]) => !site.reaches)
    expect(bypassing.map(([file]) => file)).toEqual([
      'cli/src/curation/post-run-tail.ts',
      'dashboard-ui/src/hooks/use-evidence-records.ts',
    ])
    expect(bypassing[0]![1].verdict).toContain('already FINISHED')
    expect(bypassing[1]![1].verdict).toContain('fetchRunEvidence reads records for an existing run')
  })
})
