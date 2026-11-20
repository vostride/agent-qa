import { printLogLine } from '@vostride/agent-qa-core/run-text-output'

import type { CurationTailLogger } from './curation-tail.js'
import { knowledgeTaggedMessage } from './knowledge-summary.js'

interface TaggedCurationLine {
  readonly tag: string
  readonly level: 'warn' | 'info'
  readonly message: string
}

// The curator's log for a host whose terminal shows tagged lines, such as the dashboard's.
export function createTaggedCurationLog(input: {
  readonly logLevel: string
  readonly print?: (line: TaggedCurationLine) => void
}): CurationTailLogger {
  const print =
    input.print ??
    ((line: TaggedCurationLine): void => {
      printLogLine({ ...line })
    })
  const verbose = input.logLevel === 'debug'
  return {
    warn: (message) => {
      print({ tag: 'post-run', level: 'warn', message })
    },
    detail: (message, tag) => {
      if (verbose) print({ tag: tag ?? 'knowledge', level: 'info', message })
    },
    summary: (summary) => {
      print({
        tag: 'knowledge',
        level: 'info',
        message: knowledgeTaggedMessage(summary, { verbose }),
      })
    },
  }
}
