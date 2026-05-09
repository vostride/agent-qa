import { generateRunId as generateSharedRunId } from '@vostride/agent-qa-ids'

export function generateRunId(): string {
  return generateSharedRunId()
}
