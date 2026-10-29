// Readers narrow by presence, typeof and closed-set membership, and return undefined otherwise.

import type {
  ClipboardEvidence,
  DownloadEvidence,
  FillVerdict,
  InputPath,
  SubmitOutcome,
  SubmitReason,
} from '@vostride/agent-qa-schema'
import type { ActionResult } from '../platform.js'

/** The values a readable fill compared: requested and read back (sentinels for a secure field). */
export interface FillRereadMeta {
  expected: string
  actual: string
}

/** What ended a scroll: the target appeared, the swipe budget ran out, or a boundary signal. */
export type ScrollEndedBy = 'target-visible' | 'max-swipes' | 'boundary'

/** Outcomes new runs write. */
export const SCROLL_OUTCOMES_WRITTEN = ['found', 'not-found', 'unresolved'] as const
// Outcomes older runs wrote; still read so persisted metadata stays parseable.
export const SCROLL_OUTCOMES_READ_ONLY = ['no-change', 'cap'] as const

const SCROLL_ENDED_BY: readonly ScrollEndedBy[] = ['target-visible', 'max-swipes', 'boundary']

// The scroll outcome block; `endedBy` is absent on older metadata.
export interface ScrollUntilVisibleMeta {
  swipes: number
  reversedOnce: boolean
  outcome:
    | (typeof SCROLL_OUTCOMES_WRITTEN)[number]
    | (typeof SCROLL_OUTCOMES_READ_ONLY)[number]
  endedBy?: ScrollEndedBy
}

export interface OpenAppMeta {
  resolvedId: string
  matchKind: 'exact' | 'fuzzy' | 'explicit'
}

// Defined once, in schema, so the dashboard reads it too.
export type { IdempotentNoopMeta } from '@vostride/agent-qa-schema'
export { readIdempotentNoopMeta } from '@vostride/agent-qa-schema'

export function readFillRereadMeta(actionResult?: ActionResult): FillRereadMeta | undefined {
  const raw = actionResult?.metadata?.['fillReread']
  if (raw && typeof raw === 'object' && 'expected' in raw && 'actual' in raw) {
    const { expected, actual } = raw as Record<string, unknown>
    if (typeof expected === 'string' && typeof actual === 'string') return { expected, actual }
  }
  return undefined
}

export function readScrollUntilVisibleMeta(
  actionResult?: MetadataCarrier,
): ScrollUntilVisibleMeta | undefined {
  const raw = actionResult?.metadata?.['scrollUntilVisible']
  if (raw && typeof raw === 'object' && 'swipes' in raw && 'reversedOnce' in raw && 'outcome' in raw) {
    const { swipes, reversedOnce, outcome, endedBy } = raw as Record<string, unknown>
    const outcomes: readonly unknown[] = [...SCROLL_OUTCOMES_WRITTEN, ...SCROLL_OUTCOMES_READ_ONLY]
    if (
      typeof swipes === 'number' &&
      typeof reversedOnce === 'boolean' &&
      outcomes.includes(outcome)
    ) {
      const meta: ScrollUntilVisibleMeta = {
        swipes,
        reversedOnce,
        outcome: outcome as ScrollUntilVisibleMeta['outcome'],
      }
      if (endedBy === undefined) return meta
      if ((SCROLL_ENDED_BY as readonly unknown[]).includes(endedBy)) {
        return { ...meta, endedBy: endedBy as ScrollEndedBy }
      }
    }
  }
  return undefined
}

export function readOpenAppMeta(actionResult?: ActionResult): OpenAppMeta | undefined {
  const raw = actionResult?.metadata?.['openApp']
  if (raw && typeof raw === 'object' && 'resolvedId' in raw && 'matchKind' in raw) {
    const { resolvedId, matchKind } = raw as Record<string, unknown>
    if (
      typeof resolvedId === 'string' &&
      (matchKind === 'exact' || matchKind === 'fuzzy' || matchKind === 'explicit')
    ) {
      return { resolvedId, matchKind }
    }
  }
  return undefined
}

