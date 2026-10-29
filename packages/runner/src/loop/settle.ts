// At the poll or deadline bound it proceeds on the latest hash, so an unstable screen cannot hang.

import { screenIdentityHash } from '@vostride/agent-qa-schema'
import type { ScreenState } from '@vostride/agent-qa-schema'

export interface SettleOptions {
  /** Maximum extra poll iterations after the first observation. */
  maxPolls: number
  /** Abort-aware wait between polls; 0 = poll back-to-back (composition injects the real value). */
  intervalMs: number
  /** Wall-clock deadline (performance.now() basis); 0 = no deadline. Proceed-on-latest when exceeded. */
  deadline: number
  /** Optional abort signal — cancels the inter-poll wait immediately when aborted. */
  signal?: AbortSignal
}

export interface SettleResult {
  state: ScreenState
  hash: string
  // True when two consecutive hashes matched; false when a poll or deadline bound forced the exit.
  settled: boolean
}

async function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// The first observation doubles as stateBefore, so only extra polls before stability cost.
export async function settle(
  observe: () => Promise<ScreenState>,
  opts: SettleOptions,
): Promise<SettleResult> {
  let prevHash: string | undefined
  let state = await observe()
  let hash = screenIdentityHash(state)
  let settled = false

  for (let i = 0; i < opts.maxPolls; i++) {
    // Two consecutive matching hashes → settled (the acting condition).
    if (hash === prevHash) {
      settled = true
      break
    }
    // Bounded: proceed on the latest hash rather than hanging.
    if (opts.deadline && performance.now() > opts.deadline) break
    prevHash = hash
    await abortAwareSleep(opts.intervalMs, opts.signal)
    state = await observe()
    hash = screenIdentityHash(state)
  }

  return { state, hash, settled }
}
