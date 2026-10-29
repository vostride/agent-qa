// The entity Resource Templates surface, driven directly.
//
// WHY THIS FILE EXISTS. `resources.ts` makes the `resource_link`s embedded in tool results actually
// dereferenceable, which means it turns an UNTRUSTED URI into an entity read. Two properties carry
// that weight and neither is observable from a passing end-to-end read: that the module does no
// parsing of its own (so a URI whose segment and id disagree is refused by the schema package's one
// codec, not by whatever pattern this file happened to write), and that the five templates are
// DERIVED from the kind vocabulary rather than restated beside it.
//
// TWO RECIPES, ON PURPOSE. The derivation cell computes its expectation from
// `ENTITY_URI_SEGMENTS` — the same source the implementation reads — so it catches a template
// planted or dropped in `resources.ts`. The literal cell spells the five URI strings out by hand, so
// it catches a SEGMENT RENAME, which the derivation cell cannot see because both halves would move
// together. Either alone is half a pin.
//
// Each cell names the mutation it is the bar for. A cell that no plausible wrong implementation
// reds is decoration, and this project has measured that lesson more than once.
//
// MUTATION LEGS MEASURED AGAINST THIS FILE — each applied to `../resources.ts`, the
// suite re-run, and the subject restored byte-identically (sha-256 compared) afterwards. Verbatim
// REDs are recorded in `396-03-SUMMARY.md`.
//
//   R1  the codec replaced by a local `agentqa://` regex that splits segment and id      RED (3)
//   R2  a seventh template planted in the derived list                                   RED (4)
//   R3  the D-05 visibility gate removed (register unconditionally)                      RED (2)
//       R3 is now the SHIPPED behaviour — the gate is deleted and every
//       caller of a composition carrying entities.get gets the five templates
//       (C432-RESOURCES-ALL-CALLERS below).
//   R4  `maskText` dropped from the contents text                                        RED (1)
//   R5  the raw URI passed to the op as `ref` instead of the parsed canonical short-ID   RED (1)
//   R6  `maskText` dropped from the OP-refusal path                                      RED (1)
//   R7  `maskText` dropped from the URI-refusal path                              GREEN -> RED (1)
//
// R7 IS WHY THE LAST CELL IN THE SECOND BLOCK EXISTS. The five legs this file was first written
// against all red, but the list was not a partition of the module's claims: dropping the mask from
// the ECHOED URI — the one masked string composed entirely of caller-supplied text — left the whole
// suite green. A claim no plausible wrong implementation reds is decoration, so the leg became a
// cell rather than a footnote, and R7 now reds like the rest.

import { McpServer } from '@modelcontextprotocol/server'
import type { ReadResourceResult } from '@modelcontextprotocol/server'
import {
  ENTITY_KINDS,
  ENTITY_URI_SEGMENTS,
} from '@vostride/agent-qa-schema'
import type { FunctionCaller } from '@vostride/agent-qa-schema'
import type { FunctionDeclaration, FunctionRegistry } from '@vostride/agent-qa-agent'
import { describe, expect, it } from 'vitest'

import {
  ENTITIES_GET_OP_ID,
  ENTITY_RESOURCE_TEMPLATES,
  createEntityResourceReadHandler,
  registerEntityResources,
} from '../resources.js'

/** What one `registerResource` call looked like. */
interface RecordedRegistration {
  readonly name: string
  readonly uriTemplate: string
  readonly title: string | undefined
  readonly mimeType: string | undefined
  readonly read: (uri: URL) => Promise<{ contents: readonly { uri: string; text?: string }[] }>
}

/**
 * A recording stand-in for the server.
 *
 * Narrower than `McpServer` by design — the module's parameter is the narrow structural type, so a
 * cell can observe every registration without assembling a protocol server, and the real
 * `McpServer` still satisfies it (asserted by `catalog.ts`'s own call site once plan 04 wires it).
 */
function recordingServer(): {
  readonly calls: RecordedRegistration[]
  registerResource: (
    name: string,
    template: { uriTemplate: { toString: () => string } },
    config: Record<string, unknown>,
    read: RecordedRegistration['read'],
  ) => void
} {
  const calls: RecordedRegistration[] = []
  return {
    calls,
    registerResource(name, template, config, read) {
      calls.push({
        name,
        uriTemplate: template.uriTemplate.toString(),
        title: config['title'] as string | undefined,
        mimeType: config['mimeType'] as string | undefined,
        read,
      })
    },
  }
}

/** a legacy scope set smuggled past the deleted caller field (cast); nothing reads it. */
function caller(grantedScopes: readonly string[]): FunctionCaller {
  return { surface: 'mcp', origin: 'agent', grantedScopes, safeMode: false } as FunctionCaller
}