// Each mint rides `ActionResult.metadata` under its own verb-named key; readers narrow by shape.

// The reportValue answer block, keyed `reportedValue`.
export interface ReportedValueMeta {
  value: string
}

// The uniqueValue mint block, keyed `uniqueValue`.
export interface UniqueValueMeta {
  value: string
  prefix: string
}

/** The AI-judgment block, keyed `aiJudgment`. `unresolved` marks one the model could not make. */
export interface AiJudgmentMeta {
  verb: 'assertAI' | 'extractAI'
  verdict?: boolean
  unresolved?: true
}

// The assertValue outcome block, keyed `assertValueOutcome`.
export interface AssertValueOutcomeMeta {
  source: string
  op: string
  passed: boolean
  expected?: string
  actual?: string | null
}

// Broader than `ActionResult`, so loosely typed sub-action results narrow cleanly.
type MetadataCarrier = { metadata?: Record<string, unknown> }

export function readReportedValueMeta(actionResult?: MetadataCarrier): ReportedValueMeta | undefined {
  const raw = actionResult?.metadata?.['reportedValue']
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const { value } = raw as Record<string, unknown>
    if (typeof value === 'string') return { value }
  }
  return undefined
}

export function readUniqueValueMeta(actionResult?: MetadataCarrier): UniqueValueMeta | undefined {
  const raw = actionResult?.metadata?.['uniqueValue']
  if (raw && typeof raw === 'object' && 'value' in raw && 'prefix' in raw) {
    const { value, prefix } = raw as Record<string, unknown>
    if (typeof value === 'string' && typeof prefix === 'string') return { value, prefix }
  }
  return undefined
}

export function readAiJudgmentMeta(actionResult?: MetadataCarrier): AiJudgmentMeta | undefined {
  const raw = actionResult?.metadata?.['aiJudgment']
  if (raw && typeof raw === 'object' && 'verb' in raw) {
    const { verb, verdict, unresolved } = raw as Record<string, unknown>
    if (verb === 'assertAI' || verb === 'extractAI') {
      if (unresolved === true) return { verb, unresolved: true }
      return typeof verdict === 'boolean' ? { verb, verdict } : { verb }
    }
  }
  return undefined
}

export function readAssertValueOutcomeMeta(
  actionResult?: MetadataCarrier,
): AssertValueOutcomeMeta | undefined {
  const raw = actionResult?.metadata?.['assertValueOutcome']
  if (raw && typeof raw === 'object' && 'source' in raw && 'op' in raw && 'passed' in raw) {
    const { source, op, passed, expected, actual } = raw as Record<string, unknown>
    if (typeof source === 'string' && typeof op === 'string' && typeof passed === 'boolean') {
      const meta: AssertValueOutcomeMeta = { source, op, passed }
      if (typeof expected === 'string') meta.expected = expected
      if (typeof actual === 'string' || actual === null) meta.actual = actual
      return meta
    }
  }
  return undefined
}

// Text-input blocks never carry typed text or a field value.

/** Typed refusal of a fill/clearText before any text was typed. Keyed `fillRefusal`. */
export interface FillRefusalMeta {
  verb: 'fill' | 'clearText'
  cause: 'not-editable' | 'target-not-found' | 'single-line-field'
  evidence:
    | 'no-editable-signal'
    | 'no-keyboard-focus'
    | 'focus-elsewhere'
    | 'stale-target'
    | 'text-has-line-breaks'
}

// Keyed `fillSubmit`; older blocks with `sent` alone still read.
export interface FillSubmitMeta {
  sent: boolean
  outcome?: SubmitOutcome
  reason?: SubmitReason
  detail?: string
}

/** A shell-routed action refused or failed by the driver. Keyed `shellAction`. */
export interface ShellActionMeta {
  verb: 'keyevent' | 'openQuickSettings'
  outcome: 'unavailable' | 'failed'
  reason?: 'adb-shell-disabled'
  detail?: string
}

