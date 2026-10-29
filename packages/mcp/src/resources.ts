// Registered outside the generic handler, so contents and refusals are masked here (SEP-2549).

import { ResourceTemplate } from '@modelcontextprotocol/server'
import type { ReadResourceResult, ResourceMetadata } from '@modelcontextprotocol/server'
import { invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import {
  ENTITY_KINDS,
  ENTITY_URI_SEGMENTS,
  formatEntityUri,
  parseEntityUri,
} from '@vostride/agent-qa-schema'
import type { EntityKind, FunctionCaller } from '@vostride/agent-qa-schema'

import { maskJsonDocument } from './masked-result.js'

/**
 * The ONE op this surface reads through.
 *
 * A constant rather than a literal at three sites, and declared here rather than imported: the
 * function layer keeps its id constants inside its own directory and does not publish them on its
 * barrel, so the id is spelled once here.
 */
export const ENTITIES_GET_OP_ID = 'entities.get'

/** The media type entity cards are handed out as. They are JSON documents, not prose. */
export const ENTITY_RESOURCE_MIME_TYPE = 'application/json'

/** One derived template: everything `registerResource` needs for one kind. */
export interface EntityResourceTemplate {
  readonly kind: EntityKind
  readonly segment: string
  /** The registered resource name. Prefixed like the tools, so one namespace reads as one server. */
  readonly name: string
  readonly uriTemplate: string
  readonly title: string
  readonly description: string
}

function templateFor(kind: EntityKind): EntityResourceTemplate {
  const segment = ENTITY_URI_SEGMENTS[kind]
  return {
    kind,
    segment,
    name: `agent_qa_entity_${segment}`,
    uriTemplate: `agentqa://${segment}/{id}`,
    title: `agent-qa ${segment} entity`,
    // Authored prose about a KIND, not about any entity's content — the same class of string as a
    // tool's curated title, so it is not masked. Nothing interpolated here comes from storage.
    description:
      `The entity card for one ${segment} addressed by its canonical agentqa:// URI `
      + `(for example agentqa://${segment}/${kind}-001). Resolved through the entities read op.`,
  }
}

/**
 * The five templates, derived once at module load.
 *
 * Iterating `ENTITY_KINDS` and indexing `ENTITY_URI_SEGMENTS` is how `kinds.ts` builds its own
 * reverse table, so the listing ORDER here is the vocabulary's canonical order rather than an
 * accident of object-key iteration.
 */
export const ENTITY_RESOURCE_TEMPLATES: readonly EntityResourceTemplate[] =
  ENTITY_KINDS.map(templateFor)

/** The host-bound `(registry, caller)` closure over `invokeFunction`. */
export type EntityResourceInvoke = (opId: string, input: unknown) => Promise<unknown>

export interface EntityResourceReadDeps {
  readonly invoke: EntityResourceInvoke
  // Required: resource contents come from stored data that nothing else masks.
  readonly maskText: (text: string) => string
}

/** A URI the one codec does not recognise as an address. */
export class EntityResourceUriError extends Error {
  constructor(detail: string) {
    super(`${detail} is not a canonical agentqa:// entity address`)
    this.name = 'EntityResourceUriError'
  }
}

/** A refusal from the entity read, carried out with its message masked. */
export class EntityResourceReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EntityResourceReadError'
  }
}

