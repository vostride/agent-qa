// THE HOST-TERMINATION CENSUS (Phase 401 plan 11, T-401-31).
//
// THE CLAIM. No module on the in-process invocation path can terminate its host. Every input
// failure is a typed `CliRunInputError` carrying its own exit code and its own rendered lines, and
// the DOOR — the one thing with a terminal and a process to own — decides what to do with it.
//
// WHY IT NEEDS A CENSUS RATHER THAN A GREP. This is a COMPLETE-SET claim over a module graph, and a
// rule that can only refuse what it can NAME cannot be driven to zero by naming more things. So the
// predicate is self-checked before it is allowed to judge anything, the discovery is pinned to named
// known members with a floor, and the one file that legitimately keeps its exits is carved out
// EXPLICITLY — with a converse witness proving it still has them, because a green census over an
// idea somebody deleted is the 399/400 scar.
//
// THREE PARTS, IN ORDER:
//
//   (i)   the predicate self-check — every acquisition form of the host-terminating call is planted
//         in synthetic source and must be SEEN; the same names in prose must NOT be; and the comment
//         stripper must not eat a protocol-relative URL;
//   (ii)  pinned discovery + the complete-set claim over the in-process module closure, with
//         `commands/run.ts` scanned through its PINNED EXPORTS and their run.ts-local call graph
//         TRANSITIVELY — a pinned export's body is not the code it runs;
//   (iii) the behavioural failure-door register: every input-failure door driven for real with the
//         host-terminating call stubbed to throw a marker, asserting the typed error arrives and
//         the marker never does.
//
// WHAT PART (ii) ALREADY CAUGHT, on the run that first wrote it: `resolveSelectedAuthStateForRun`
// and `resolveAuthStateCapturePathsForRun` both ended `console.error(...); process.exit(2)` and both
// sit TWO calls from the in-process path (`produceMembersFromPatterns` → `produceDirectRunMembers` →
// the member closure → here). A scan that stopped at the exported bodies would have declared the
// path clean while a daemon serving a run with a bad auth-state config died on it. They are typed
// refusals now. That is the transitive walk earning its keep, not a hypothetical.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { CliRunInputError, runInProcessCliRun } from '../in-process-run-execution.js'
import { requireReporterSelection } from '../../commands/run.js'
import type { RunOptions } from '../../commands/run.js'
import {
  CountingTarget,
  createInProcessFixture,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { closeTestRunRecords, testRunRecord } from './in-process-run-fixture.js'

// 2026-10-17 (443-08, D-22): every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })
afterAll(() => { removeInProcessFixtures() })

const CLI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENTRY = join(CLI_SRC, 'composition', 'in-process-run-execution.ts')
const RUN_TS = join(CLI_SRC, 'commands', 'run.ts')

// ---------------------------------------------------------------------------------------------
// (i) THE PREDICATE
// ---------------------------------------------------------------------------------------------

/**
 * Drop block and line comments so a name that appears only in prose is never read as code.
 *
 * THE `[^:]` GUARD IS LOAD-BEARING: without it a protocol-relative URL (`https://…`) is mistaken
 * for a line comment and the rest of the line is eaten, which is how this kind of stripper usually
 * destroys the very code it is supposed to scan.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Every way a module can acquire the host-terminating call, as a COMPLETE SET.
 *
 * The plain call is the one everybody remembers. The others are the ones a "fix" reaches for once
 * the plain one is forbidden: a spaced call, a bracket access, a destructured alias, `abort` instead
 * of `exit`, and a namespace alias that renames `process` itself.
 */
const TERMINATION_FORMS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: 'plain call', pattern: /\bprocess\s*\.\s*(?:exit|abort)\s*\(/ },
  { label: 'bracket access', pattern: /\bprocess\s*\[\s*['"`](?:exit|abort)['"`]\s*\]/ },
  {
    label: 'destructured alias',
    pattern: /(?:const|let|var)\s*\{[^}]*\b(?:exit|abort)\b[^}]*\}\s*=\s*process\b/,
  },
  { label: 'namespace alias', pattern: /(?:const|let|var)\s+[\w$]+\s*=\s*process\s*(?:;|$)/m },
]

function terminationHits(source: string): string[] {
  const code = stripComments(source)
  return TERMINATION_FORMS.filter((form) => form.pattern.test(code)).map((form) => form.label)
}

describe('(i) the scanner sees what it forbids — before any verdict about any module', () => {
  it('detects every acquisition form in planted source', () => {
    const planted: ReadonlyArray<[string, string]> = [
      ['plain call', 'process.exit(2)\n'],
      ['plain call', 'process . exit (2)\n'],
      ['bracket access', "process['exit'](2)\n"],
      ['destructured alias', 'const { exit } = process\nexit(2)\n'],
      ['plain call', 'process.abort()\n'],
      ['namespace alias', 'const p = process;\np.exit(2)\n'],
    ]
    for (const [label, source] of planted) {
      expect(
        terminationHits(source),
        `the scan cannot see the ${label} form — every module below would pass vacuously`,
      ).toContain(label)
    }
  })

  it('does not fire on the name in prose', () => {
    expect(terminationHits('// this module never calls process.exit(1)\n')).toEqual([])
    expect(terminationHits('/* no process.exit(0) here */\nconst x = 1\n')).toEqual([])
  })

  it('does not eat a protocol-relative URL', () => {
    expect(stripComments("const url = 'https://example.com' // trailing\n")).toContain(
      'https://example.com',
    )
  })
})

// ---------------------------------------------------------------------------------------------
// (ii) PINNED DISCOVERY + THE COMPLETE-SET CLAIM
// ---------------------------------------------------------------------------------------------

/** Every first-party module under `packages/cli/src` the in-process entry point can load. */
function inProcessModuleClosure(): string[] {
  const seen = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const match of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      let target = resolve(dirname(file), match[1]!).replace(/\.js$/, '.ts')
      if (!existsSync(target)) target = target.replace(/\.ts$/, '/index.ts')
      if (existsSync(target) && target.startsWith(CLI_SRC)) walk(target)
    }
  }
  walk(ENTRY)
  return [...seen].sort()
}

