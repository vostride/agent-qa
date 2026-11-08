import { resolveIsCI } from './ci-env.js'

export interface UpdateNoticeGate {
  env: NodeJS.ProcessEnv
  stdoutIsTTY: boolean
  stderrIsTTY: boolean
  json: boolean
  logLevel?: string
}

export type UpdateNotice = (input: {
  json: boolean
  logLevel?: string
  refresh?: boolean
}) => Promise<void>

// The one gate for both the notice and the registry refresh: people at a terminal only.
export function updateNoticeApplies(gate: UpdateNoticeGate): boolean {
  return (
    gate.stdoutIsTTY &&
    gate.stderrIsTTY &&
    !resolveIsCI(gate.env) &&
    gate.json !== true &&
    gate.logLevel !== 'silent'
  )
}

// For a command that ends through `process.exit`, which skips the program's postAction hook. It
// starts no registry refresh, because the exit that follows would cut the request off.
export async function showUpdateNoticeBeforeExit(
  updateNotice: UpdateNotice | undefined,
  logLevel: string | undefined,
): Promise<void> {
  if (updateNotice === undefined) return
  try {
    const applies = updateNoticeApplies({
      env: process.env,
      stdoutIsTTY: process.stdout.isTTY === true,
      stderrIsTTY: process.stderr.isTTY === true,
      json: false,
      logLevel,
    })
    if (applies) await updateNotice({ json: false, logLevel, refresh: false })
  } catch {
    // The notice never changes a command's outcome.
  }
}
