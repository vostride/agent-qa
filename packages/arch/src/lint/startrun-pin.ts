// The startRun() named-set pin (2026-08-23, Phase 401 plan 20 · W-2 · INVK-02 criterion 2).
//
// THIS IS NOW THE ONE ARCHITECTURE PIN ON A RUN. The evaluate()
// gate pin it was written beside is deleted with the gate; its scanner helpers stay in
// `evaluate-pin.ts`, which this file imports. What a run must pass on its way in is the core's
// request and run-id refusals, and a second file acquiring the starter would walk past them
// exactly as it once would have walked past the gate. The history below is kept as written.
//
// WHAT IT POLICES. `startRun` is the run shell's entry point: calling it BEGINS a run — a browser,
// a build-ordinal advance, a run directory, a baseline probe against the target. Criterion 2 says
// there is exactly one call site, inside the policy-gated invocation core, one line below the one
// `evaluate()`. That was TRUE before this file existed and nothing enforced it: `EVALUATE_PIN`
// polices the gate, and a second file that acquired the run STARTER would walk past the gate
// entirely while every evaluate-pin cell stayed green.
//
// THE PERMITTED SET IS DERIVED FROM A CENSUS, NOT FROM A CHAIN SOMEBODY WROTE DOWN. This matters
// here more than it usually does. WR-03's dispatch chain routes gate-runs through
// `draftShelf.runs.start` (`compose-local-agent.ts` ~3159) — and `401-UAT-item09-D08-chain.md`
// F-1 MEASURED that seam being reached ZERO times during a full authoring dispatch: a mutation
// applied there left the chain's own cell green, and the seam was then instrumented directly
// (`grep -c "M2A-SEAM-REACHED"` → 0). The link gate-runs actually take is
// `createDraftEvaluation.startGateRun`. A pin whose permitted set had been transcribed from that
// prose would have policed a seam no run ever touches, and its green would have looked like a fix.
//
// So the set below comes from scanning the workspace, cross-checked against that measured chain:
// NEITHER `startGateRun` NOR `draftShelf.runs.start` acquires the run starter. Both reach a run the
// long way, through `invokeFunction('runs.start')` → the bound run invocation → the drive → the
// core — which is exactly the property this pin exists to keep true, and is why neither is an entry.
//
// WHAT COUNTS AS ACQUISITION, and where it differs from the gate pin.
//
//   THE SHELL MODULE (`packages/runner/src/run/shell`): any VALUE counts. Everything that module
//     publishes is run-shell machinery, so a factory added beside `startRun` cannot be used to
//     acquire the same power under another name. Same rule as the gate module.
//
//   THE RUNNER BARREL (`@vostride/agent-qa-runner`): only the named symbol counts — and this is
//     where the two pins have to differ. `@vostride/agent-qa-safety` is a small gate package;
//     the runner barrel publishes the platform, model, hook, action and event vocabulary half the
//     workspace legitimately imports. Treating a WHOLE-MODULE acquisition of it as gate power (the
//     evaluate-pin rule) would make offenders of ~15 files that dynamically load the barrel for an
//     action cache or a storage-state port, and a pin that fires on fifteen innocent files is a
//     pin everybody learns to silence.
//
//     So a whole-module acquisition of the BARREL is an acquisition only when the file also names
//     the symbol in a code position — `const { startRun } = await import(...)`,
//     `(await import(...)).startRun(...)`, `runner.startRun(...)`. That conjunction is narrower
//     than "any whole-module load" and strictly wider than "a named import", and it is what makes
//     the dynamic road closed rather than merely undocumented. Its residual gap, said plainly: a
//     COMPUTED property access (`ns['start' + 'Run']`) defeats it, exactly as it defeats the gate
//     pin. No scanner short of a type-checker catches that one.
//
// Detection keys on module STATEMENTS, never on call tokens, and the scanner is `evaluate-pin.ts`'s
// — imported rather than re-implemented. Two detectors for two pins would be free to disagree about
// what an acquisition is.

import {
  normalizeRepoPath,
  parseModuleStatements,
  readClause,
  resolveRelative,
  stripCodeComments,
} from './evaluate-pin.js'

/** The runner package's published name — the specifier the core acquires the symbol by. */
export const RUNNER_PACKAGE_SPECIFIER = '@vostride/agent-qa-runner'

/** The run shell itself, repo-relative and extensionless. The barrel's target. */
export const RUN_SHELL_MODULE = 'packages/runner/src/run/shell'

/** The pinned symbol. An alias changes the local name, never the imported one. */
export const STARTRUN_SYMBOL = 'startRun'

/**
 * The exact production file set permitted to acquire the run starter, each entry carrying the
 * reason a reader needs: why this file may begin a run.
 *
 * TWO ENTRIES, and the DEFINITION SITE is not one of them — `packages/runner/src/run/shell.ts`
 * declares the function and acquires nothing, exactly as `policy/gate.ts` was absent from the
 * deleted evaluate() pin. Test files are out of scope by construction: the scan is fed through `sourceFilesFor`,
 * which drops `__tests__`.
 */
