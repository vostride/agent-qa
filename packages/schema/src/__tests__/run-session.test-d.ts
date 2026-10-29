import { expectTypeOf } from 'vitest'
import type { RunId, RunStatus, ExecutionContext } from '../run/index'
import type {
  LiveFrame,
  LiveFrameEndReason,
  LiveFrameSubscription,
  LiveStreamDeclaration,
} from '../run/live-stream'
import type { RunCompletion, RunSession } from '../run/run-session'

// M1-lite contract: identity + status, the subscribe/replay seam,
// run-level cancel, awaitable done.
//
// plus the per-handle FRAME seam — `subscribeFrames` and
// `streamCapabilityOf`. `liveUrl` stays ABSENT and is not an oversight: it is minted by the
// function-layer op `runs.liveurl` over a signer this type knows nothing about, which is what
// keeps token power off the session. Arbiter/control stay absent (Mode A, post-v2.0).
expectTypeOf<RunSession['id']>().toEqualTypeOf<RunId>()
expectTypeOf<RunSession['status']>().toEqualTypeOf<'running' | RunStatus>()
expectTypeOf<RunSession['executionContext']>().toEqualTypeOf<ExecutionContext>()
expectTypeOf<RunSession['cancel']>().toEqualTypeOf<() => void>()
expectTypeOf<RunSession['done']>().toEqualTypeOf<Promise<RunCompletion>>()
expectTypeOf<RunSession['subscribe']>().parameter(0).toEqualTypeOf<number>()
expectTypeOf<RunSession['subscribe']>().returns.toEqualTypeOf<() => void>()
expectTypeOf<RunSession['streamCapabilityOf']>().parameter(0).toEqualTypeOf<number>()
expectTypeOf<RunSession['streamCapabilityOf']>().returns.toEqualTypeOf<LiveStreamDeclaration>()
expectTypeOf<RunSession['subscribeFrames']>().parameter(0).toEqualTypeOf<number>()
// the end callback names its reason; a zero-argument callback still fits.
expectTypeOf<RunSession['subscribeFrames']>().parameter(2)
  .toEqualTypeOf<((reason: LiveFrameEndReason) => void) | undefined>()
expectTypeOf<() => void>().toMatchTypeOf<NonNullable<Parameters<RunSession['subscribeFrames']>[2]>>()
expectTypeOf<RunSession['subscribeFrames']>().returns
  .toEqualTypeOf<LiveFrameSubscription | undefined>()
expectTypeOf<keyof RunSession>().toEqualTypeOf<
  'id' | 'status' | 'executionContext' | 'subscribe' | 'subscribeFrames' | 'streamCapabilityOf'
  | 'cancel' | 'done'
>()

const ok: RunSession = {
  id: '' as RunId,
  status: 'running',
  executionContext: 'ci',
  subscribe: () => () => {},
  subscribeFrames: (_handle: number, _onFrame: (frame: LiveFrame) => void) => undefined,
  streamCapabilityOf: () => ({ kind: 'none' }),
  cancel: () => {},
  done: Promise.resolve({} as RunCompletion),
}

const bad: RunSession = {
  id: '' as RunId,
  // @ts-expect-error RunSession status must be 'running' or a RunStatus terminal value.
  status: 'web',
  executionContext: 'ci',
  subscribe: () => () => {},
  subscribeFrames: () => undefined,
  streamCapabilityOf: () => ({ kind: 'none' }),
  cancel: () => {},
  done: Promise.resolve({} as RunCompletion),
}

void ok
void bad
