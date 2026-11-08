import { get as httpsGet } from 'node:https'
import { refreshAgentQaVersionCheck } from '@vostride/agent-qa-core'

// The detached child a command starts to refresh the registry answer. The parent never waits for
// it, so this process exits as soon as its one request ends.
const homeDir = process.argv[2]

void refreshAgentQaVersionCheck({
  ...(homeDir ? { homeDir } : {}),
  now: Date.now(),
  request: httpsGet,
})
  .catch(() => undefined)
  .finally(() => process.exit(0))
