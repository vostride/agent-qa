import { relative, sep } from 'node:path'

import { guardJsonText } from '@vostride/agent-qa-core/run-text-output'

import { CANCELLED_LINE, CliRefusal, isPromptCancel } from '../composition/cli-refusal.js'
import type { AgentSetupFileOutcome } from './agent-setup.js'
import type { CodingAgent } from './agent-setup-manifest.js'
import type { InitFileOutcome } from './init-filesystem.js'
import type { InitStepName, InitStepRecord } from './init-steps.js'
import type { SetupRowName } from './setup-rows.js'

export type InitDocumentFileOutcome = 'created' | 'updated' | 'kept' | 'replaced' | 'removed'

export interface InitDocumentFile {
  path: string
  outcome: InitDocumentFileOutcome
  step: InitStepName
}

export interface InitDocumentModel {
  name?: string
  provider?: string
  status: 'ready' | 'pending'
  reason?: string
}

export interface InitDocumentSetupRow {
  name: SetupRowName
  state: string
  prechecked: boolean
  selected: boolean
  hidden?: string
}

export interface InitDocumentLatest {
  source: 'registry' | 'cache' | 'none'
  version?: string
}

export interface InitDocument {
  format: 1
  outcome: 'done' | 'failed' | 'refused' | 'interrupted'
  exitCode: number
  message?: string
  steps: InitStepRecord[]
  files: InitDocumentFile[]
  agents: CodingAgent[]
  packageManager?: string
  agentQa?: { version: string; via: 'in-process' | 'project' | 'running' }
  // Only a re-run asks for the latest agent-qa.
  latest?: InitDocumentLatest
  plugins: { package: string; version: string }[]
  model?: InitDocumentModel
  // Only a re-run has a setup menu.
  setup?: InitDocumentSetupRow[]
  nextSteps: { command: string; description: string }[]
}

export type InitMessageMask = (text: string) => Promise<string | undefined>

const WITHHELD_MESSAGE =
  'The error message is withheld because the declared secrets could not be read to mask it.'

export interface InitDocumentRecorder {
  // The folder's real path, for files named through it, such as a package.json the range found.
  realDir(path: string): void
  file(
    step: InitStepName,
    result: { path: string; outcome: InitFileOutcome | AgentSetupFileOutcome },
  ): void
  agents(agents: readonly CodingAgent[]): void
  packageManager(name: string): void
  agentQa(agentQa: NonNullable<InitDocument['agentQa']>): void
  latest(latest: InitDocumentLatest): void
  plugins(plugins: readonly { package: string; version: string }[]): void
  model(model: InitDocumentModel): void
  setup(rows: readonly InitDocumentSetupRow[]): void
  nextSteps(steps: readonly { command: string; description: string }[]): void
  fail(error: unknown): void
  document(steps: readonly InitStepRecord[], mask: InitMessageMask): Promise<InitDocument>
}

function firstLine(text: string): string {
  return stripColour(text).split('\n')[0] ?? ''
}

function stripColour(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/gu, '')
}

function fileOutcome(outcome: InitFileOutcome | AgentSetupFileOutcome): InitDocumentFileOutcome {
  return outcome === 'preserved' || outcome === 'unchanged' ? 'kept' : outcome
}

type Ending = Pick<InitDocument, 'outcome' | 'exitCode' | 'message'>

async function endingOf(
  error: unknown,
  steps: readonly InitStepRecord[],
  mask: InitMessageMask,
): Promise<Ending> {
  if (error === undefined) {
    const failed = steps.some((step) => step.outcome === 'failed')
    return failed ? { outcome: 'failed', exitCode: 3 } : { outcome: 'done', exitCode: 0 }
  }
  if (isPromptCancel(error)) {
    return { outcome: 'interrupted', exitCode: 130, message: CANCELLED_LINE }
  }
  if (error instanceof CliRefusal) {
    if (error.exitCode === 130) {
      return { outcome: 'interrupted', exitCode: 130, message: CANCELLED_LINE }
    }
    if (error.exitCode === 2) {
      return { outcome: 'refused', exitCode: 2, message: firstLine(error.message) }
    }
    if (error.exitCode === 3) return { outcome: 'failed', exitCode: 3 }
  }
  const exitCode = error instanceof CliRefusal && error.exitCode !== 0 ? error.exitCode : 1
  const text = error instanceof Error ? error.message : String(error)
  const message = (await mask(stripColour(text))) ?? WITHHELD_MESSAGE
  return message === '' ? { outcome: 'failed', exitCode } : { outcome: 'failed', exitCode, message }
}

function isOutside(fromDir: string): boolean {
  return fromDir === '..' || fromDir.startsWith(`..${sep}`)
}

// Paths are relative to the folder init runs in and `/`-separated on every platform.
export function createInitDocumentRecorder({ dir }: { dir: string }): InitDocumentRecorder {
  let real = dir
  const files: InitDocumentFile[] = []
  let agents: CodingAgent[] = []
  let packageManager: string | undefined
  let agentQa: InitDocument['agentQa']
  let latest: InitDocumentLatest | undefined
  let plugins: InitDocument['plugins'] = []
  let model: InitDocumentModel | undefined
  let setup: InitDocumentSetupRow[] | undefined
  let nextSteps: InitDocument['nextSteps'] = []
  let failure: unknown

  return {
    realDir(path) {
      real = path
    },
    file(step, result) {
      const fromDir = relative(dir, result.path)
      const shown = isOutside(fromDir) && real !== dir ? relative(real, result.path) : fromDir
      const path = shown.split(sep).join('/')
      files.push({ path, outcome: fileOutcome(result.outcome), step })
    },
    agents(list) {
      agents = [...list]
    },
    packageManager(name) {
      packageManager = name
    },
    agentQa(value) {
      agentQa = { version: value.version, via: value.via }
    },
    latest(value) {
      latest = {
        source: value.source,
        ...(value.version === undefined ? {} : { version: value.version }),
      }
    },
    plugins(list) {
      plugins = list.map((plugin) => ({ package: plugin.package, version: plugin.version }))
    },
    model(value) {
      model = { ...value }
    },
    setup(rows) {
      setup = rows.map((row) => ({ ...row }))
    },
    nextSteps(list) {
      nextSteps = list.map((step) => ({ command: step.command, description: step.description }))
    },
    fail(error) {
      failure = error
    },
    async document(steps, mask) {
      const ending = await endingOf(failure, steps, mask)
      return {
        format: 1,
        outcome: ending.outcome,
        exitCode: ending.exitCode,
        ...(ending.message === undefined ? {} : { message: ending.message }),
        steps: steps.map((step) => ({ ...step })),
        files: [...files],
        agents: [...agents],
        ...(packageManager === undefined ? {} : { packageManager }),
        ...(agentQa === undefined ? {} : { agentQa }),
        ...(latest === undefined ? {} : { latest }),
        plugins: [...plugins],
        ...(model === undefined ? {} : { model }),
        ...(setup === undefined ? {} : { setup: setup.map((row) => ({ ...row })) }),
        nextSteps: [...nextSteps],
      }
    },
  }
}

export function refusedInitDocument(message: string): InitDocument {
  return {
    format: 1,
    outcome: 'refused',
    exitCode: 2,
    message: firstLine(message),
    steps: [],
    files: [],
    agents: [],
    plugins: [],
    nextSteps: [],
  }
}

export function writeInitDocument(
  doc: InitDocument,
  write: (text: string) => void = (text) => {
    process.stdout.write(text)
  },
): void {
  write(`${guardJsonText(JSON.stringify(doc, null, 2))}\n`)
}