/** The declaration a composition that registered `entities.get` publishes for it. */
function entitiesGetDeclaration(): FunctionDeclaration {
  return {
    id: ENTITIES_GET_OP_ID,
    summary: 'Render the entity card for one exact short-ID or agentqa:// URI.',
    resultKind: 'unary',
    risk: { name: `fn:${ENTITIES_GET_OP_ID}`, recognized: true, readOnly: true },
    bindingStatus: 'bound',
    input: {},
    output: {},
  }
}

function registryListing(declarations: readonly FunctionDeclaration[]): FunctionRegistry {
  return { list: () => declarations }
}

const identity = (text: string): string => text

/**
 * The text of one content, read THROUGH the union's discriminant rather than past it.
 *
 * `ReadResourceResult['contents']` is a text-or-blob union, so `contents[0].text` does not typecheck
 * — and the two ways to make it compile are not equivalent. A cast (`as` / `!`) would erase the
 * discriminant, so a handler that answered a base64 BLOB where a caller expects prose would compile
 * and then fail with `undefined` in a diff that names the wrong thing. This reads the tag instead,
 * so "not text at all" is its own loud failure and stays distinguishable from "the wrong text".
 */
function textContentAt(result: ReadResourceResult, index: number): string {
  const content = result.contents[index]
  if (content === undefined) {
    throw new Error(`no resource content at index ${index}`)
  }
  if (!('text' in content)) {
    throw new Error(`resource content at index ${index} is a blob, not text`)
  }
  return content.text
}

/** A recording double for the host-bound `invokeFunction` closure. */
function recordingInvoke(answer: unknown = { kind: 'MEM', shortId: 'MEM-001' }): {
  readonly calls: { opId: string; input: unknown }[]
  invoke: (opId: string, input: unknown) => Promise<unknown>
} {
  const calls: { opId: string; input: unknown }[] = []
  return {
    calls,
    async invoke(opId, input) {
      calls.push({ opId, input })
      return answer
    },
  }
}

describe('the five templates are derived, not restated', () => {
  // THE BAR: R2. Recipe one — computed from the same table the module reads, so a planted or
  // dropped template reds here.
  it('is exactly one template per entity kind, in the vocabulary order', () => {
    expect(ENTITY_RESOURCE_TEMPLATES.map((template) => template.uriTemplate)).toEqual(
      ENTITY_KINDS.map((kind) => `agentqa://${ENTITY_URI_SEGMENTS[kind]}/{id}`),
    )
  })

  // Recipe two — the five strings spelled out by hand. A renamed segment moves the implementation
  // AND the cell above together and neither notices; this one reds. The pair is the discrimination.
  it('pins the five URI templates literally', () => {
    expect(ENTITY_RESOURCE_TEMPLATES.map((template) => template.uriTemplate)).toEqual([
      'agentqa://test/{id}',
      'agentqa://run/{id}',
      'agentqa://memory/{id}',
      'agentqa://policy/{id}',
      'agentqa://target/{id}',
    ])
  })

  it('names each template distinctly, so no registration overwrites another', () => {
    const names = ENTITY_RESOURCE_TEMPLATES.map((template) => template.name)
    expect(new Set(names).size).toBe(ENTITY_RESOURCE_TEMPLATES.length)
  })
})

