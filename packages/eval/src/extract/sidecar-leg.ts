import type { Action, ActionAnnotation, ElementInfo, Ref, ScreenState, SubActionEvidence } from '@vostride/agent-qa-schema'
import type {
  CassetteSidecarLeg,
  GoldAnchorDescriptor,
} from '../cassette/sidecar-leg'

export interface ProjectSidecarLegInput {
  subAction: SubActionEvidence
}

export interface ProjectSidecarLegResult {
  leg: CassetteSidecarLeg
  anchorUnresolved: boolean
}

// The §B4 value axis: every recorded Action whose scoring payload is a typed/selected string
// against a ref target, plus fill's text payload. Control metadata (wait text, urls, script
// bodies, runner mint values) is intentionally excluded — it carries no ref-targeted value.
type RefTargetedStringValueAction = Extract<Action, { ref: Ref; value: string }>
export type ScoringValueAction =
  | Extract<Action, { type: 'fill' }>
  | RefTargetedStringValueAction
export type ScoringValueActionType = ScoringValueAction['type']

type ValueProjector<T extends ScoringValueActionType> = (
  action: Extract<ScoringValueAction, { type: T }>,
) => string | undefined

// Exact keyed handler table. Adding a new ref-targeted string-value Action widens
// ScoringValueActionType and breaks this mapped type until a projector key is supplied,
// so a value arm can never fall through silently.
const VALUE_PROJECTORS: { [T in ScoringValueActionType]: ValueProjector<T> } = {
  fill: (action) => action.text,
  select: (action) => action.value,
  paste: (action) => action.value,
  nativeSelect: (action) => action.value,
  pickerSelect: (action) => action.value,
}

export const SCORING_VALUE_ACTION_TYPES: ReadonlySet<ScoringValueActionType> = new Set(
  Object.keys(VALUE_PROJECTORS) as ScoringValueActionType[],
)

function isScoringValueActionType(type: Action['type']): type is ScoringValueActionType {
  return SCORING_VALUE_ACTION_TYPES.has(type as ScoringValueActionType)
}

export function projectActionGoldValue(action: Action): string | undefined {
  if (!isScoringValueActionType(action.type)) return undefined
  const projector = VALUE_PROJECTORS[action.type] as (action: Action) => string | undefined
  return projector(action)
}

function actionRef(action: Action): string | undefined {
  return 'ref' in action && typeof action.ref === 'string' ? action.ref : undefined
}

function anchorDescriptor(
  element: ElementInfo,
  elements: readonly ElementInfo[],
): GoldAnchorDescriptor {
  let ordinal = 0
  for (const candidate of elements) {
    if (
      candidate.role !== element.role ||
      candidate.nameNormalized !== element.nameNormalized
    ) {
      continue
    }
    if (candidate.ref === element.ref) break
    ordinal += 1
  }

  return {
    role: element.role,
    nameNormalized: element.nameNormalized,
    ordinal,
    ref: element.ref,
  }
}

function equivalenceSet(
  goldElement: ElementInfo,
  elements: readonly ElementInfo[],
): readonly GoldAnchorDescriptor[] {
  const descriptors: GoldAnchorDescriptor[] = [anchorDescriptor(goldElement, elements)]
  const linkedRefs = [
    ...(goldElement.hierarchy?.parentRef === undefined
      ? []
      : [goldElement.hierarchy.parentRef]),
    ...(goldElement.hierarchy?.childRefs ?? []),
  ]
  const seen = new Set<string>([goldElement.ref])

  for (const linkedRef of linkedRefs) {
    if (seen.has(linkedRef)) continue
    const linkedElement = elements.find((element) => element.ref === linkedRef)
    if (linkedElement === undefined) continue
    seen.add(linkedRef)
    descriptors.push(anchorDescriptor(linkedElement, elements))
  }

  return descriptors
}

// Projects matcher evidence verbatim; operation aliases and gates are the matcher's policy.
export function projectSidecarLeg({
  subAction,
}: ProjectSidecarLegInput): ProjectSidecarLegResult {
  return projectActionSidecar(subAction.plannedAction, subAction.stateBefore, subAction.result.annotation)
}

/** Scoring-only projection; the recorded action and screen are never modified. */
export function projectActionSidecar(action: Action, stateBefore: ScreenState, annotation?: ActionAnnotation): ProjectSidecarLegResult {
  const ref = actionRef(action)
  const goldElement = ref === undefined
    ? undefined
    : stateBefore.elements.find((element) => element.ref === ref)
  const goldAnchor = goldElement === undefined
    ? undefined
    : anchorDescriptor(goldElement, stateBefore.elements)
  const goldValue = projectActionGoldValue(action)

  return {
    leg: {
      goldAction: action,
      opClass: action.type,
      ...(goldValue === undefined ? {} : { goldValue }),
      ...(goldAnchor === undefined ? {} : { goldAnchor }),
      equivalenceSet: goldElement === undefined
        ? []
        : equivalenceSet(goldElement, stateBefore.elements),
      ...(annotation === undefined ? {} : { annotation }),
    },
    anchorUnresolved: ref !== undefined && goldElement === undefined,
  }
}
