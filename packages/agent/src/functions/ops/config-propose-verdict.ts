// One fold for every config op, reading only discriminants and the arm's named reason.

import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'

import type { ClauseVerdict } from '../spec.js'

// `interrupted` is `failed`: some files hold the change and one does not.
export function classifyConfigChangeOutput(output: ConfigChangeOutput): ClauseVerdict {
  switch (output.outcome) {
    case 'applied':
      return { status: 'executed', outcome: `applied: ${output.files.join(', ')}` }
    case 'no-change':
      return { status: 'executed', outcome: `no change: ${output.path} already holds that value` }
    case 'blocked':
      return { status: 'refused', outcome: output.blockedReason }
    case 'refused':
      return { status: 'refused', outcome: output.reason }
    case 'interrupted':
      return { status: 'failed', outcome: `interrupted at ${output.failed.path}: ${output.failed.reason}` }
  }
}
