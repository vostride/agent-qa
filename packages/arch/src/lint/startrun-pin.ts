// A whole-module load of the runner barrel counts only when the file also names `startRun`.

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

// The definition site acquires nothing, so it is not listed; `sourceFilesFor` drops `__tests__`.
export const STARTRUN_PIN: Readonly<Record<string, string>> = {
  'packages/runner/src/index.ts':
    'The export seam: re-export only. Nothing in this file starts a run; it republishes the shell entry point so the invocation core can acquire it across a package boundary at all. A detector keyed on the import keyword alone would report this file as a stale entry and fail the build for the wrong reason.',
  'packages/agent-local/src/composition/run-invocation-core.ts':
    'The ONE call site: the in-process invocation core, below its request and run-id refusals. Every trigger — `agent-qa run`, the fn/chat/MCP `runs.start` op, the daemon, the dashboard — reaches a run through here, so a second entry in this map would be a second way to begin a run without passing those refusals. In the measured dispatch chain, the gate-run road runs `createDraftEvaluation.startGateRun` → `invokeFunction(\'runs.start\')` → the bound invocation → the drive → this file, and acquires the starter at no point above it.',
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

// Both directions fail: an unlisted acquirer, and an entry left stale when code moves.
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
