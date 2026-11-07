import { runCli } from './cli-error-handler.js'
import { createAgentQaProgram } from './program.js'
import { rejectRemovedCliSurface } from './removed-cli-surface.js'

rejectRemovedCliSurface()

const program = createAgentQaProgram()

void runCli(program)

export { program }
