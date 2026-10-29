// THE entity card producer.
//
// One producer, in the function layer, and every surface's card is its output. That is not a
// tidiness claim — it is what makes the chat card, the MCP `structuredContent` and M5's UI
// *projections* rather than three renderers that agree until one of them is edited. The
// claim is testable precisely because the store layer has no vocabulary for a card at all:
// `knowledge-local` returns descriptors, and the only code in this repo that builds an
// `EntityCard` is this file.
//
// RENDER, never recompute — the discipline `knowledge.bundles.list` established for derived
// trust fields, applied to entity state. The owning store decided what an entity's status
// is; this function's job is to carry that decision into the card vocabulary and to REFUSE
// rather than repair a status the kind does not declare. `EntityCardSchema.parse` is where
// that refusal happens, so an unrecognised store state surfaces as a named contract
// failure at the seam instead of as a card that quietly reads `active`.
//
// The function stays SYNCHRONOUS and PURE. Everything it needs beyond the descriptor arrives
// as an already-read context value (see `card-context.ts`), so the two properties ENTY-02
// actually claims — two renders of unchanged state are deeply equal, and rendering never
// writes — are facts about the parameter list rather than promises about the body. An async
// producer that read configuration itself would have had a handle through which any port
// could later be reached.

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
  /**
   * The forget receipt for a forgotten `MEM` bundle.
   *
   * Supplied by whoever already holds one — the forget verb, which produced it, and later a
   * store lookup for an address whose bundle is gone. It is an INPUT rather than something
   * this module fetches, for the same reason the URL base is: the producer takes no ports.
   */
  readonly forgetReceipt?: ForgetReceiptV1
}

/**
 * A receipt was supplied for something that is not a knowledge bundle.
 *
 * A refusal rather than a silent drop. `ForgetReceiptV1.resultingBundleStatus` is drawn from
 * the `MEM` card's own status vocabulary, so a receipt attached to a run or a target
 * is not merely irrelevant, it is a claim about a status that kind does not declare — and
 * dropping it would render a card that omits the very fact the caller asked to show.
 */
export class ForgetReceiptKindError extends TypeError {
  constructor(readonly kind: string) {
    super(
      `a forget receipt describes a MEM knowledge bundle (D-19); it cannot render a ${kind} card`,
    )
    this.name = 'ForgetReceiptKindError'
  }
}

/**
 * The status the card reports (D-04: permanent address, honest status).
 *
 * When a forget receipt is in hand it WINS over the store's reported status, and that is the
 * whole of D-19's second use: the receipt is what the forgotten entity's permanent address
 * resolves to afterwards, so a descriptor still reporting `active` because some projection
 * has not caught up must not be able to contradict it. The receipt's own field is typed to
 * the `MEM` vocabulary, so this substitution can never widen what the card may say.
 */
function statusFor(
  descriptor: EntityDescriptor,
  input: EntityCardRenderInput,
  /**
   * the SUPPRESSING window this entity sits under, already joined. Passed in rather
   * than recomputed so the status and the key facts are decided by literally one evaluation —
   * a card can never say `quarantined` above facts that describe no window, or the reverse.
   *
   * The two substitutions cannot collide: a receipt describes a `MEM` bundle and a quarantine
   * window a `TST` test, so the receipt keeps its precedence unchanged (D-19's second use).
   */
  quarantineEntry: QuarantineEntryState | undefined,
): string {
  if (input.forgetReceipt === undefined) {
    return quarantineEntry === undefined ? descriptor.statusSource : 'quarantined'
  }
  if (descriptor.kind !== 'MEM') throw new ForgetReceiptKindError(descriptor.kind)
  return input.forgetReceipt.resultingBundleStatus
}

/**
 * THE join between an entity and the committed ledger, spelled once.
 *
 * Three gates, each refusing a different wrong answer:
 *
 *  - KIND. Only `TST` has a test identity; every other kind's card is untouched by the ledger.
 *  - REPORTED IDENTITY. The join key is `(product, filePath, testName)`, which the store must
 *    have REPORTED — never `machineId` (a per-run explicit id) and never the title. A descriptor
 *    that carries no identity answers `active`, which is honest: this store cannot say.
 *  - STATE. Only `quarantined` counts. An `expired` window has STOPPED suppressing and a
 *    `released` one is closed, so both
 *    are `active` tests whose history lives in `quarantine.list`. A card that showed `expired`
 *    as `quarantined` would tell a reader the failing build in front of them is licensed.
 */
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

/**
 * The dashboard link, or nothing.
 *
 * ABSENT, not null and not an empty string, whenever no dashboard base is configured — the
 * v52 default — or whenever the configured base cannot render an honest URL. The field is
 * omitted from the object entirely rather than set to `undefined`, so `'url' in card` is
 * false and a surface that iterates the card's own keys never sees it.
 */
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

/**
 * Render one descriptor as the one card shape.
 *
 * The second parameter defaults to an empty context, which is the v52 production state: no
 * dashboard configured and no receipt in hand. That default is what lets every existing
 * caller keep rendering the card it already rendered.
 */
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
