// A derived cell and a literal cell: the first catches a planted template, the second a rename.

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

// A recording stand-in, narrower than `McpServer`; the real server still satisfies the type.
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

// A legacy scope set cast past the deleted caller field; nothing reads it.
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
  // Computed from the table the module reads, so a planted or dropped template fails here.
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
  // The op gets the codec's canonical short-ID, so forwarding or splitting the raw URI fails here.
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

  // The masker gets the card's raw leaves, because an escaped document hides raw secrets.
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

  // The echoed URI is pure caller text, the likeliest carrier of an injected secret.
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
  // The codec refuses a segment and id that disagree, and the op is never asked.
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
  // A real `McpServer` checks that the SDK accepts the metadata and the mandatory `list` field.
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
