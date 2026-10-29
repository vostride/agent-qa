// No scope check and no op gate: every caller here reaches the binding check this registry refuses.

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

// A registry over no dependencies; the context names each cell for the record and nothing reads it.
function benchAt(_ctx: ExecutionContext) {
  return createFunctionRegistry({
    deps: {} as unknown as FunctionDeps,
  })
}

// The scope refusal class has no export, so it is matched by name.
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
  it('grants the whole scope vocabulary, member for member', () => {
    expect(Object.keys(CLI_FUNCTION_CALLER).sort()).toEqual(['origin', 'surface'])
    expect(CLI_FUNCTION_CALLER).not.toHaveProperty('grantedScopes')
    expect(Object.keys(schema), 'the retired vocabulary is still exported').not.toContain('FunctionScopeSchema')
  })

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
  it('holds test-write', () => {
    expect(Object.keys(DAEMON_FUNCTION_CALLER).sort()).toEqual(['origin', 'surface'])
    expect(DAEMON_FUNCTION_CALLER).not.toHaveProperty('grantedScopes')
  })

  it('reaches the binding check for authoring.draft.write from local-headless', async () => {
    const error = await refusalFrom('local-headless', DAEMON_FUNCTION_CALLER)

    expect(isScopeRefusal(error)).toBe(false)
    expect(error).toBeInstanceOf(FunctionNotBoundError)
  })

  it('is ALLOWED past both control points for authoring.draft.edit — the second holder of test-write', async () => {
    // The binding refusal is asserted by class, so an unrelated crash cannot pass for passage.
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
