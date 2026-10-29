import { LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'

import { processIsAlive } from '../daemon/registration.js'

// Injected so dashboard-server gains no dependency; the firewall bars naming either package.
export interface CliRunOwnership {
  readonly self: {
    readonly pid: number
    readonly incarnation: string | null
  }
  readonly probe: {
    isAlive(pid: number): boolean
    incarnationOf(pid: number): string | undefined
  }
}

export const RUN_OWNER_START_TIME_TIMEOUT_MS = 1_000

export function createRunOwnership({ readStartTime, isAlive }: {
  readStartTime: (pid: number, timeoutMs: number) => string | undefined
  isAlive: (pid: number) => boolean
}): CliRunOwnership {
  let ownStartTime: string | undefined
  return {
    get self() {
      // A miss is not remembered; the next read retries.
      ownStartTime ??= readStartTime(process.pid, RUN_OWNER_START_TIME_TIMEOUT_MS)
      return { pid: process.pid, incarnation: ownStartTime ?? null }
    },
    probe: {
      isAlive,
      incarnationOf: (pid) => readStartTime(pid, RUN_OWNER_START_TIME_TIMEOUT_MS),
    },
  }
}

let composed: CliRunOwnership | undefined

export function composeRunOwnership(): CliRunOwnership {
  composed ??= createRunOwnership({
    readStartTime: LOCAL_DAEMON_CAPABILITIES.resolveProcessIncarnation,
    isAlive: processIsAlive,
  })
  return composed
}
