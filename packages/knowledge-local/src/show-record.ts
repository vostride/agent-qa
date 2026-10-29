// Addressing a record by exact id bypasses the serving firewall; an unknown id is a `not-found`.

import type { KnowledgeRecordShowResult } from '@vostride/agent-qa-schema'
import { showRecords } from './show-records.js'

export interface ShowRecordOptions {
  knowledgeRoot: string
  recordId: string
}

// A root with no bundles or no `memory/` is an ordinary `not-found`, not a throw.
export function showRecord(options: ShowRecordOptions): KnowledgeRecordShowResult {
  return showRecords({ knowledgeRoot: options.knowledgeRoot, recordIds: [options.recordId] })[0]!
}