/**
 * The symbols the composition module imports FROM `commands/run.ts`, pinned by NAME.
 *
 * A symbol added to that import list without being added here is a FAILURE — which is the point: it
 * is what makes the carve-out a bounded allowance rather than a hole shaped like a whole file.
 */
const PINNED_RUN_TS_IMPORTS = [
  // 401-20 (CR-04): the mint's inverse. `isMintedRunId` is a REQUIRED core option with no default,
  // and it travels the same relative route the mint does — a shape check invented in `agent-local`
  // would be a second spelling of a run's identity.
  'isMintedCliRunId',
  'mintCliRunId',
  'produceMembersFromPatterns',
  'resolveRunInvocationInputs',
] as const

/**
 * Members of the run.ts-local reachable set that MUST be reached, pinned exactly as the discovery
 * walker is pinned.
 *
 * A walker that stops reaching them has stopped ranging the claim, and that has to FAIL rather than
 * sweep clean. All three were measured reachable, and two of them (`loadRuntimeSecrets`,
 * `discoverFilesForCliPatterns`) held terminating calls before this plan converted them.
 */
const REQUIRED_REACHABLE_MEMBERS = [
  'loadRuntimeSecrets',
  'discoverFilesForCliPatterns',
  'acquireAppium',
  'produceDirectRunMembers',
  'produceSuiteRunMembers',
] as const

/** The floor: a walker rooted at a wrong-but-existing directory cannot return a clean sweep. */
const CLOSURE_FLOOR = 20
const REACHABLE_FLOOR = 30

interface RunTsDeclaration {
  readonly name: string
  readonly body: string
}

/**
 * Top-level declarations of `run.ts`, by SPAN rather than by brace matching.
 *
 * Every top-level declaration in this file starts at column zero, so a declaration's body is the
 * lines from its own header to the line before the next one. That is exact without needing a parser
 * that understands strings, template literals and regex literals — and a parser that got any of
 * those wrong would silently mis-scope a body, which is the failure mode this avoids.
 */
