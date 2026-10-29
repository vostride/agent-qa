// Bounded screen-settle gate.
// CRITICAL: provider-neutral + storage-neutral. No node:* imports, no fs/sharp,
// no core/model/adapter package imports. Polls screenIdentityHash and proceeds only
// when two consecutive values match (the acting condition), bounded by maxPolls AND an
// optional deadline so an animated/never-stable screen can never hang the loop:
// it proceeds on the LATEST observation's hash rather than spinning. The returned hash
// is the single value downstream consumes — settle-stability and the 8th cache-key
// component. 2026-10-08: its third job, the Phase-358 progress/no-change
// signal, was deleted with the progress subsystem; settle itself is kept.
//
// SettleResult additionally exposes `settled`: true when the gate
// exited on two consecutive matching hashes (the acting condition), false when the
// maxPolls/deadline bound forced a proceed-on-latest. 2026-10-08: its one reader,
// the Phase-358 transient-load stagnation classifier, was deleted by 436-03, so no production
// code reads `settled` now; call sites read `state`/`hash`.

import { screenIdentityHash } from '@vostride/agent-qa-schema'
import type { ScreenState } from '@vostride/agent-qa-schema'

export interface SettleOptions {
  /** Maximum extra poll iterations after the first observation (bounded, Pitfall 4). */
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
  /**
   * True ⇒ the gate exited on two consecutive matching hashes (the screen quiesced,
   * the acting condition). False ⇒ maxPolls/deadline forced a proceed-on-latest exit
   * (the screen never stabilized). The Phase-358 transient-load classifier consumes
   * this as its instability signal. Additive; existing readers ignore it.
   */
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

/**
 * Poll `observe` until `screenIdentityHash` is stable across two consecutive
 * observations, or until the maxPolls / deadline bound is hit — then proceed on the
 * latest observation. The first observation is always taken (it doubles as the
 * sub-action's stateBefore — no extra capture, Pitfall 5); only the additional poll
 * iterations before stability are the settle cost.
 */
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
