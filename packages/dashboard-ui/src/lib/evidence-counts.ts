import type { AriaEvidenceEntry, EvidenceKind, StepEvidenceEntries } from '@vostride/agent-qa-schema'
import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'
import { EVIDENCE_COPY, resolveEvidenceView } from './evidence-state-view'

export type StepSignal = 'console' | 'network' | 'a11y'
export const STEP_SIGNALS = ['console', 'network', 'a11y'] as const satisfies readonly StepSignal[]

export type TabCount =
  | { kind: 'problem'; count: number; severity: 'high' | 'moderate' }
  | { kind: 'total'; count: number }
  | { kind: 'absent'; title: string; count?: never }

export const PROBLEM_COUNT_TONES = { high: 'text-red-500', moderate: 'text-amber-500' } as const

const TAB_NAMES = textTable({
  variables: () => t('evidence.tab.variables'),
  network: () => t('evidence.tab.network'),
  console: () => t('evidence.tab.console'),
  aria: () => t('evidence.tab.aria'),
  a11y: () => t('evidence.tab.a11y'),
}) satisfies Record<EvidenceKind, string>

export function stepSignals(entries: StepEvidenceEntries | undefined): Record<StepSignal, number | undefined> {
  const consoleEntry = entries?.console
  const network = entries?.network
  const a11y = entries?.a11y
  const positive = (count: number) => count > 0 ? count : undefined
  return {
    console: consoleEntry?.state === 'present' && !consoleEntry.ref.evidenceIncomplete
      ? positive(consoleEntry.counts.errors) : undefined,
    network: network?.state === 'present' && !network.ref.evidenceIncomplete
      ? positive(network.counts.failed + network.counts.errored) : undefined,
    a11y: a11y?.state === 'present' && !a11y.ref.evidenceIncomplete
      ? positive(a11y.counts.minor + a11y.counts.moderate + a11y.counts.serious + a11y.counts.critical)
      : undefined,
  }
}

/** The same recorded problem count and severity drive tabs and timeline signals. */
export function stepProblemCounts(entries: StepEvidenceEntries | undefined): Record<StepSignal, Extract<TabCount, { kind: 'problem' }> | undefined> {
  const counts = stepSignals(entries)
  const problem = (kind: StepSignal): Extract<TabCount, { kind: 'problem' }> | undefined => {
    const count = counts[kind]
    if (count === undefined) return undefined
    const a11y = entries?.a11y
    const severity = kind === 'a11y' && a11y?.state === 'present'
      && a11y.counts.critical === 0 && a11y.counts.serious === 0 ? 'moderate' : 'high'
    return { kind: 'problem', count, severity }
  }
  return { console: problem('console'), network: problem('network'), a11y: problem('a11y') }
}

export function tabCounts(
  entries: StepEvidenceEntries | undefined,
  aria?: AriaEvidenceEntry,
  selection: Parameters<typeof resolveEvidenceView>[0]['selection'] = 'sub-action',
): Record<EvidenceKind, TabCount | undefined> {
  const signals = stepProblemCounts(entries)
  const countFor = (kind: EvidenceKind): TabCount | undefined => {
    const entry = kind === 'aria' ? aria : entries?.[kind]
    const view = resolveEvidenceView({ kind, entry, selection, read: 'idle' })
    if (view.kind === 'state') return { kind: 'absent', title: view.title }
    if (!entry || entry.state !== 'present' || entry.kind === 'aria') return undefined
    if (entry.kind !== 'variables') {
      const problem = signals[entry.kind]
      if (problem !== undefined) return problem
    }
    const total = entry.kind === 'variables' ? entry.counts.count
      : entry.kind === 'a11y' ? 0 : entry.counts.total
    return total > 0 ? { kind: 'total', count: total }
      : { kind: 'absent', title: EVIDENCE_COPY[kind].empty.title }
  }
  return {
    variables: countFor('variables'), network: countFor('network'), console: countFor('console'),
    aria: countFor('aria'), a11y: countFor('a11y'),
  }
}

export function countedTriggerName(kind: EvidenceKind, value: Exclude<TabCount, { kind: 'absent' }>): string {
  const { count } = value
  const problem = value.kind === 'problem'
  switch (kind) {
    case 'variables':
      return t('evidence.trigger.variables', { number: count })
    case 'aria':
      return t('evidence.trigger.aria', { number: count })
    case 'console':
      return problem
        ? t('evidence.trigger.consoleErrors', { count })
        : t('evidence.trigger.consoleMessages', { count })
    case 'network':
      return problem
        ? t('evidence.trigger.networkFailed', { count })
        : t('evidence.trigger.networkRequests', { count })
    case 'a11y':
      return t('evidence.trigger.a11yViolations', { count })
  }
}

export function absentTriggerName(kind: EvidenceKind, title: string): string {
  return t('evidence.trigger.absent', { tab: TAB_NAMES[kind], title })
}

export function signalBadgeName(kind: StepSignal, count: number, step: number): string {
  switch (kind) {
    case 'console':
      return t('evidence.signal.console', { count, step })
    case 'network':
      return t('evidence.signal.network', { count, step })
    case 'a11y':
      return t('evidence.signal.a11y', { count, step })
  }
}