describe('the read handler resolves through entities.get', () => {
  // THE BAR: R5, and R1 with it. The ref handed to the op is the CANONICAL short-ID the codec
  // produced — `MEM-1` in, `MEM-001` out — so an implementation that forwarded the raw URI, or that
  // split the string itself, reds here rather than passing something the op happens to accept too.
  it('calls entities.get once, with the parsed canonical short-ID as the ref', async () => {
    const recorder = recordingInvoke()
    const read = createEntityResourceReadHandler({ invoke: recorder.invoke, maskText: identity })

    await read(new URL('agentqa://memory/MEM-1'))

    expect(recorder.calls).toEqual([{ opId: 'entities.get', input: { ref: 'MEM-001' } }])
  })

  it('answers the card as one JSON content, addressed by its canonical URI', async () => {
    const recorder = recordingInvoke({ shortId: 'MEM-001', title: 'the checkout memory' })
    const read = createEntityResourceReadHandler({ invoke: recorder.invoke, maskText: identity })

    const result = await read(new URL('agentqa://memory/MEM-1'))

    expect(result.contents).toEqual([
      {
        uri: 'agentqa://memory/MEM-001',
        mimeType: 'application/json',
        text: JSON.stringify({ shortId: 'MEM-001', title: 'the checkout memory' }),
      },
    ])
  })

  // THE BAR: R4. Resource contents are composed from STORED DATA and this handler is registered
  // directly, so it never passes through `catalog.ts`'s one generic masking handler — the masker is
  // a required dep here for the same reason it is one there. Asserted on the text a caller reads
  // AND on what the masker was actually handed, so a masker called on the wrong string still reds.
  //
  // WHAT THE MASKER IS HANDED IS THE ASSERTION THAT MOVED. This cell used to
  // require `seen` to be the whole SERIALISATION — and that requirement was the defect written down
  // as a bar: a literal-substring masker handed an escaped document cannot find a value containing
  // `"`, `\` or a control character, and four such shapes reached callers verbatim. The handler now
  // masks the card's raw string LEAVES AND KEYS, so `seen` is those raw strings. The escape classes
  // themselves are pinned in `masked-serialization.test.ts`; what this cell keeps is the narrower
  // property it always carried — the masker really is called, on the card's own bytes.
  it('masks the card and hands the masker its RAW string leaves, never an escaped serialisation',
    async () => {
      const seen: string[] = []
      const recorder = recordingInvoke({ token: 'sk-live-SECRET' })
      const read = createEntityResourceReadHandler({
        invoke: recorder.invoke,
        maskText: (text) => {
          seen.push(text)
          return text.replaceAll('sk-live-SECRET', '[redacted]')
        },
      })

      const result = await read(new URL('agentqa://memory/MEM-001'))

      expect(textContentAt(result, 0)).toBe('{"token":"[redacted]"}')
      expect(seen).toEqual(['token', 'sk-live-SECRET'])
    })

  // A refusal from the op is an output channel too — the message is what a caller reads.
  it('masks an op refusal rather than letting it out verbatim', async () => {
    const read = createEntityResourceReadHandler({
      invoke: () => Promise.reject(new Error('no entity at sk-live-SECRET')),
      maskText: (text) => text.replaceAll('sk-live-SECRET', '[redacted]'),
    })

    await expect(read(new URL('agentqa://memory/MEM-001'))).rejects.toThrow(
      'no entity at [redacted]',
    )
  })

  // THE BAR: R7, and this cell exists BECAUSE R7 was measured green without it. The module masks
  // three strings — the card, an op refusal, and the URI echoed back when the codec refuses — and
  // only the first two were pinned. The third is the one carrying purely CALLER-SUPPLIED text, so
  // it is the one an injected secret rides in on: a caller-planted value echoed verbatim into an
  // error is exactly the shape of T-395-R5-10. Asserted on the message a caller reads AND on what
  // the masker was handed, so masking the wrong string still reds.
  it('masks the echoed URI when the codec refuses it', async () => {
    const seen: string[] = []
    const read = createEntityResourceReadHandler({
      invoke: () => Promise.reject(new Error('never reached')),
      maskText: (text) => {
        seen.push(text)
        return text.replaceAll('sk-live-SECRET', '[redacted]')
      },
    })

    await expect(read(new URL('agentqa://memory/sk-live-SECRET'))).rejects.toThrow(
      '[redacted] is not a canonical agentqa:// entity address',
    )
    expect(seen).toEqual(['agentqa://memory/sk-live-SECRET'])
  })
})

describe('the codec is the only parser', () => {
  // THE BAR: R1. `agentqa://memory/TST-001` names a memory segment and a TEST id. The codec refuses
  // it because the two halves disagree; a local regex that split segment from id would hand
  // `TST-001` to the op and answer about a test the caller never addressed. The invoke count is
  // asserted at ZERO, because "refused" and "asked and got nothing" are different behaviours.
  it('refuses a URI whose segment and id disagree, without asking the op', async () => {
    const recorder = recordingInvoke()
    const read = createEntityResourceReadHandler({ invoke: recorder.invoke, maskText: identity })

    await expect(read(new URL('agentqa://memory/TST-001'))).rejects.toThrow(
      /not a canonical agentqa:\/\/ entity address/u,
    )
    expect(recorder.calls).toEqual([])
  })

  it('refuses an unknown segment and a malformed id the same way', async () => {
    const recorder = recordingInvoke()
    const read = createEntityResourceReadHandler({ invoke: recorder.invoke, maskText: identity })

    await expect(read(new URL('agentqa://memories/MEM-001'))).rejects.toThrow(/not a canonical/u)
    await expect(read(new URL('agentqa://memory/MEM-abc'))).rejects.toThrow(/not a canonical/u)
    expect(recorder.calls).toEqual([])
  })

  // The sub-resource case the codec's own anchoring exists for: a trailing path must not resolve as
  // the thing it hangs off, or a caller ends up believing a sub-resource exists.
  it('refuses a trailing path segment', async () => {
    const recorder = recordingInvoke()
    const read = createEntityResourceReadHandler({ invoke: recorder.invoke, maskText: identity })

    await expect(read(new URL('agentqa://memory/MEM-001/raw'))).rejects.toThrow(/not a canonical/u)
    expect(recorder.calls).toEqual([])
  })
})

