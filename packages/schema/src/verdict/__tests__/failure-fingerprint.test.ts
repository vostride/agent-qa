// The D-13 failure fingerprint: one exported vocabulary, byte-stable goldens.
//
// 390's FLAK-01 windows recurrence over THESE bytes, and the cluster function groups over
// them — so the recipe is pinned as golden VALUES, not just as relations among the code's
// own outputs (the 383 lesson: closures phrased as relations among a module's own fields
// do not hold; closures anchored outside its vocabulary do). Changing the recipe later
// re-keys every accumulated fingerprint history; that cost is the reason for the pins.

import { describe, expect, it } from 'vitest'

import type { Anchor } from '../../identity/anchor'
import { exercisedAnchors } from '../../identity/exercised-anchors'
import type { StepEvidence } from '../../handoff/step-evidence'
import { asRef } from '../../primitives/ref'
import { failureFingerprint } from '../failure-fingerprint'

const EL: Anchor = { t: 'el', role: 'button', name: 'Submit', ordinal: 0 }
const PAGE: Anchor = { t: 'page', route: '/checkout' }

describe('failureFingerprint', () => {
  it('is deterministic: the same (anchors, class) yields byte-identical keys', () => {
    const first = failureFingerprint({ anchors: [EL, PAGE] }, 'flake')
    const second = failureFingerprint({ anchors: [EL, PAGE] }, 'flake')
    expect(first).toBe(second)
  })

  it('selects the first element anchor regardless of where it sits in the list', () => {
    // Equivalent selections across orderings: the element wins over the page either way.
    expect(failureFingerprint({ anchors: [PAGE, EL] }, 'flake')).toBe(
      failureFingerprint({ anchors: [EL, PAGE] }, 'flake'),
    )
  })

  it('pins the element-anchor golden bytes over normalizeAnchor output', () => {
    expect(failureFingerprint({ anchors: [EL] }, 'flake')).toBe(
      '{"name":"submit","ordinal":0,"role":"button","t":"el"}::flake',
    )
  })

  it('falls back to the first page anchor when no element anchor exists', () => {
    expect(failureFingerprint({ anchors: [PAGE] }, 'app_bug')).toBe(
      '{"route":"/checkout","t":"page"}::app_bug',
    )
  })

  it('keys anchorless failures on the normalized error signature — digit runs collapse', () => {
    const slow = failureFingerprint(
      { anchors: [], errorText: 'timeout after 30000ms' },
      'unknown',
    )
    const fast = failureFingerprint(
      { anchors: [], errorText: 'timeout after 12ms' },
      'unknown',
    )
    // The D-13 golden: two timeouts differing only in their digits share one key.
    expect(slow).toBe('{"message":"timeout after #ms","t":"error"}::unknown')
    expect(fast).toBe(slow)
  })

  it('includes the verdict class: the same anchor under two classes is two keys', () => {
    expect(failureFingerprint({ anchors: [EL] }, 'flake')).not.toBe(
      failureFingerprint({ anchors: [EL] }, 'app_bug'),
    )
  })

  it('is total: an empty input with no error text still keys deterministically', () => {
    expect(failureFingerprint({ anchors: [] }, 'unknown')).toBe(
      failureFingerprint({ anchors: [], errorText: undefined }, 'unknown'),
    )
  })
})

describe('exercisedAnchors promoted to schema', () => {
  it('walks element and page contact out of one step, pure over schema types', () => {
    const element = {
      ref: asRef('e1'),
      role: 'button',
      name: 'Submit',
      nameNormalized: 'submit',
      state: { enabled: true, focused: false, visible: true },
      labels: {},
      attributes: {},
    }
    const step: StepEvidence = {
      stepIndex: 0,
      stepText: 'click Submit',
      cacheStatus: 'miss',
      servedBrief: {
        scope: { tier: 'product', key: 'fingerprint' },
        asOfBuild: 1,
        budget: 0,
        truncation: 'none',
        channel1: [],
        channel2: [],
        channel3: [],
        briefDigest: 'digest',
      },
      subActions: [
        {
          plan: 'click Submit',
          plannedAction: { type: 'click', ref: element.ref },
          stateBefore: {
            platform: 'web',
            tree: '',
            elements: [element],
            refMap: {},
            url: '/checkout',
            timestamp: 1,
            metadata: {
              coordSpace: 'viewport',
              viewportWidth: 1280,
              viewportHeight: 720,
              scroll: { offsetX: 0, offsetY: 0, contentWidth: 1280, contentHeight: 720 },
              captureMode: 'textOnly',
            },
          },
          result: { success: false, error: 'element not interactable' },
        },
      ],
      verifierVerdict: { pass: false, reasoning: 'the click never landed' },
    }

    expect(exercisedAnchors(step)).toEqual([
      { t: 'el', role: 'button', name: 'submit', ordinal: 0 },
      { t: 'page', route: '/checkout' },
    ])
  })
})
