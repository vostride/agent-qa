import { generateHookId as generateSharedHookId } from '@vostride/agent-qa-ids'

// Re-exported so a caller that can validate a hook id can also mint one through core.
export function generateHookId(): string {
  return generateSharedHookId()
}
