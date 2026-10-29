// the whole step's record the verifier judges from. Every action with its outcome and
// operation evidence, every value read, the settled start screen and the items carried from earlier
// steps. The planner's reasoning is never part of it. Callers mask and redact what they add.
import type { InputEvidence, OperationEvidence, ScreenState } from '@vostride/agent-qa-schema'
import type { Action } from '../platform.js'
import { renderInputEvidence, renderOperationEvidence, verifierActionDescription } from './prompts.js'

export type RecordedActionOutcome = 'success' | 'failure' | 'no-input' | 'refused'

export interface RecordedAction {
  /** 1-based position of the action in the step. */
  index: number
  action: Action
  /** The element the action's ref named on the screen it acted on. */
  element?: { role: string; name: string }
  outcome: RecordedActionOutcome
  error?: string
  operationEvidence?: OperationEvidence
}

export type RecordedReadKind = 'assertValue' | 'assertAI' | 'extractAI' | 'reportValue'

export interface RecordedRead {
  /** The 1-based index of the action that read the value. */
  index: number
  kind: RecordedReadKind
  text: string
  assert?: { source: string; op: string; expected?: string; passed: boolean }
  claim?: string
  /** An assertAI read's verdict on its claim. */
  judged?: boolean
  mode?: string
}

export interface CarriedLine {
  stepNumber: number
  actionIndex: number
  text: string
}

export interface VerifierStepRecord {
  startScreen: ScreenState
  actions: RecordedAction[]
  reads: RecordedRead[]
  carried: CarriedLine[]
}

export interface RenderedStepRecord {
  actions: string
  operationEvidence: string
  reads: string
  carried: string
}

export const RECORD_ACTION_LINE_CAP = 40
export const RECORD_LINE_CHAR_CAP = 300
export const RECORD_LIST_CAP = 50
const RECORD_HEAD_ACTIONS = 5

export class StepRecordAccumulator {
  private startScreen: ScreenState | undefined
  private readonly actions: RecordedAction[] = []
  private readonly reads: RecordedRead[] = []
  private readonly carried: CarriedLine[] = []

  /** Keeps the first settled observation of the step; later calls are ignored. */
  start(screen: ScreenState): void {
    if (this.startScreen === undefined) this.startScreen = screen
  }

  addAction(entry: Omit<RecordedAction, 'index'>): number {
    const index = this.actions.length + 1
    this.actions.push({ index, ...entry })
    return index
  }

  /** A read belongs to the action about to be recorded. */
  addRead(entry: Omit<RecordedRead, 'index'>): void {
    this.reads.push({ index: this.actions.length + 1, ...entry })
  }

  addCarried(line: CarriedLine): void {
    this.carried.push(line)
  }

  /** The actions recorded so far; unlike `snapshot` it needs no start screen. */
  recordedActions(): RecordedAction[] {
    return [...this.actions]
  }

  snapshot(): VerifierStepRecord {
    if (this.startScreen === undefined) throw new Error('The step record has no start screen')
    return {
      startScreen: this.startScreen,
      actions: [...this.actions],
      reads: [...this.reads],
      carried: [...this.carried],
    }
  }
}

function capLine(line: string): string {
  return line.length > RECORD_LINE_CHAR_CAP ? `${line.slice(0, RECORD_LINE_CHAR_CAP - 1)}…` : line
}

function capList(lines: string[], noun: string): string[] {
  if (lines.length <= RECORD_LIST_CAP) return lines
  const omitted = lines.length - RECORD_LIST_CAP
  return [...lines.slice(0, RECORD_LIST_CAP), `… ${omitted} more ${noun} omitted …`]
}

interface RecordView {
  describe: (action: Action) => string
  /** Whether an action's error text is shown (an error echoes the planner's arguments). */
  showsError: (action: Action) => boolean
  read: (read: RecordedRead) => string
}

const PROMPT_VIEW: RecordView = {
  describe: verifierActionDescription,
  showsError: () => true,
  read: readLine,
}

// what the planner wrote (a claim, a query, a typed or expected value) is never citable.
// An error is the runner's or adapter's report on the planner's request and echoes its arguments.
const CITATION_VIEW: RecordView = {
  describe: (action) => `${action.type}${fieldOf(action)}`,
  showsError: () => false,
  read: citationReadLine,
}