function runTsDeclarations(): Map<string, RunTsDeclaration> {
  const lines = stripComments(readFileSync(RUN_TS, 'utf8')).split('\n')
  const header = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/
  const starts: Array<{ name: string; start: number }> = []
  lines.forEach((line, index) => {
    const match = line.match(header)
    if (match) starts.push({ name: match[1]!, start: index })
  })
  const declarations = new Map<string, RunTsDeclaration>()
  starts.forEach((decl, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]!.start : lines.length
    declarations.set(decl.name, { name: decl.name, body: lines.slice(decl.start, end).join('\n') })
  })
  return declarations
}

/** The run.ts-local call graph reachable from the pinned exports, TRANSITIVELY. */
function reachableFromPinnedExports(): Map<string, RunTsDeclaration> {
  const declarations = runTsDeclarations()
  const reached = new Map<string, RunTsDeclaration>()
  const queue: string[] = [...PINNED_RUN_TS_IMPORTS]
  while (queue.length > 0) {
    const name = queue.pop()!
    if (reached.has(name)) continue
    const declaration = declarations.get(name)
    if (declaration === undefined) continue
    reached.set(name, declaration)
    for (const identifier of declaration.body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const called = identifier[1]!
      if (declarations.has(called) && !reached.has(called)) queue.push(called)
    }
  }
  return reached
}

