// The exercised-anchors walk, promoted from the CLI's curation tail.
//
// Pure over schema types — StepEvidence in, Anchor[] out — and promoted HERE because three
// consumers now need one spelling of it: the CLI's candidate/canary emission (which
// re-exports from this module so every existing call site compiles unchanged), plan 05's
// agent-side cluster function, and 390's recurrence window. knowledge-local already treats
// the extraction as an injected pure seam (`ExtractStepAnchors`); this is that seam's one
// implementation, living where both sides of the package graph can reach it.

import type { StepEvidence } from '../handoff/step-evidence'
import { isRedispatchedHeal, type SubActionEvidence } from '../handoff/sub-action-evidence'
import type { ElementInfo } from '../screen/element-info'
import { elementOrdinal } from '../screen/element-ordinal'
import type { Anchor } from './anchor'

export interface ResolvedElementEvidence {
  subAction: SubActionEvidence
  element: ElementInfo
  ordinal: number
  locator?: string
}

export interface ClassifiedRoute {
  navigated: boolean
  route?: string
}

function quoteAttribute(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function locatorForElement(element: ElementInfo): string | undefined {
  const explicit =
    element.attributes.selector
    ?? element.attributes.cssSelector
    ?? element.attributes.xpath
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()

  const testId = element.attributes['data-testid'] ?? element.labels.testId
  if (testId !== undefined && testId !== '') {
    return `[data-testid="${quoteAttribute(testId)}"]`
  }

  const resourceId = element.attributes['resource-id']
  if (resourceId !== undefined && resourceId !== '') {
    return `[resource-id="${quoteAttribute(resourceId)}"]`
  }

  const accessibilityId = element.attributes['accessibility-id']
  if (accessibilityId !== undefined && accessibilityId !== '') {
    return `[accessibility-id="${quoteAttribute(accessibilityId)}"]`
  }

  const id = element.attributes.id
  return id === undefined || id === '' ? undefined : `[id="${quoteAttribute(id)}"]`
}

export function actionRefs(subAction: SubActionEvidence): string[] {
  const action = subAction.plannedAction
  const refs: string[] = []
  if ('ref' in action && typeof action.ref === 'string') refs.push(action.ref)
  if ('fromRef' in action && typeof action.fromRef === 'string') refs.push(action.fromRef)
  if ('toRef' in action && typeof action.toRef === 'string') refs.push(action.toRef)
  return refs
}

function resolvedActionRefs(subAction: SubActionEvidence): string[] {
  // a heal's grounding refs index the dispatch tree, not stateBefore.
  if (isRedispatchedHeal(subAction)) return actionRefs(subAction)
  const grounded = (subAction.grounding?.attempts ?? []).flatMap((attempt) =>
    attempt.outcome === 'resolved' && attempt.resolvedRef !== undefined
      ? [attempt.resolvedRef]
      : [],
  )
  return grounded.length === 0 ? actionRefs(subAction) : grounded
}

/** Shared handoff walk for evidence that resolved against the live pre-action screen. */
export function resolvedElementEvidence(step: StepEvidence): ResolvedElementEvidence[] {
  const byIdentity = new Map<string, ResolvedElementEvidence>()
  for (const subAction of step.subActions) {
    for (const ref of resolvedActionRefs(subAction)) {
      const element = subAction.stateBefore.elements.find((candidate) => candidate.ref === ref)
      if (element === undefined) continue
      const ordinal = elementOrdinal(element, subAction.stateBefore.elements)
      const identity = [
        subAction.stateBefore.platform,
        element.role,
        element.nameNormalized,
        ordinal,
      ].join('\u0000')
      if (!byIdentity.has(identity)) {
        const locator = locatorForElement(element)
        byIdentity.set(identity, {
          subAction,
          element,
          ordinal,
          ...(locator === undefined ? {} : { locator }),
        })
      }
    }
  }
  return [...byIdentity.values()]
}

export function elementAnchor(
  evidence: ResolvedElementEvidence,
): Extract<Anchor, { t: 'el' }> {
  return {
    t: 'el',
    role: evidence.element.role,
    name: evidence.element.nameNormalized,
    ordinal: evidence.ordinal,
  }
}

export function classifySubActionRoute(subAction: SubActionEvidence): ClassifiedRoute {
  const before = subAction.stateBefore.url
  const after = subAction.stateAfter?.url
  if (before !== undefined && after !== undefined && before !== after) {
    return { navigated: true, route: after }
  }
  return {
    navigated: false,
    ...(before === undefined ? {} : { route: before }),
  }
}

export function uniqueAnchors(anchors: readonly Anchor[]): Anchor[] {
  const seen = new Set<string>()
  return anchors.filter((anchor) => {
    const key = JSON.stringify(anchor)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Pin 1: typed handoff evidence currently carries element and page contact, not flow contact. */
export function exercisedAnchors(step: StepEvidence): Anchor[] {
  return uniqueAnchors([
    ...resolvedElementEvidence(step).map(elementAnchor),
    ...step.subActions.flatMap((subAction) => {
      const { route } = classifySubActionRoute(subAction)
      return route === undefined ? [] : [{ t: 'page' as const, route }]
    }),
  ])
}
