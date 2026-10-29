// The three quarantine verbs at the function layer (Phase 390, D-12/D-13 / FLAK-03).
//
// `quarantine.list` is the machine-readable enumeration FLAK-03 asks for; `quarantine.release`
// and `quarantine.add` are the manual halves of the exit path. All three bind through the new
// OPTIONAL `quarantine` dep, so this plan registers them UNBOUND by construction — the port's
// implementation and the composition-root binding land in a later plan, and until they do a
// host says so BY NAME rather than answering an empty list about a ledger it cannot see.
//
// WHAT THESE CASES PIN, AND WHY EACH ONE:
//
//  1. REFUSAL BY NAME, AT BOTH LAYERS. `invokeFunction` refuses on the DECLARATION before it
//     ever reaches an implementation; each op body ALSO guards, so a direct call cannot slip
//     past. An unbound write verb that answered a silent no-op would tell an operator their
//     quarantine landed when nothing was written.
//  2. THE OP ADDS NO ORDERING. D-12's triage-queue order is the implementation's law. The
//     list op forwards the port's entries verbatim, so a second sort here could not disagree
//     with the one that is pinned where it is implemented.
//  3. RISK IS STATED ON THE SPEC. `list` is `readOnly: true`; `release` and `add` are
//     `readOnly: false`. (2026-10-01, 432-25, D-12: no verb declares a scope any more, and every
//     caller reaches all three. The scopes once hid the writes from safe-mode listings and sent
//     them through the deleted gate as mutations; the risk descriptor still says they write.)

import type {
  FunctionCaller,
  QuarantineAddInput,
  QuarantineEntryState,
  QuarantineListOutput,
  QuarantineOperationsPort,
  QuarantineReleaseInput,
} from '@vostride/agent-qa-schema'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { FunctionNotBoundError, invokeFunction } from '../invoke.js'
import { createFunctionRegistry } from '../registry.js'
import {
  QUARANTINE_ADD_FUNCTION_ID,
  quarantineAddSpec,
} from '../ops/quarantine-add.js'
import {
  QUARANTINE_LIST_FUNCTION_ID,
  quarantineListSpec,
} from '../ops/quarantine-list.js'
import {
  QUARANTINE_RELEASE_FUNCTION_ID,
  quarantineReleaseSpec,
} from '../ops/quarantine-release.js'
import type { FunctionDeps } from '../spec.js'

// 2026-10-01 (432-25, D-12): the retired `grantedScopes` and `safeMode` fields are dropped; nothing
// read them.
const CALLER: FunctionCaller = {
  surface: 'test',
  origin: 'agent',
}

const IDENTITY = {
  product: 'example-web',
  filePath: 'tests/checkout.test.yaml',
  testName: 'checkout completes',
}

function entryState(overrides: Partial<QuarantineEntryState> = {}): QuarantineEntryState {
  return {
    ...IDENTITY,
    fingerprint: 'fp-1',
    verdictClass: 'flake',
    owner: 'unassigned',
    enteredAt: '2026-08-05T10:00:00.000Z',
    expiresAt: '2026-09-04T10:00:00.000Z',
    enteredCount: 1,
    firstEnteredAt: '2026-08-05T10:00:00.000Z',
    state: 'quarantined',
    ...overrides,
  }
}

/**
 * A stub port that RECORDS what it was handed and answers a fixed arm.
 *
 * Recording is the point: the forwarding cases below assert the op passed the caller's
 * validated input through unchanged, which an answer-only stub could not distinguish from an
 * op that rebuilt the request out of defaults.
 */
function stubPort(entries: readonly QuarantineEntryState[]) {
  const released: QuarantineReleaseInput[] = []
  const added: QuarantineAddInput[] = []
  const port: QuarantineOperationsPort = {
    list: () => Promise.resolve(entries),
    release: (input) => {
      released.push(input)
      return Promise.resolve({ kind: 'no-entry' })
    },
    add: (input) => {
      added.push(input)
      return Promise.resolve({ kind: 'renewed', entry: entryState({ owner: input.owner ?? 'unassigned' }) })
    },
  }
  return { port, released, added }
}

function deps(quarantine?: QuarantineOperationsPort): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) =>
        Promise.resolve({ kind: 'not-found', schemaVersion: 2, recordId } as const),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: () => Promise.resolve(undefined),
    },
    config: {
      getMasked: () => Promise.resolve({
        schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
        configPath: 'agent-qa.config.yaml',
        entries: [],
      }),
    },
    ...(quarantine === undefined ? {} : { quarantine }),
  }
}

