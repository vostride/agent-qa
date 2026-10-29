// The only `EntityCard` builder; it renders the store's status and refuses one the kind lacks.

import { EntityCardSchema, formatEntityUri, formatEntityUrl } from '@vostride/agent-qa-schema'
import type {
  EntityCard,
  EntityDescriptor,
  ForgetReceiptV1,
  QuarantineEntryState,
} from '@vostride/agent-qa-schema'

import { actionsForKind } from './actions.js'
import type { EntityCardContext } from './card-context.js'
import { projectKeyFacts } from './key-facts.js'

/** What the producer needs about ONE entity beyond its descriptor. */
export interface EntityCardRenderInput extends EntityCardContext {
  // An input, not a fetch, because the producer takes no ports.
  readonly forgetReceipt?: ForgetReceiptV1
}

// A receipt on a non-MEM card claims a status that kind does not declare, so it refuses.
export class ForgetReceiptKindError extends TypeError {
  constructor(readonly kind: string) {
    super(
      `a forget receipt describes a MEM knowledge bundle (D-19); it cannot render a ${kind} card`,
    )
    this.name = 'ForgetReceiptKindError'
  }
}

// A forget receipt wins over the store's status, which may lag behind it.
function statusFor(
  descriptor: EntityDescriptor,
  input: EntityCardRenderInput,
  // Passed in, so status and key facts come from one evaluation and cannot disagree.
  quarantineEntry: QuarantineEntryState | undefined,
): string {
  if (input.forgetReceipt === undefined) {
    return quarantineEntry === undefined ? descriptor.statusSource : 'quarantined'
  }
  if (descriptor.kind !== 'MEM') throw new ForgetReceiptKindError(descriptor.kind)
  return input.forgetReceipt.resultingBundleStatus
}

// Only an open `quarantined` window counts; expired and released windows render `active`.
function quarantineEntryFor(
  descriptor: EntityDescriptor,
  input: EntityCardRenderInput,
): QuarantineEntryState | undefined {
  if (descriptor.kind !== 'TST') return undefined
  const identity = descriptor.testIdentity
  if (identity === undefined || input.quarantine === undefined) return undefined
  return input.quarantine.find((entry) =>
    entry.state === 'quarantined'
    && entry.product === identity.product
    && entry.filePath === identity.filePath
    && entry.testName === identity.testName)
}

// The `url` key is omitted, not `undefined`, so `'url' in card` is false without a base.
function urlFor(
  descriptor: EntityDescriptor,
  input: EntityCardRenderInput,
): { url: string } | Record<string, never> {
  if (input.urlBase === undefined) return {}
  const url = formatEntityUrl({
    baseUrl: input.urlBase.baseUrl,
    workspace: input.urlBase.workspace,
    kind: descriptor.kind,
    shortId: descriptor.shortId,
    title: descriptor.title,
  })
  return url === undefined ? {} : { url }
}

// The default empty context means no dashboard configured and no receipt in hand.
export function produceEntityCard(
  descriptor: EntityDescriptor,
  input: EntityCardRenderInput = {},
): EntityCard {
  const quarantineEntry = quarantineEntryFor(descriptor, input)
  return EntityCardSchema.parse({
    kind: descriptor.kind,
    id: descriptor.shortId,
    // Recomputed from the address rather than copied off the descriptor: the URI and the
    // short-ID are two spellings of ONE address, and deriving one from the other is what
    // stops a card from ever carrying two that disagree.
    uri: formatEntityUri(descriptor.kind, descriptor.shortId),
    title: descriptor.title,
    status: statusFor(descriptor, input, quarantineEntry),
    ...urlFor(descriptor, input),
    keyFacts: projectKeyFacts({
      descriptor,
      ...(input.forgetReceipt === undefined ? {} : { forgetReceipt: input.forgetReceipt }),
      // The SAME join the status was decided by — computed once, passed as a value, so the
      // projection table stays pure over what it is handed.
      ...(quarantineEntry === undefined ? {} : { quarantineEntry }),
    }),
    actions: actionsForKind(descriptor),
  }) as EntityCard
}
