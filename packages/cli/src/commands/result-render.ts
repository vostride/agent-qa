// The default is the whole payload pretty-printed; per-op folds add a sentence and never suppress.

import { RunDetailProjectionSchema } from '@vostride/agent-qa-schema'
import type { ClauseResult, RunDetailProjection } from '@vostride/agent-qa-schema'
import pc from 'picocolors'

export const RECORDING_SAVED_LINE = 'Recording saved: {size} MB{duration}. Open this run in the dashboard to play it.'
export const RECORDING_FAILED_LINE = 'Recording could not be saved.'

// The op is named when the turn filed more than one receipt, so no payload sits under another op's.
export function renderClauseResults(
  results: readonly ClauseResult[],
  receiptCount: number,
): string[] {
  if (results.length === 0) return []
  const lines: string[] = []
  for (const result of results) {
    if (receiptCount > 1) lines.push(pc.dim(result.functionId))
    const detail = result.functionId === 'runs.detail'
      ? RunDetailProjectionSchema.safeParse(result.payload) : undefined
    if (detail?.success) lines.push(...renderRunDetail(detail.data))
    else lines.push(renderPayload(result.payload))
  }
  return lines
}

function renderRunDetail(detail: RunDetailProjection): string[] {
  const recordingLines: string[] = []
  let omitted = false
  const members = detail.members.map(({ recording, ...member }) => {
    if (recording === undefined) return member
    omitted = true
    const prefix = `Test ${member.testIndex + 1}: `
    if (recording.state === 'present') {
      const seconds = recording.durationMs === undefined ? undefined : Math.floor(recording.durationMs / 1000)
      const duration = seconds === undefined ? ''
        : `, ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      recordingLines.push(prefix + RECORDING_SAVED_LINE
        .replace('{size}', (recording.byteLength / 1_000_000).toFixed(1))
        .replace('{duration}', duration))
    } else if (recording.reason === 'failed') {
      recordingLines.push(prefix + RECORDING_FAILED_LINE)
    }
    return member
  })
  return [renderPayload({ ...detail, members }), ...recordingLines,
    ...(omitted ? ['Member capture metadata omitted; use agent-qa fn runs.detail --json for the full result.'] : []),
  ]
}

/**
 * One payload, whole.
 *
 * `JSON.stringify` CAN ANSWER `undefined` — for an undefined value, and for a function or symbol —
 * and a render that pushed that would print the word `undefined` where a result belongs. An op that
 * returned nothing is a real, ordinary thing (`resultKind: 'unary'` with a void-ish contract), and
 * what a person needs to read then is that there was nothing rather than a JavaScript keyword.
 */
function renderPayload(payload: unknown): string {
  const rendered = JSON.stringify(payload, null, 2)
  return rendered === undefined ? pc.dim('(no result)') : rendered
}