// RE-SPELLED 2026-10-01 from 'registration is gated by the visibility law'.
// The scope gate is deleted: whether the templates exist is a fact about the composition (does it
// register entities.get?) and never about the caller. The URI codec still refuses every bad address
// for every caller (the block above).
describe('registration is a fact about the composition, never the caller', () => {
  it('registers all five templates for a caller granted read', () => {
    const server = recordingServer()

    const registered = registerEntityResources(server, {
      registry: registryListing([entitiesGetDeclaration()]),
      caller: caller(['read']),
      maskText: identity,
    })

    expect(registered).toHaveLength(5)
    expect(server.calls.map((call) => call.uriTemplate)).toEqual(
      ENTITY_RESOURCE_TEMPLATES.map((template) => template.uriTemplate),
    )
  })

  // RE-SPELLED from 'registers nothing for a caller granted nothing'.
  it('registers the same five templates for every caller', () => {
    const callers: readonly FunctionCaller[] = [
      { surface: 'mcp', origin: 'agent' },
      caller([]),
      caller(['read']),
      { surface: 'cli', origin: 'human', grantedScopes: ['read', 'run', 'config-write'], safeMode: true } as FunctionCaller,
    ]
    const answers = callers.map((each) => {
      const server = recordingServer()
      const registered = registerEntityResources(server, {
        registry: registryListing([entitiesGetDeclaration()]),
        caller: each,
        maskText: identity,
      })
      return { registered, uris: server.calls.map((call) => call.uriTemplate) }
    })
    for (const answer of answers) {
      expect(answer.registered).toHaveLength(5)
      expect(answer).toEqual(answers[0])
    }
  })

  // RE-SPELLED from 'reads the required scopes off the declaration, not off a constant'. A legacy
  // declaration that still carried a scope list gates nothing either.
  it('ignores any scope a legacy declaration might still carry', () => {
    const server = recordingServer()
    const legacy = {
      ...entitiesGetDeclaration(),
      requiredScopes: ['read', 'config-write'],
    } as unknown as FunctionDeclaration

    const registered = registerEntityResources(server, {
      registry: registryListing([legacy]),
      caller: caller([]),
      maskText: identity,
    })

    expect(registered).toHaveLength(5)
  })

  // A composition that never registered `entities.get` genuinely cannot serve entity resources.
  // That is a real answer and not an error — exactly how `catalog.ts` treats a missing arm.
  it('registers nothing when the composition does not carry entities.get', () => {
    const server = recordingServer()

    const registered = registerEntityResources(server, {
      registry: registryListing([]),
      caller: caller(['read']),
      maskText: identity,
    })

    expect(registered).toEqual([])
    expect(server.calls).toEqual([])
  })
})

describe('a real v2 McpServer accepts this registration (the SDK cell)', () => {
  // WHY A SECOND SERVER CELL. Every cell above drives a recording stand-in, which proves what this
  // module DOES and nothing about whether the SDK agrees. The `registerResource` metadata argument
  // and the `ResourceTemplate` constructor's mandatory `list` field are both v2 API facts this plan
  // took from documentation; this cell converts them into a measurement, and it is also the
  // compile-time proof that plan 04 can hand `buildAgentQaMcpServer`'s own `McpServer` straight
  // through to `registerEntityResources` — a narrower parameter accepting the wider argument.
  it('registers all five templates on a real McpServer without adaptation', () => {
    const server = new McpServer(
      { name: 'agent-qa', version: '2.0.0' },
      { capabilities: { resources: {} } },
    )

    const registered = registerEntityResources(server, {
      registry: registryListing([entitiesGetDeclaration()]),
      caller: caller(['read']),
      maskText: identity,
    })

    expect(registered).toHaveLength(5)
  })
})

describe('the registered handler really crosses invokeFunction (the wiring cell)', () => {
  // WITHOUT THIS CELL the handler cells above would all be green for a `registerEntityResources`
  // that registered a handler built over some other invoke — they drive the factory directly. This
  // one reads through the callback the SERVER was handed, against a registry that declares
  // `entities.get` but cannot dispatch it, and observes `invokeFunction`'s own refusal coming back.
  // The op id and the wall are both pinned by the message.
  it('routes the registered read through invokeFunction on entities.get', async () => {
    const server = recordingServer()

    registerEntityResources(server, {
      registry: registryListing([entitiesGetDeclaration()]),
      caller: caller(['read']),
      maskText: identity,
    })

    const memory = server.calls.find((call) => call.uriTemplate === 'agentqa://memory/{id}')
    await expect(memory?.read(new URL('agentqa://memory/MEM-001'))).rejects.toThrow(
      'Unknown function: entities.get',
    )
  })
})
