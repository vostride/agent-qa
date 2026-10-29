// The two CLI-host caller records' capability grants (394-13, WTST-01 · WINDOWS 101).
//
// WHY THIS FILE EXISTS. `authoring.draft.write` and `authoring.draft.edit` are REGISTERED and
// BOUND on this host, and both were still refused by name at `invoke.ts`'s scope check — because
// neither `CLI_FUNCTION_CALLER` nor `DAEMON_FUNCTION_CALLER` listed `test-write`, the sixth scope
// 394-01 minted. Every op-level test in `packages/agent` passed throughout: an op's own suite
// constructs its own caller, so a composition that withholds a grant is invisible to all of them.
// The refusal that reached a person named a scope and said nothing about authoring at all.
//
// 2026-10-01 (432-20, D-12): THERE IS NO SCOPE CHECK EITHER. The grants these records carry are
// retired and unread (432-21 removes them from the mints), so no caller here can be refused for its
// grants: every cell below reaches the same binding check, and C432-ALL-OPS-AVAILABLE adds a caller
// holding nothing at all to prove it.
//
// 2026-09-30 (432-13, D-14/D-15): THERE IS NO OP GATE. Cells 2 and 4 are re-spelled: the scope
// check still passes for both holders of `test-write`, and the invocation now reaches the BINDING
// check (this registry binds nothing) instead of a confirm or a fail-closed refusal.
//
// WHAT THE CELLS BELOW MEASURE, AND WHAT THEY DELIBERATELY DO NOT. They measure WHICH CALLERS
// REACH DISPATCH, and where the call then stops — never a claim that a grant widened it. Cell 1
// pins the CLI's grants set-equal to the vocabulary; cell 2 drives `authoring.draft.write` from the
// CLI's interactive context to the confirm. Cell 3 pins LIST MEMBERSHIP on the daemon record (its
// own comment argues why membership rather than set equality); cell 4 drives the write op from the
// daemon's composed `local-headless` context and asserts the GATE refuses it, by name, for its
// tier; cell 5 drives `authoring.draft.edit` from that same context and asserts the gate ALLOWS it
// — the second holder of `test-write` is `mutating-local`, and server.ts argues why that allowance
// is intended. The scope is the POWER's legibility; D-03's two decision points (that confirm and
// 391's inbox accept) remain the only controls there are.