function registryWith(quarantine?: QuarantineOperationsPort) {
  return createFunctionRegistry({
    deps: deps(quarantine),
  })
}

const ALL_QUARANTINE_IDS = [
  QUARANTINE_ADD_FUNCTION_ID,
  QUARANTINE_LIST_FUNCTION_ID,
  QUARANTINE_RELEASE_FUNCTION_ID,
] as const

// ---- Registration and the id vocabulary ---------------------------------

describe('the three quarantine verbs are registered under the locked taxonomy', () => {
  it('spells each id once, in the lowercase-dot quarantine domain', () => {
    expect(QUARANTINE_LIST_FUNCTION_ID).toBe('quarantine.list')
    expect(QUARANTINE_RELEASE_FUNCTION_ID).toBe('quarantine.release')
    expect(QUARANTINE_ADD_FUNCTION_ID).toBe('quarantine.add')
  })

  it('lists all three in every composition — declared everywhere, bound where the port is', () => {
    const listed = registryWith().list(CALLER).map((declaration) => declaration.id)

    for (const id of ALL_QUARANTINE_IDS) {
      expect(listed, `${id} must be registered`).toContain(id)
    }
  })
})

// ---- Risk classification -----------------------------------------------
//
// RE-SPELLED 2026-10-01 (432-25, D-12). This block was 'scope and risk classification (D-13)' and
// asserted `['read']` on list and `['knowledge-write']` on release and add. No verb declares a
// scope now; the read/write split it pinned survives on the risk descriptor, asserted unchanged.

describe('risk classification', () => {
  it('declares list read-tier and read-only', () => {
    expect(quarantineListSpec).not.toHaveProperty('requiredScopes')
    expect(quarantineListSpec.risk.readOnly).toBe(true)
    expect(quarantineListSpec.risk.name).toBe('fn:quarantine.list')
    expect(quarantineListSpec.risk.recognized).toBe(true)
  })

  // Renamed from 'declares release and add as WRITES — the same scope family the shipped write op
  // uses' (432-25): the write claim survives on `readOnly: false`; the scope family does not.
  it('declares release and add as WRITES, with no scope', () => {
    for (const spec of [quarantineReleaseSpec, quarantineAddSpec]) {
      expect(spec, spec.id).not.toHaveProperty('requiredScopes')
      expect(spec.risk.readOnly, spec.id).toBe(false)
      expect(spec.risk.recognized, spec.id).toBe(true)
      expect(spec.risk.name, spec.id).toBe(`fn:${spec.id}`)
    }
  })

  it('binds all three through the ONE new optional dep key', () => {
    for (const spec of [quarantineListSpec, quarantineReleaseSpec, quarantineAddSpec]) {
      expect(spec.boundThrough, spec.id).toBe('quarantine')
    }
  })

  it('answers unary results — no verb here streams', () => {
    for (const spec of [quarantineListSpec, quarantineReleaseSpec, quarantineAddSpec]) {
      expect(spec.resultKind, spec.id).toBe('unary')
    }
  })
})

// ---- Unbound refusal, by name, at both layers --------------------------

describe('an unbound host refuses BY NAME, never a silent no-op', () => {
  it('lists all three as unbound where no quarantine port is supplied', () => {
    const byId = new Map(
      registryWith().list(CALLER).map((declaration) => [declaration.id, declaration]),
    )

    for (const id of ALL_QUARANTINE_IDS) {
      expect(byId.get(id)?.bindingStatus, `${id} must list unbound`).toBe('unbound')
    }
  })

  it('refuses each verb through the gate with FunctionNotBoundError', async () => {
    const registry = registryWith()

    for (const [id, input] of [
      [QUARANTINE_LIST_FUNCTION_ID, {}],
      [QUARANTINE_RELEASE_FUNCTION_ID, { ...IDENTITY }],
      [QUARANTINE_ADD_FUNCTION_ID, { ...IDENTITY }],
    ] as const) {
      // The inputs PARSE, so this refusal cannot be a contract refusal wearing a binding
      // refusal's clothes — validation precedes the binding check.
      await expect(invokeFunction(registry, id, input, CALLER), id)
        .rejects.toBeInstanceOf(FunctionNotBoundError)
    }
  })

  it('guards inside each op body too, so a direct call cannot slip past the declaration', async () => {
    const bare = deps()

    await expect(quarantineListSpec.invoke({}, bare)).rejects.toMatchObject({
      name: 'FunctionNotBoundError',
      functionId: QUARANTINE_LIST_FUNCTION_ID,
    })
    await expect(quarantineReleaseSpec.invoke({ ...IDENTITY }, bare)).rejects.toMatchObject({
      name: 'FunctionNotBoundError',
      functionId: QUARANTINE_RELEASE_FUNCTION_ID,
    })
    await expect(quarantineAddSpec.invoke({ ...IDENTITY }, bare)).rejects.toMatchObject({
      name: 'FunctionNotBoundError',
      functionId: QUARANTINE_ADD_FUNCTION_ID,
    })
  })
})