// One handler for every kind, because the codec already read the kind from the URI.
export function createEntityResourceReadHandler(
  deps: EntityResourceReadDeps,
): (uri: URL) => Promise<ReadResourceResult> {
  return async (uri: URL): Promise<ReadResourceResult> => {
    const parsed = parseEntityUri(uri.href)
    if (parsed === undefined) {
      // The refusal is the CODEC's verdict, phrased. Nothing here re-examines the string to decide
      // WHY it failed: the codec's reasons (unknown segment, disagreeing prefix, trailing path,
      // malformed body) are its own, and re-deriving them would be the second parser by another
      // name. The echoed URI is caller-supplied text, so it is masked like everything else.
      throw new EntityResourceUriError(deps.maskText(uri.href))
    }

    let card: unknown
    try {
      // The canonical short-ID, not the raw URI. `entities.get` accepts both, and passing the
      // parsed value is what makes the parse load-bearing rather than a check that happens to run
      // before a string is forwarded untouched.
      card = await deps.invoke(ENTITIES_GET_OP_ID, { ref: parsed.shortId })
    } catch (err) {
      throw new EntityResourceReadError(
        deps.maskText(err instanceof Error ? err.message : String(err)),
      )
    }

    // Masked as a value: escaping in a serialized document hides raw secrets from the masker.
    const masked = maskJsonDocument(card, deps.maskText)
    if (masked === undefined) {
      // FAILS CLOSED, like the tool channel: a card whose masked form would not be the same kind of
      // value is withheld rather than served. The message names the condition and quotes nothing.
      throw new EntityResourceReadError(
        'This entity could not be returned: part of its card could not be masked in place, so the '
        + 'unmasked record was withheld rather than served.',
      )
    }

    return {
      contents: [
        {
          // Re-FORMATTED through the codec rather than echoed: the address a caller reads back is
          // the canonical one, so `agentqa://memory/MEM-1` answers about `MEM-001` and says so.
          uri: formatEntityUri(parsed.kind, parsed.shortId),
          mimeType: ENTITY_RESOURCE_MIME_TYPE,
          text: masked.text,
        },
      ],
    }
  }
}

/**
 * The slice of `McpServer` this module uses.
 *
 * ONE signature — the SDK's template overload, spelled with the SDK's own `ResourceMetadata` and
 * `ReadResourceResult` — so a cell can observe every registration without assembling a protocol
 * server while a real `McpServer` still satisfies it. Both halves of that depend on the types
 * matching the SDK EXACTLY: a hand-narrowed config record, or a hand-narrowed result with a
 * `readonly` contents array, makes `McpServer` unassignable here (overload resolution then fails on
 * the string overload, whose message names a mismatch that is not the real one). Measured, not
 * assumed — the SDK cell in this module's tests registers on a real server, so this interface
 * cannot drift away from the thing it stands for without a compile error.
 */
export interface EntityResourceRegistrar {
  registerResource(
    name: string,
    template: ResourceTemplate,
    config: ResourceMetadata,
    read: (uri: URL) => Promise<ReadResourceResult>,
  ): unknown
}

/** Exactly what this module needs from the host — the same record `catalog.ts` already holds. */
export interface EntityResourceDeps {
  readonly registry: FunctionRegistry
  readonly caller: FunctionCaller
  readonly maskText: (text: string) => string
}

// A composition without `entities.get` gets no templates and no error, so the connection stays up.
export function registerEntityResources(
  server: EntityResourceRegistrar,
  deps: EntityResourceDeps,
): readonly EntityResourceTemplate[] {
  const declaration = deps.registry
    .list(deps.caller)
    .find((candidate) => candidate.id === ENTITIES_GET_OP_ID)
  if (declaration === undefined) return []

  const read = createEntityResourceReadHandler({
    // The wall, bound once: every template's read crosses `invokeFunction` with this host's
    // registry and this caller, so input validation and the binding check run exactly as they do
    // for a tool call.
    invoke: (opId, input) => invokeFunction(deps.registry, opId, input, deps.caller),
    maskText: deps.maskText,
  })

  for (const template of ENTITY_RESOURCE_TEMPLATES) {
    server.registerResource(
      template.name,
      // `list: undefined` is REQUIRED to be spelled out by the SDK, and the value is the honest
      // one: enumerating every entity of a kind is a listing this surface does not offer, and the
      // SDK asks for the explicit `undefined` precisely so that absence is a decision.
      new ResourceTemplate(template.uriTemplate, { list: undefined }),
      // v2 requires the metadata argument; it is not optional the way it was in v1.
      {
        title: template.title,
        description: template.description,
        mimeType: ENTITY_RESOURCE_MIME_TYPE,
      },
      read,
    )
  }

  return ENTITY_RESOURCE_TEMPLATES
}