import {
  AUTHORING_DRAFT_EDIT_FUNCTION_ID,
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
  createFunctionRegistry,
  FunctionNotBoundError,
  invokeFunction,
} from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import * as schema from '@vostride/agent-qa-schema'
import type {
  AuthoringDraftEditInput,
  AuthoringDraftWriteInput,
  ExecutionContext,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { CLI_FUNCTION_CALLER } from '../composition/local-agent-host.js'
import { DAEMON_FUNCTION_CALLER } from '../daemon/server.js'

/**
 * A brief the op's `.strict()` input contract accepts, and nothing more.
 *
 * The loop never runs in this file: `authoring.draft.write` is `mutating-shared`, so the gate
 * answers before the binding check and long before dispatch. That is what lets the registry below
 * carry no dependencies at all — a fixture that had to stand up a model and a shelf would be
 * measuring those, not the scope check.
 */
const BRIEF: AuthoringDraftWriteInput = {
  intent: 'write a test for the checkout flow',
  scope: { tier: 'product', key: 'demo-shop' },
}

/**
 * The edit op's equivalent brief. Same posture as `BRIEF`: nothing here is resolved, because the
 * edit cell reads the control points, not the edit.
 */
const EDIT_BRIEF: AuthoringDraftEditInput = {
  testRef: 'tests/checkout.yaml::adds an item to the cart',
  intent: 'also assert the cart badge reads 1',
}

/**
 * A registry over NO dependencies. The execution context is named per cell for the record only:
 * since 432-13 nothing asks, and since 432-20 the registry takes no context it reads.
 */
function benchAt(_ctx: ExecutionContext) {
  return createFunctionRegistry({
    deps: {} as unknown as FunctionDeps,
  })
}

/** The refusal class the scope check raised until 432-20, compared by name since it is deleted. */
function isScopeRefusal(error: unknown): boolean {
  return (error as { name?: unknown } | undefined)?.name === 'FunctionScopeError'
}

async function errorFrom(
  ctx: ExecutionContext,
  caller: Parameters<typeof invokeFunction>[3],
  functionId: string,
  input: unknown,
): Promise<unknown> {
  try {
    await invokeFunction(benchAt(ctx), functionId, input, caller)
  } catch (error: unknown) {
    return error
  }
  throw new Error('the invocation was expected to end in an error and did not')
}

async function refusalFrom(
  ctx: ExecutionContext,
  caller: Parameters<typeof invokeFunction>[3],
): Promise<unknown> {
  return errorFrom(ctx, caller, AUTHORING_DRAFT_WRITE_FUNCTION_ID, BRIEF)
}

describe('CLI_FUNCTION_CALLER', () => {
  // RE-SPELLED 2026-10-01 (432-21, D-12) from 'grants the whole scope vocabulary, member for member'.
  // The full-local-grants rule that cell made mechanical is what D-12 made true of every caller, and
  // the field it pinned is gone from the mint: the CLI record carries attribution only. Whether every
  // op is reachable is C432-ALL-OPS-AVAILABLE's claim below, measured without any grant.
  it('grants the whole scope vocabulary, member for member', () => {
    expect(Object.keys(CLI_FUNCTION_CALLER).sort()).toEqual(['origin', 'surface'])
    expect(CLI_FUNCTION_CALLER).not.toHaveProperty('grantedScopes')
    // 2026-10-02 (432-39, D-10/D-12): the retired vocabulary itself is deleted now, not only unused.
    expect(Object.keys(schema), 'the retired vocabulary is still exported').not.toContain('FunctionScopeSchema')
  })

  // RE-SPELLED 2026-09-30 (432-13) from 'reaches the gate for authoring.draft.write — the refusal
  // is the confirm, not the scope list'. The scope check still passes; with no gate the call
  // reaches the binding check, which this dependency-free registry refuses by name.
  it('reaches the binding check for authoring.draft.write — the scope list passes, nothing asks', async () => {
    const error = await refusalFrom('local-interactive', CLI_FUNCTION_CALLER)

    expect(isScopeRefusal(error)).toBe(false)
    expect(error).toBeInstanceOf(FunctionNotBoundError)
  })
})

describe('a caller holding no grant', () => {
  it('reaches the same binding checks as the CLI and daemon records, for both test-write ops', async () => {
    const grantless = { surface: 'cli', origin: 'human' } as const
    for (const [functionId, input] of [
      [AUTHORING_DRAFT_WRITE_FUNCTION_ID, BRIEF],
      [AUTHORING_DRAFT_EDIT_FUNCTION_ID, EDIT_BRIEF],
    ] as const) {
      const none = await errorFrom('local-headless', grantless, functionId, input)
      const cli = await errorFrom('local-interactive', CLI_FUNCTION_CALLER, functionId, input)
      expect(none, functionId).toBeInstanceOf(FunctionNotBoundError)
      expect((none as Error).message).toBe((cli as Error).message)
      expect(isScopeRefusal(none)).toBe(false)
    }
  })
})

describe('DAEMON_FUNCTION_CALLER', () => {
  // RE-SPELLED 2026-10-01 (432-21, D-12) from 'holds test-write'. The daemon record carries no scope
  // set; the claim that survives — the daemon reaches the test-write ops — is the next cell's.
  it('holds test-write', () => {
    expect(Object.keys(DAEMON_FUNCTION_CALLER).sort()).toEqual(['origin', 'surface'])
    expect(DAEMON_FUNCTION_CALLER).not.toHaveProperty('grantedScopes')
  })

  // RE-SPELLED 2026-09-30 (432-13, D-14/D-15) from 'is still refused for authoring.draft.write —
  // by the gate, for its tier'. There is no fail-closed arm: the daemon's `local-headless` call
  // passes the scope check and reaches the binding check exactly as the CLI's does.
  it('reaches the binding check for authoring.draft.write from local-headless', async () => {
    const error = await refusalFrom('local-headless', DAEMON_FUNCTION_CALLER)

    expect(isScopeRefusal(error)).toBe(false)
    expect(error).toBeInstanceOf(FunctionNotBoundError)
  })

  it('is ALLOWED past both control points for authoring.draft.edit — the second holder of test-write', async () => {
    // THE PIN FOR THE ONE THING THE GRANT DID WIDEN. `test-write` has a second holder,
    // `authoring.draft.edit`, and it is `mutating-local` — a tier `requiresFailClosed` does not
    // refuse — so on this record the edit op became agent-origin reachable. server.ts argues why
    // that is intended (the op only STAGES a proposal; per D-05 the human inbox accept is the
    // consent point, and 391 fixed that an accept is a decision and never a grant). This cell is
    // that decision's pin: it asserts PASSAGE by excluding both control points' error classes, and
    // then names the outcome the op's own body produces on a registry with no `draftShelf` — so an
    // unrelated crash cannot satisfy it. Raise the tier, or add `requiresHumanOrigin`, and this
    // reds by name instead of the posture changing in silence.
    const error = await errorFrom(
      'local-headless',
      DAEMON_FUNCTION_CALLER,
      AUTHORING_DRAFT_EDIT_FUNCTION_ID,
      EDIT_BRIEF,
    )

    expect(isScopeRefusal(error)).toBe(false)
    expect(error).toBeInstanceOf(FunctionNotBoundError)
  })
})
