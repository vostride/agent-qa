import { LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'

import { processIsAlive } from '../daemon/registration.js'

// the dashboard's RunOwnership, injected so dashboard-server gains no
// dependency; typed here and read via agent-local, as the FUNC-02 firewall bars naming either.
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
      // 2026-10-16 (442-15, GAP-D2): a miss is not remembered; the next read retries.
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
