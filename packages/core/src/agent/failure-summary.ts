import type { StepResult } from '../types/result.js'

function normalizeFailureTextForComparison(text: string | undefined): string {
  return (text ?? '')
    .trim()
    .replace(/^step failed:\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
}

export function generateFailureSummary(steps: StepResult[]): string {
  const failedSteps = steps.filter(s => s.status === 'failed')
  if (failedSteps.length === 0) return ''

  const firstFailed = failedSteps[0]
  const stepIndex = steps.indexOf(firstFailed) + 1
  const total = steps.length
  const error = firstFailed.error || firstFailed.trace?.error || 'Unknown error'

  const parts: string[] = [
    `Step ${stepIndex}/${total} "${firstFailed.name}" failed: ${error}`,
  ]

  const reasoning = firstFailed.trace?.reasoning
  if (
    reasoning
    && normalizeFailureTextForComparison(reasoning) !== normalizeFailureTextForComparison(error)
  ) {
    parts.push(`Agent reasoning: ${reasoning}`)
  }

  if (firstFailed.trace?.plannedAction) {
    const action = firstFailed.trace.plannedAction
    const ref = ('ref' in action ? action.ref : '') || ('url' in action ? action.url : '') || ''
    parts.push(`Attempted action: ${action.type}${ref ? ` on ${ref}` : ''}`)
  }

  if (firstFailed.healingAttempts && firstFailed.healingAttempts.length > 0) {
    parts.push(`${firstFailed.healingAttempts.length} healing attempt(s) were tried before giving up.`)
  }

  if (failedSteps.length > 1) {
    parts.push(`(${failedSteps.length} steps failed in total)`)
  }

  return parts.join('\n')
}