const FILL_REFUSAL_VERBS = new Set<FillRefusalMeta['verb']>(['fill', 'clearText'])
const FILL_REFUSAL_CAUSES = new Set<FillRefusalMeta['cause']>([
  'not-editable',
  'target-not-found',
  'single-line-field',
])
const FILL_REFUSAL_EVIDENCE = new Set<FillRefusalMeta['evidence']>([
  'no-editable-signal',
  'no-keyboard-focus',
  'focus-elsewhere',
  'stale-target',
  'text-has-line-breaks',
])
const SUBMIT_OUTCOMES = new Set<SubmitOutcome>(['sent', 'not-sent', 'unavailable', 'failed'])
const SUBMIT_REASONS = new Set<SubmitReason>(['mismatch', 'multi-line-field', 'input-failed', 'focus-lost'])
const SHELL_VERBS = new Set<ShellActionMeta['verb']>(['keyevent', 'openQuickSettings'])
const SHELL_OUTCOMES = new Set<ShellActionMeta['outcome']>(['unavailable', 'failed'])

function isMember<T extends string>(set: ReadonlySet<T>, value: unknown): value is T {
  return typeof value === 'string' && set.has(value as T)
}

export function readFillRefusalMeta(actionResult?: MetadataCarrier): FillRefusalMeta | undefined {
  const raw = actionResult?.metadata?.['fillRefusal']
  if (raw && typeof raw === 'object' && 'verb' in raw && 'cause' in raw && 'evidence' in raw) {
    const { verb, cause, evidence } = raw as Record<string, unknown>
    if (
      isMember(FILL_REFUSAL_VERBS, verb) &&
      isMember(FILL_REFUSAL_CAUSES, cause) &&
      isMember(FILL_REFUSAL_EVIDENCE, evidence)
    ) {
      return { verb, cause, evidence }
    }
  }
  return undefined
}

/** How a fill or clear's read-back compared with the requested text. Keyed `fillVerdict`. */
export interface FillVerdictMeta {
  verb: 'fill' | 'clearText'
  verdict: FillVerdict
  path?: InputPath
  secure?: true
}

const FILL_VERDICT_VERBS = new Set<FillVerdictMeta['verb']>(['fill', 'clearText'])
const FILL_VERDICTS = new Set<FillVerdict>(['exact', 'normalized', 'mismatch', 'unverified'])
const INPUT_PATHS = new Set<InputPath>(['native', 'webview', 'keyboard'])

export function readFillVerdictMeta(actionResult?: MetadataCarrier): FillVerdictMeta | undefined {
  const raw = actionResult?.metadata?.['fillVerdict']
  if (!raw || typeof raw !== 'object') return undefined
  const { verb, verdict, path, secure } = raw as Record<string, unknown>
  if (!isMember(FILL_VERDICT_VERBS, verb) || !isMember(FILL_VERDICTS, verdict)) return undefined
  if (path !== undefined && !isMember(INPUT_PATHS, path)) return undefined
  if (secure !== undefined && secure !== true) return undefined
  const meta: FillVerdictMeta = { verb, verdict }
  if (path !== undefined) meta.path = path
  if (secure === true) meta.secure = true
  return meta
}

export function readFillSubmitMeta(actionResult?: MetadataCarrier): FillSubmitMeta | undefined {
  const raw = actionResult?.metadata?.['fillSubmit']
  if (!raw || typeof raw !== 'object') return undefined
  const { sent, outcome, reason, detail } = raw as Record<string, unknown>
  if (typeof sent !== 'boolean') return undefined
  if (outcome !== undefined && (!isMember(SUBMIT_OUTCOMES, outcome) || sent !== (outcome === 'sent'))) {
    return undefined
  }
  if (reason !== undefined) {
    if (!isMember(SUBMIT_REASONS, reason) || sent) return undefined
    if (outcome !== undefined && outcome !== 'not-sent') return undefined
  }
  if (detail !== undefined && typeof detail !== 'string') return undefined
  const meta: FillSubmitMeta = { sent }
  if (outcome !== undefined) meta.outcome = outcome
  if (reason !== undefined) meta.reason = reason
  if (detail !== undefined) meta.detail = detail
  return meta
}