// ---- Bound: the ops forward, and add nothing ---------------------------

describe('with a port bound, each op forwards and adds nothing of its own', () => {
  it('serves the port entries VERBATIM — the op re-sorts nothing (the port owns the ordering)', async () => {
    // Deliberately NOT in any order the op could have produced: unassigned last, expiry
    // descending, testName descending. A sort in the op would visibly rewrite this.
    const entries = [
      entryState({ testName: 'zulu', owner: 'ada', enteredAt: '2026-08-09T00:00:00.000Z' }),
      entryState({ testName: 'alpha', owner: 'unassigned', enteredAt: '2026-08-01T00:00:00.000Z' }),
      entryState({ testName: 'mike', owner: 'bob', enteredAt: '2026-08-05T00:00:00.000Z' }),
    ]
    const { port } = stubPort(entries)

    const result = await invokeFunction(
      registryWith(port),
      QUARANTINE_LIST_FUNCTION_ID,
      {},
      CALLER,
    ) as QuarantineListOutput

    expect(result.entries).toEqual([...entries])
  })

  it('answers an empty listing for an empty ledger — [] is a result, not an absence', async () => {
    const { port } = stubPort([])

    const result = await invokeFunction(
      registryWith(port),
      QUARANTINE_LIST_FUNCTION_ID,
      {},
      CALLER,
    ) as QuarantineListOutput

    expect(result.entries).toEqual([])
  })

  it('forwards the release identity unchanged and returns the port arm untouched', async () => {
    const { port, released } = stubPort([])

    const result = await invokeFunction(
      registryWith(port),
      QUARANTINE_RELEASE_FUNCTION_ID,
      { ...IDENTITY },
      CALLER,
    )

    expect(released).toEqual([IDENTITY])
    expect(result).toEqual({ kind: 'no-entry' })
  })

  it('forwards an add with its optional owner claim and returns the renewed arm untouched', async () => {
    const { port, added } = stubPort([])

    const result = await invokeFunction(
      registryWith(port),
      QUARANTINE_ADD_FUNCTION_ID,
      { ...IDENTITY, owner: 'ada' },
      CALLER,
    )

    expect(added).toEqual([{ ...IDENTITY, owner: 'ada' }])
    expect(result).toMatchObject({ kind: 'renewed' })
  })

  it('lists all three as bound once the port is supplied — the same specs, a different host', () => {
    const { port } = stubPort([])
    const byId = new Map(
      registryWith(port).list(CALLER).map((declaration) => [declaration.id, declaration]),
    )

    for (const id of ALL_QUARANTINE_IDS) {
      expect(byId.get(id)?.bindingStatus, `${id} must list bound`).toBe('bound')
    }
  })
})

// ---- C432-ALL-OPS-AVAILABLE (432-25, D-12) ------------------------------
//
// The two writes once required `knowledge-write`. Retried from three callers that differ in surface
// and origin, and that carry no scope at all, each write is served every time: the port is reached
// once per attempt, and every caller gets the same answer.
describe('the quarantine writes serve every caller', () => {
  it('a retried add and release are served alike to every caller', async () => {
    const { port, added, released } = stubPort([])
    const registry = createFunctionRegistry({
      deps: deps(port),
    })
    const callers: readonly FunctionCaller[] = [
      CALLER,
      { surface: 'cli', origin: 'human' },
      { surface: 'mcp', origin: 'agent' },
    ]

    const answers: unknown[] = []
    for (const caller of callers) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        answers.push(await invokeFunction(registry, QUARANTINE_ADD_FUNCTION_ID, { ...IDENTITY }, caller))
        answers.push(await invokeFunction(registry, QUARANTINE_RELEASE_FUNCTION_ID, { ...IDENTITY }, caller))
      }
    }

    expect(added).toEqual(Array.from({ length: 6 }, () => IDENTITY))
    expect(released).toEqual(Array.from({ length: 6 }, () => IDENTITY))
    expect(answers).toEqual(Array.from({ length: 6 }, () => [
      { kind: 'renewed', entry: entryState() },
      { kind: 'no-entry' },
    ]).flat())
  })
})
