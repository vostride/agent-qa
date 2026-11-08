import { relative, sep } from 'node:path'

import { guardJsonText } from '@vostride/agent-qa-core/run-text-output'

import { CANCELLED_LINE, CliRefusal, isPromptCancel } from '../composition/cli-refusal.js'
import type { CodingAgent } from './agent-setup-manifest.js'
import type { InitFileOutcome } from './init-filesystem.js'
import type { InitStepName, InitStepRecord } from './init-steps.js'

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
  plugins: { package: string; version: string }[]
  model?: InitDocumentModel
  nextSteps: { command: string; description: string }[]
}

export type InitMessageMask = (text: string) => Promise<string | undefined>

const WITHHELD_MESSAGE =
  'The error message is withheld because the declared secrets could not be read to mask it.'

export interface InitDocumentRecorder {
  // The folder's real path, for files named through it, such as a package.json the range found.
  realDir(path: string): void
  file(step: InitStepName, result: { path: string; outcome: InitFileOutcome }): void
  agents(agents: readonly CodingAgent[]): void
  packageManager(name: string): void
  agentQa(agentQa: NonNullable<InitDocument['agentQa']>): void
  plugins(plugins: readonly { package: string; version: string }[]): void
  model(model: InitDocumentModel): void
  nextSteps(steps: readonly { command: string; description: string }[]): void
  // A refusal init prints itself and ends with exit code 2 rather than throwing.
  refused(message: string): void
  fail(error: unknown): void
  document(steps: readonly InitStepRecord[], mask: InitMessageMask): Promise<InitDocument>
}

function firstLine(text: string): string {
  return stripColour(text).split('\n')[0] ?? ''
}

function stripColour(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/gu, '')
}

function fileOutcome(outcome: InitFileOutcome): InitDocumentFileOutcome {
  return outcome === 'preserved' ? 'kept' : outcome
}

type Ending = Pick<InitDocument, 'outcome' | 'exitCode' | 'message'>

async function endingOf(
  error: unknown,
  refusal: string | undefined,
  steps: readonly InitStepRecord[],
  mask: InitMessageMask,
): Promise<Ending> {
  if (error === undefined) {
    if (refusal !== undefined) return { outcome: 'refused', exitCode: 2, message: refusal }
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
  let plugins: InitDocument['plugins'] = []
  let model: InitDocumentModel | undefined
  let nextSteps: InitDocument['nextSteps'] = []
  let refusal: string | undefined
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
    plugins(list) {
      plugins = list.map((plugin) => ({ package: plugin.package, version: plugin.version }))
    },
    model(value) {
      model = { ...value }
    },
    nextSteps(list) {
      nextSteps = list.map((step) => ({ command: step.command, description: step.description }))
    },
    refused(message) {
      refusal = firstLine(message)
    },
    fail(error) {
      failure = error
    },
    async document(steps, mask) {
      const ending = await endingOf(failure, refusal, steps, mask)
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
        plugins: [...plugins],
        ...(model === undefined ? {} : { model }),
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
