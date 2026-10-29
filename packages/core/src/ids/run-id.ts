import { generateRunId as generateSharedRunId, isCanonicalRunId as isSharedCanonicalRunId } from '@vostride/agent-qa-ids'

export function generateRunId(): string {
  return generateSharedRunId()
}

// The mint's inverse beside it, so the two never disagree on the id shape.
export function isCanonicalRunId(value: string): boolean {
  return isSharedCanonicalRunId(value)
}