export const STARTRUN_PIN: Readonly<Record<string, string>> = {
  'packages/runner/src/index.ts':
    'The export seam (2026-08-23): re-export only. Nothing in this file starts a run; it republishes the shell entry point so the invocation core can acquire it across a package boundary at all. Present for the same reason safety\'s barrel was in the deleted evaluate() pin (432-19) — a detector keyed on the import keyword alone would report this file as a stale entry and fail the build for the wrong reason.',
  'packages/agent-local/src/composition/run-invocation-core.ts':
    'The ONE call site: the in-process invocation core, below its request and run-id refusals. Every trigger — `agent-qa run`, the fn/chat/MCP `runs.start` op, the daemon, the dashboard — reaches a run through here, so a second entry in this map would be a second way to begin a run without passing those refusals. Cross-checked against the measured dispatch chain (`401-UAT-item09-D08-chain.md`): the gate-run road runs `createDraftEvaluation.startGateRun` → `invokeFunction(\'runs.start\')` → the bound invocation → the drive → this file, and acquires the starter at no point above it.',
}

export interface StartRunPinSource {
  /** Repo-relative, forward-slash path. */
  file: string
  source: string
}

/** How a statement got hold of the module's values. */
export type StartRunAcquisitionForm = 'named' | 'whole-module'

export interface StartRunAcquisition {
  file: string
  line: number
  keyword: 'import' | 'export'
  specifier: string
  form: StartRunAcquisitionForm
}

const WHOLE_MODULE_CALL_RE = /\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/g

/** The symbol in a CODE position — the conjunct that makes a barrel namespace an acquisition. */
const SYMBOL_IN_CODE_RE = new RegExp(`\\b${STARTRUN_SYMBOL}\\b`)

type ShellRelevance = 'barrel' | 'shell-module' | 'none'

function shellRelevance(file: string, specifier: string): ShellRelevance {
  if (
    specifier === RUNNER_PACKAGE_SPECIFIER
    || specifier.startsWith(`${RUNNER_PACKAGE_SPECIFIER}/`)
  ) {
    return 'barrel'
  }

  if (specifier.startsWith('.') && resolveRelative(file, specifier) === RUN_SHELL_MODULE) {
    return 'shell-module'
  }

  return 'none'
}

/**
 * Every statement in one file that acquires the power to start a run.
 *
 * Type-only acquisitions count for neither relevance: a type is erased before anything runs, so a
 * file holding one cannot call the shell — and half this workspace legitimately imports
 * `RunConfig`, `TestResult` and `PlatformAdapter` as types from the same barrel.
 */
export function findStartRunAcquisitions(
  source: string,
  file: string,
): StartRunAcquisition[] {
  const normalized = normalizeRepoPath(file)
  const stripped = stripCodeComments(source)
  const namesSymbolInCode = SYMBOL_IN_CODE_RE.test(stripped)
  const acquisitions: StartRunAcquisition[] = []

  for (const statement of parseModuleStatements(source)) {
    const relevance = shellRelevance(normalized, statement.specifier)
    if (relevance === 'none') continue

    const shape = readClause(statement.clause)
    if (shape.typeOnly) continue

    const acquires = relevance === 'shell-module'
      ? shape.wholeModule || shape.valueNames.length > 0
      // From the BARREL: the named symbol always, a namespace only when the file also names the
      // symbol in code. See this module's header for why the two pins differ here.
      : shape.wholeModule
        ? namesSymbolInCode
        : shape.valueNames.includes(STARTRUN_SYMBOL)
    if (!acquires) continue

    acquisitions.push({
      file: normalized,
      line: statement.line,
      keyword: statement.keyword,
      specifier: statement.specifier,
      form: shape.wholeModule ? 'whole-module' : 'named',
    })
  }

  const lines = stripped.split('\n')
  lines.forEach((text, index) => {
    for (const match of text.matchAll(WHOLE_MODULE_CALL_RE)) {
      const specifier = match[2] ?? ''
      const relevance = shellRelevance(normalized, specifier)
      if (relevance === 'none') continue
      if (relevance === 'barrel' && !namesSymbolInCode) continue
      acquisitions.push({
        file: normalized,
        line: index + 1,
        keyword: 'import',
        specifier,
        form: 'whole-module',
      })
    }
  })

  return acquisitions
}

/**
 * The pin, in both directions.
 *
 *   1. a file that acquires the run starter and is absent the pin is an offender;
 *   2. a pin entry that no longer acquires it is a STALE offender.
 *
 * Direction 2 is the half a first implementation forgets, and the half that keeps the pin honest
 * as code moves: when a later phase relocates the composition root or re-exports the shell from
 * somewhere else, an entry left behind fails the build instead of quietly widening the set.
 */
export function findStartRunPinOffenders(
  sources: readonly StartRunPinSource[],
): string[] {
  const offenders: string[] = []
  const acquiring = new Set<string>()

  for (const entry of sources) {
    for (const acquisition of findStartRunAcquisitions(entry.source, entry.file)) {
      acquiring.add(acquisition.file)
      if (Object.hasOwn(STARTRUN_PIN, acquisition.file)) continue
      offenders.push(
        `startrun-pin: ${acquisition.file}:${acquisition.line} ⇏ ${acquisition.specifier} (un-pinned run-starter acquisition)`,
      )
    }
  }

  for (const file of Object.keys(STARTRUN_PIN).sort()) {
    if (acquiring.has(file)) continue
    offenders.push(`startrun-pin: ${file} ⇏ pin entry no longer acquires the run starter (stale)`)
  }

  return offenders
}
