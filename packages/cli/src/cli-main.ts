import { runCli } from './cli-error-handler.js'
import { startCliErrorReporting } from './composition/error-reporting-start.js'
import { createAgentQaProgram } from './program.js'
import { rejectRemovedCliSurface } from './removed-cli-surface.js'
import { processUpdateNotice } from './version-notice.js'

rejectRemovedCliSurface()

const program = createAgentQaProgram({
  updateNotice: processUpdateNotice,
  startReporting: startCliErrorReporting,
})

void runCli(program)

export { program }
