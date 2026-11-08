import { CliRefusal, PromptCancelled, isPromptCancel } from '../composition/cli-refusal.js'
import type { InitStepLine, InitUi } from '../init-ui/init-ui.js'
import { isInitRefusal } from './init-refusal.js'

export type InitStepName =
  | 'package-json'
  | 'scaffold'
  | 'install'
  | 'chromium'
  | 'skills'
  | 'validate'
  | 'sign-in'
  | 'dashboard'

export interface InitStepRecord {
  name: InitStepName
  outcome: 'done' | 'skipped' | 'failed'
  reason?: string
  command?: string
}

export type InitStepResult =
  | { outcome: 'done'; text: string }
  | { outcome: 'skipped'; text: string; reason: string; command?: string }
  | { outcome: 'failed'; reason: string; command?: string }

export interface InitSignals {
  on(event: 'SIGINT', listener: () => void): unknown
  off(event: 'SIGINT', listener: () => void): unknown
}

export interface InitStepRunner {
  run(
    name: InitStepName,
    step: { title: string; command?: string },
    fn: (line: InitStepLine) => Promise<InitStepResult>,
  ): Promise<InitStepRecord>
  skip(name: InitStepName, text: string, reason: string, command?: string): InitStepRecord
  records(): InitStepRecord[]
  failed(): boolean
  interrupted(): boolean
  dispose(): void
}

export const INTERRUPTED = 'interrupted'

export const ALREADY_INITIALIZED = 'already initialized'

// The steps a fresh init plans, in the order it runs them.
export function freshInitPlan(): InitStepName[] {
  return ['package-json', 'scaffold', 'install', 'chromium']
}

// A bug is reported with its stack, not drawn as a failed step.
function isBug(error: unknown): boolean {
  let cause = error
  for (let depth = 0; cause instanceof Error && depth < 10; depth += 1) {
    if (
      cause instanceof TypeError ||
      cause instanceof ReferenceError ||
      cause instanceof SyntaxError
    ) {
      return true
    }
    cause = cause.cause
  }
  return false
}

function passesThrough(error: unknown): boolean {
  return error instanceof CliRefusal || isInitRefusal(error) || isBug(error)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withCommand(record: InitStepRecord, command: string | undefined): InitStepRecord {
  return command === undefined ? record : { ...record, command }
}

export function createInitStepRunner({
  ui,
  plan,
  signals = process,
}: {
  ui: InitUi
  plan: readonly InitStepName[]
  signals?: InitSignals
}): InitStepRunner {
  const recorded = new Map<InitStepName, InitStepRecord>()
  let interrupted = false
  let listening = true
  const onInterrupt = (): void => {
    interrupted = true
  }
  signals.on('SIGINT', onInterrupt)

  const dispose = (): void => {
    if (!listening) return
    listening = false
    signals.off('SIGINT', onInterrupt)
  }

  const record = (entry: InitStepRecord): InitStepRecord => {
    recorded.set(entry.name, entry)
    return entry
  }

  const skipTheRest = (): void => {
    for (const name of plan) {
      if (!recorded.has(name)) record({ name, outcome: 'skipped', reason: INTERRUPTED })
    }
  }

  const cancel = (): never => {
    skipTheRest()
    dispose()
    throw new PromptCancelled()
  }

  return {
    async run(name, step, fn) {
      if (!plan.includes(name)) throw new Error(`init step ${name} is not in this run's plan`)
      if (interrupted) cancel()
      const line = ui.step(step.title)
      let result: InitStepResult
      try {
        result = await fn(line)
      } catch (error) {
        if (interrupted || isPromptCancel(error)) {
          interrupted = true
          record({ name, outcome: 'failed', reason: INTERRUPTED })
          line.failed(`${step.title}: ${INTERRUPTED}`)
          return cancel()
        }
        const reason = messageOf(error)
        if (passesThrough(error)) {
          record({ name, outcome: 'failed', reason })
          throw error
        }
        line.failed(reason, step.command)
        return record(withCommand({ name, outcome: 'failed', reason }, step.command))
      }
      if (interrupted) {
        record({ name, outcome: 'failed', reason: INTERRUPTED })
        line.failed(`${step.title}: ${INTERRUPTED}`)
        return cancel()
      }
      if (result.outcome === 'done') {
        line.done(result.text)
        return record({ name, outcome: 'done' })
      }
      if (result.outcome === 'skipped') {
        line.skipped(result.text)
        const skipped: InitStepRecord = { name, outcome: 'skipped', reason: result.reason }
        return record(withCommand(skipped, result.command))
      }
      line.failed(result.reason, result.command)
      return record(withCommand({ name, outcome: 'failed', reason: result.reason }, result.command))
    },
    skip(name, text, reason, command) {
      if (!plan.includes(name)) throw new Error(`init step ${name} is not in this run's plan`)
      ui.step(text).skipped(text)
      return record(withCommand({ name, outcome: 'skipped', reason }, command))
    },
    records: () => plan.flatMap((name) => recorded.get(name) ?? []),
    failed: () => [...recorded.values()].some((entry) => entry.outcome === 'failed'),
    interrupted: () => interrupted,
    dispose,
  }
}
