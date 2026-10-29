// One strict survivor resolves; none is absent; several are not-unique and never picked.
import { describe, expect, it } from 'vitest'

import { asRef } from '@vostride/agent-qa-schema'
import type { ElementInfo } from '@vostride/agent-qa-schema'

import { deterministicDescriptorMatcher } from '../reground.js'
import type { GroundingStrategy } from '../reground.js'
import type { GroundedLocator } from '../value.js'

function element(ref: string, role: string, name: string, parentRef?: string, text?: string): ElementInfo {
  return {
    ref: asRef(ref),
    role,
    name,
    nameNormalized: name.toLowerCase(),
    state: { enabled: true, focused: false, visible: true },
    labels: {},
    attributes: {},
    ...(parentRef !== undefined ? { hierarchy: { parentRef: asRef(parentRef) } } : {}),
    ...(text !== undefined ? { text } : {}),
  }
}

// Structural conformance to the thin GroundingStrategy seam.
const matcher: GroundingStrategy = deterministicDescriptorMatcher

describe('deterministicDescriptorMatcher.reground (one matcher, ambiguity never picks)', () => {
  it('returns the fresh ref when exactly one element matches role+nameNormalized', () => {
    const elements = [element('e1', 'button', 'Checkout'), element('e2', 'link', 'Help')]
    const locator: GroundedLocator = { role: 'button', name: 'Checkout' }

    expect(matcher.reground(locator, elements)).toEqual({ kind: 'resolved', ref: elements[0].ref })
  })

  it('returns null for a multi-candidate set with NO ordinal — ambiguity collapses to replan, never a first-pick', () => {
    const elements = [element('e1', 'button', 'Add'), element('e2', 'button', 'Add')]

    expect(matcher.reground({ role: 'button', name: 'Add' }, elements)).toEqual({
      kind: 'not-unique',
      count: 2,
    })
  })

  it('still selects by ordinal within the surviving set; an ordinal beyond the set is null', () => {
    // No ordinal: two survivors are not-unique; only stated row words single one out.
    const elements = [
      element('r1', 'listitem', '', undefined, 'Work 7 Elm Street'),
      element('e1', 'button', 'Add', 'r1'),
      element('r2', 'listitem', '', undefined, 'Home 1 Home Street'),
      element('e2', 'button', 'Add', 'r2'),
    ]

    expect(matcher.reground({ role: 'button', name: 'Add' }, elements)).toEqual({
      kind: 'not-unique',
      count: 2,
    })
    expect(matcher.reground({ role: 'button', name: 'Add', row: '1 Home Street' }, elements)).toEqual({
      kind: 'resolved',
      ref: elements[3].ref,
    })
    expect(matcher.reground({ role: 'button', name: 'Add', row: '5 Pine Road' }, elements)).toEqual({
      kind: 'absent',
    })
  })

  it('rescues benign name drift through the substring rung where an exact-only matcher returned null', () => {
    // Replay has no substring rung: a drifted name or a different number is absent.
    const elements = [element('e1', 'button', 'Save changes'), element('e2', 'link', 'Invoice 946')]

    expect(matcher.reground({ role: 'button', name: 'Save' }, elements)).toEqual({ kind: 'absent' })
    expect(matcher.reground({ role: 'link', name: 'Invoice 947' }, elements)).toEqual({ kind: 'absent' })
  })

  it('returns null when no element matches (fall through to replan)', () => {
    const elements = [element('e1', 'button', 'Checkout')]

    expect(matcher.reground({ role: 'button', name: 'Missing' }, elements)).toEqual({ kind: 'absent' })
  })
})
