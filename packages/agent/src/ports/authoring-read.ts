import type { AuthoringBrief, ScopeKey } from '@vostride/agent-qa-schema'

// A read-only port: knowledge writes belong to `KnowledgePort`.
export interface AuthoringReadPort {
  getAuthoringBrief(intent: string, scope: ScopeKey): Promise<AuthoringBrief>
}