describe('(ii) no module on the in-process path can terminate its host', () => {
  it('the discovery set is pinned to named members and has a floor', () => {
    const closure = inProcessModuleClosure().map((file) => file.slice(CLI_SRC.length + 1))
    // Named known members: the entry point, the assembler it composes, and the file whose producers
    // it imports. A walker that returned a clean sweep without these was rooted somewhere else.
    expect(closure).toContain('composition/in-process-run-execution.ts')
    expect(closure).toContain('composition/run-assembly.ts')
    expect(closure).toContain('commands/run.ts')
    expect(closure).toContain('run-session-composition.ts')
    expect(closure.length).toBeGreaterThanOrEqual(CLOSURE_FLOOR)
  })

  it('every module in the closure EXCEPT the command file is free of terminating calls', () => {
    const offenders: string[] = []
    for (const file of inProcessModuleClosure()) {
      if (file === RUN_TS) continue
      const hits = terminationHits(readFileSync(file, 'utf8'))
      if (hits.length > 0) offenders.push(`${file.slice(CLI_SRC.length + 1)} (${hits.join(', ')})`)
    }
    expect(offenders, 'a module on the in-process path can terminate its host').toEqual([])
  })

  it('THE CONVERSE WITNESS — the command file still holds its own exits', () => {
    // Without this the census cannot tell "the door kept its exits and the modules have none" from
    // "somebody deleted the concept". `--list-tests`, `--dry-run`, the suite early return, the two
    // shutdown controllers and the three terminal verdict exits all still live here, by design.
    const code = stripComments(readFileSync(RUN_TS, 'utf8'))
    expect((code.match(/\bprocess\s*\.\s*exit\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(8)
  })

  it('ROUTE 2 — the module imports from run.ts are pinned to a named allow-set', () => {
    const entry = stripComments(readFileSync(ENTRY, 'utf8'))
    const block = entry.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/commands\/run\.js'/)
    expect(block, 'the composition module no longer imports from commands/run.ts').not.toBeNull()
    const imported = block![1]!
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .sort()
    // Set equality, not containment: a symbol added to the import list without being added to the
    // pinned set is a failure, and so is a pinned name the module stopped importing.
    expect(imported).toEqual([...PINNED_RUN_TS_IMPORTS].sort())
  })

  it('ROUTE 2 — the reachable call graph is pinned, has a floor, and terminates nowhere', () => {
    const reached = reachableFromPinnedExports()
    // A PINNED EXPORT'S BODY IS NOT THE CODE IT RUNS. The walk is what decides whether this scan is
    // worth anything: `loadRuntimeSecrets` held four terminating calls one hop from the entry.
    for (const required of REQUIRED_REACHABLE_MEMBERS) {
      expect(
        reached.has(required),
        `the walker stopped reaching ${required} — it has stopped ranging the claim`,
      ).toBe(true)
    }
    expect(reached.size).toBeGreaterThanOrEqual(REACHABLE_FLOOR)

    const offenders = [...reached.values()]
      .filter((declaration) => terminationHits(declaration.body).length > 0)
      .map((declaration) => declaration.name)
    expect(
      offenders,
      'a function reachable from the in-process path can terminate its host',
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// (iii) THE BEHAVIOURAL FAILURE-DOOR REGISTER
// ---------------------------------------------------------------------------------------------

/**
 * The register: one row per input-failure door, each with a fixture that REALLY provokes it.
 *
 * A row whose fixture is healthy is a row that measures nothing, so every row's `expect` names the
 * line the door renders — a row that stopped failing would stop matching it.
 */
const MARKER = 'THE MODULE TERMINATED ITS HOST'

interface RegisterRow {
  readonly door: string
  readonly fixture: Parameters<typeof createInProcessFixture>[0] extends infer T
    ? Omit<T & object, 'origin'>
    : never
  readonly exitCode: number
  readonly firstLine: string
}

const REGISTER: readonly RegisterRow[] = [
  {
    door: 'missing env file',
    fixture: { environment: 'local', omitEnvFile: true },
    exitCode: 1,
    firstLine: 'Error: Env file not found:',
  },
  {
    door: 'missing hooks file',
    fixture: { environment: 'local', omitHooksFile: true },
    exitCode: 1,
    firstLine: 'Error: Hooks file not found:',
  },
  {
    door: 'missing secrets file',
    fixture: { environment: 'local', omitSecretsFile: true },
    exitCode: 1,
    firstLine: 'Error: Secrets file not found:',
  },
  {
    door: 'zero runnable tests',
    fixture: { environment: 'local', emptyTestFile: true },
    exitCode: 2,
    firstLine: 'Error: Resolved test file(s) but found 0 runnable tests.',
  },
]

function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\[[0-9;]*m/g, ''))
}

describe('(iii) every failure door answers with a value, and none of them kills the host', () => {
  for (const row of REGISTER) {
    it(`${row.door} → CliRunInputError(exit ${row.exitCode}), marker never seen`, async () => {
      const target = new CountingTarget()
      await target.listen()
      // The host-terminating call is stubbed to THROW A MARKER. Without this, "the host survived"
      // is not something a cell can say — a real exit would take the worker with it, and a cell
      // that merely saw a throw could not tell a typed refusal from one that also tried to exit.
      const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error(MARKER)
      }) as never)
      try {
        const fixture = createInProcessFixture({ origin: target.origin, ...row.fixture })
        const browsers = join(fixture.project, 'no-browsers')
        if (!existsSync(browsers)) mkdirSync(browsers, { recursive: true })
        process.env.PLAYWRIGHT_BROWSERS_PATH = browsers

        let caught: unknown
        try {
          await runInProcessCliRun(
            {
              runRecord: testRunRecord(),
              configPath: fixture.configPath,
              agentQaRoot: fixture.agentQaRoot,
              executionContext: 'local-headless',
            },
            { patterns: [fixture.testPattern] },
          )
        } catch (err) {
          caught = err
        }

        expect(String(caught)).not.toContain(MARKER)
        expect(caught).toBeInstanceOf(CliRunInputError)
        const refusal = caught as CliRunInputError
        expect(refusal.exitCode).toBe(row.exitCode)
        expect(plain(refusal.lines)[0]).toContain(row.firstLine)
      } finally {
        spy.mockRestore()
        await target.close()
      }
    }, 120_000)
  }

  it('reporter selection → CliRunInputError(exit 2), marker never seen', async () => {
    // Driven through its exported symbol rather than through the port: a `RunsStartInput` has no
    // reporter to get wrong, so this door is unreachable from a programmatic caller — which is why
    // it is a row here and not an arm of the loop above.
    const spy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error(MARKER)
    }) as never)
    try {
      let caught: unknown
      try {
        requireReporterSelection({ reporter: ['nope'] } as unknown as RunOptions)
      } catch (err) {
        caught = err
      }
      expect(String(caught)).not.toContain(MARKER)
      expect(caught).toBeInstanceOf(CliRunInputError)
      expect((caught as CliRunInputError).exitCode).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })
})