export function readShellActionMeta(actionResult?: MetadataCarrier): ShellActionMeta | undefined {
  const raw = actionResult?.metadata?.['shellAction']
  if (!raw || typeof raw !== 'object') return undefined
  const { verb, outcome, reason, detail } = raw as Record<string, unknown>
  if (!isMember(SHELL_VERBS, verb) || !isMember(SHELL_OUTCOMES, outcome)) return undefined
  if (reason !== undefined && (reason !== 'adb-shell-disabled' || outcome !== 'unavailable')) return undefined
  if (detail !== undefined && typeof detail !== 'string') return undefined
  const meta: ShellActionMeta = { verb, outcome }
  if (reason !== undefined) meta.reason = reason
  if (detail !== undefined) meta.detail = detail
  return meta
}

// Download capture, one entry per download in start order; entries that do not narrow are dropped.

const DOWNLOAD_STATES = new Set<DownloadEvidence['state']>(['completed', 'failed', 'canceled', 'unfinished'])

function readDownloadEntry(raw: unknown): DownloadEvidence | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { suggestedFilename, extension, size, sha256, state, failure, late } = raw as Record<string, unknown>
  if (typeof suggestedFilename !== 'string' || typeof extension !== 'string') return undefined
  if (!isMember(DOWNLOAD_STATES, state)) return undefined
  const entry: DownloadEvidence = { suggestedFilename, extension, state }
  if (state === 'completed') {
    if (typeof size !== 'number' || typeof sha256 !== 'string') return undefined
    entry.size = size
    entry.sha256 = sha256
  }
  if (typeof failure === 'string') entry.failure = failure
  if (late === true) entry.late = true
  return entry
}

export function readDownloadMeta(actionResult?: MetadataCarrier): DownloadEvidence[] | undefined {
  const raw = actionResult?.metadata?.['download']
  if (!Array.isArray(raw)) return undefined
  const entries = raw.map(readDownloadEntry).filter((entry): entry is DownloadEvidence => entry !== undefined)
  return entries.length > 0 ? entries : undefined
}

// The adapter has no masker, so the text is raw here; the loop masks and bounds it first.

/** The most masked clipboard text one write keeps; longer text is cut and marked. */
export const CLIPBOARD_TEXT_LIMIT = 2000
export const CLIPBOARD_TRUNCATION_MARKER = '…[truncated]'

export type ClipboardWriteMeta = Pick<ClipboardEvidence, 'source' | 'text' | 'readBack'>

const CLIPBOARD_SOURCES = new Set<ClipboardEvidence['source']>(['writeText', 'write', 'copy-event'])
const CLIPBOARD_READ_BACKS = new Set<ClipboardEvidence['readBack']>(['matched', 'mismatched', 'unavailable'])

function readClipboardEntry(raw: unknown): ClipboardWriteMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { source, text, readBack } = raw as Record<string, unknown>
  if (typeof text !== 'string') return undefined
  if (!isMember(CLIPBOARD_SOURCES, source) || !isMember(CLIPBOARD_READ_BACKS, readBack)) return undefined
  return { source, text, readBack }
}

export function readClipboardMeta(actionResult?: MetadataCarrier): ClipboardWriteMeta[] | undefined {
  const raw = actionResult?.metadata?.['clipboard']
  if (!Array.isArray(raw)) return undefined
  const entries = raw.map(readClipboardEntry).filter((entry): entry is ClipboardWriteMeta => entry !== undefined)
  return entries.length > 0 ? entries : undefined
}