function actionLine(entry: RecordedAction, view: RecordView): string {
  const shown = entry.error !== undefined && entry.error.length > 0 && view.showsError(entry.action)
  const error = shown ? `: ${entry.error}` : ''
  const element = entry.element ? ` (${entry.element.role} "${entry.element.name}")` : ''
  const description = `${view.describe(entry.action)}${element}`
  return capLine(`${entry.index}. ${description} → ${entry.outcome}${error}`)
}

function fieldOf(action: Action): string {
  return 'ref' in action && typeof action.ref === 'string' && action.ref.length > 0
    ? ` on ref="${action.ref}"`
    : ''
}

// D-03 sees every fill verdict: an entry the notable renderer skips still gets a plain line.
function inputLines(entry: InputEvidence, action: Action): string[] {
  const notable = renderInputEvidence(entry)
  if (notable !== undefined) return notable.split('\n')
  const parts = [`input ${entry.inputSent ? 'sent' : 'not sent'}`]
  if (entry.fillVerdict !== undefined) parts.push(`fill verdict ${entry.fillVerdict}`)
  if (entry.submit !== undefined) parts.push(`Enter ${entry.submit}`)
  return [`${entry.verb}${fieldOf(action)}: ${parts.join(', ')}`]
}

function evidenceLines(entry: RecordedAction): string[] {
  const evidence = entry.operationEvidence
  if (evidence === undefined) return []
  const lines: string[] = []
  for (const download of evidence.downloads ?? []) {
    lines.push(renderOperationEvidence({ downloads: [download] }))
  }
  for (const write of evidence.clipboard ?? []) {
    lines.push(renderOperationEvidence({ clipboard: [write] }))
  }
  for (const input of evidence.input ?? []) lines.push(...inputLines(input, entry.action))
  return lines.map((line) => capLine(`action ${entry.index}: ${line}`))
}

function actionLines(actions: RecordedAction[], view: RecordView): string[] {
  const line = (entry: RecordedAction) => actionLine(entry, view)
  if (actions.length <= RECORD_ACTION_LINE_CAP) return actions.map(line)
  const tail = RECORD_ACTION_LINE_CAP - RECORD_HEAD_ACTIONS
  const omitted = actions.length - RECORD_ACTION_LINE_CAP
  return [
    ...actions.slice(0, RECORD_HEAD_ACTIONS).map(line),
    `… ${omitted} actions omitted …`,
    ...actions.slice(actions.length - tail).map(line),
  ]
}

/** One read as the verifier turn and the 'read' citation source show it. */
export function readLine(read: RecordedRead): string {
  return capLine(`read ${read.index}: ${read.kind} ${read.text}`)
}

// Only an expected value the read itself shows (a passed equals or contains) is observed text.
const OBSERVED_EXPECTED_OPS: ReadonlySet<string> = new Set(['equals', 'contains'])

/** One read as the 'read' citation source holds it: the planner's expectation or claim removed. */
function citationReadLine(read: RecordedRead): string {
  if (read.kind === 'assertValue' && read.assert?.expected !== undefined) {
    const { source, op, expected, passed } = read.assert
    if (!(passed && OBSERVED_EXPECTED_OPS.has(op))) {
      const asked = `${source} ${op} "${expected}"`
      const text = read.text.startsWith(asked)
        ? `${source} ${op}${read.text.slice(asked.length)}`
        : `${source} ${op}: ${passed ? 'passed' : 'failed'}`
      return readLine({ ...read, text })
    }
  }
  // The judge's rationale is model prose that often restates the claim, not observed text.
  if (read.kind === 'assertAI' && read.judged === false) {
    return readLine({ ...read, text: 'judged false' })
  }
  return readLine(read)
}

/** The record as the verifier turn shows it, one string per part. */
export function renderStepRecord(record: VerifierStepRecord): RenderedStepRecord {
  return renderRecord(record, PROMPT_VIEW)
}

/** The record as the citation sources hold it: only what the app or the runner observed. */
export function renderCitationRecord(record: VerifierStepRecord): RenderedStepRecord {
  return renderRecord(record, CITATION_VIEW)
}

function renderRecord(record: VerifierStepRecord, view: RecordView): RenderedStepRecord {
  const evidence = record.actions.flatMap(evidenceLines)
  const reads = record.reads.map(view.read)
  const carried = record.carried.map((line) =>
    capLine(`carried from step ${line.stepNumber}, action ${line.actionIndex}: ${line.text}`),
  )
  return {
    actions: actionLines(record.actions, view).join('\n'),
    operationEvidence: capList(evidence, 'operation evidence lines').join('\n'),
    reads: capList(reads, 'reads').join('\n'),
    carried: capList(carried, 'carried items').join('\n'),
  }
}
