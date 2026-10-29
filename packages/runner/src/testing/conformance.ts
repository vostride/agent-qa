// Framework-free shared adapter conformance spec. CRITICAL: imports NOTHING
// from any test framework — each case throws a plain Error on violation. Adapter test
// files (Plans 352-05/06/07) wrap the cases in their own it()/expect. This keeps the
// runner barrel, which ships these symbols, free of any test-framework dependency.
//
// The spec pins the shared adapter->builder contract: every adapter feeds its observed
// nodes through buildScreenState via a ConformanceInput, and these cases assert the
// resulting ScreenState obeys the pinned invariants (determinism, ref order, geometry
// rule, hierarchy, state derivations, name identity, scroll passthrough).

import {
  asRef,
  normalizeAccessibleName,
  screenStateHash,
  type Platform,
  type Ref,
} from '@vostride/agent-qa-schema'
import { buildScreenState, type BuildScreenStateInput, type InterimNode } from '../screen-builder.js'

/**
 * A single platform's observed input for the shared spec. `buildInput` is the builder
 * input minus the parts the case controls (`nodes` and `platform`).
 */
export interface ConformanceInput {
  platform: Platform
  nodes: InterimNode[]
  buildInput: Omit<BuildScreenStateInput, 'nodes' | 'platform'>
}

/**
 * One executable contract assertion. `run` receives a factory so cases that need
 * independent builds (e.g. the determinism check) can materialize the input twice.
 * Violations throw a plain Error — no assertion library.
 */
export interface ScreenConformanceCase {
  name: string
  run(make: () => ConformanceInput): void
}

function toBuildInput(input: ConformanceInput): BuildScreenStateInput {
  return { platform: input.platform, nodes: input.nodes, ...input.buildInput }
}

function refsFor(input: ConformanceInput): Ref[] {
  return input.nodes.map((_, i) => asRef(`e${i + 1}`))
}

const OPTIONAL_STATE_KEYS = ['selected', 'checked', 'editable', 'clickable'] as const

export const screenConformanceCases: ScreenConformanceCase[] = [
  {
    name: 'determinism: identical input yields screenStateHash-equal states',
    run(make) {
      const a = buildScreenState(toBuildInput(make())).state
      const b = buildScreenState(toBuildInput(make())).state
      if (screenStateHash(a) !== screenStateHash(b)) {
        throw new Error('determinism violated: screenStateHash differs for identical input')
      }
    },
  },
  {
    name: 'ref-mint order: refs are e1..eN in document order',
    run(make) {
      const input = make()
      const { state } = buildScreenState(toBuildInput(input))
      const expected = refsFor(input)
      const actual = state.elements.map(e => e.ref)
      if (actual.length !== expected.length) {
        throw new Error(`ref count mismatch: got ${actual.length}, expected ${expected.length}`)
      }
      for (let i = 0; i < expected.length; i++) {
        if (actual[i] !== expected[i]) {
          throw new Error(`ref order violated at index ${i}: ${actual[i]} !== ${expected[i]}`)
        }
      }
    },
  },
  {
    name: 'refMap geometry rule: entries carry bounds+center; boundsless nodes have no entry',
    run(make) {
      const input = make()
      const { state } = buildScreenState(toBuildInput(input))
      for (const [ref, entry] of Object.entries(state.refMap)) {
        if (entry.bounds === undefined || entry.center === undefined) {
          throw new Error(`refMap entry ${ref} missing bounds or center`)
        }
      }
      for (const element of state.elements) {
        const hasEntry = Object.prototype.hasOwnProperty.call(state.refMap, element.ref)
        if (element.bounds === undefined && hasEntry) {
          throw new Error(`boundsless element ${element.ref} must have no refMap entry`)
        }
        if (element.bounds !== undefined && !hasEntry) {
          throw new Error(`bounded element ${element.ref} missing its refMap entry`)
        }
      }
    },
  },
  {
    name: 'hierarchy: parentIndex surfaces as parentRef; childRefs invert consistently',
    run(make) {
      const input = make()
      const { state } = buildScreenState(toBuildInput(input))
      const refs = refsFor(input)
      input.nodes.forEach((node, i) => {
        const element = state.elements[i]
        const pi = node.parentIndex
        const expectedParent =
          pi !== undefined && pi >= 0 && pi < input.nodes.length ? refs[pi] : undefined
        if (element.hierarchy?.parentRef !== expectedParent) {
          throw new Error(
            `parentRef mismatch for ${element.ref}: got ${String(element.hierarchy?.parentRef)}, expected ${String(expectedParent)}`,
          )
        }
        const expectedChildren = input.nodes
          .map((n, j) => (n.parentIndex === i ? refs[j] : undefined))
          .filter((r): r is Ref => r !== undefined)
        const actualChildren = element.hierarchy?.childRefs ?? []
        if (actualChildren.length !== expectedChildren.length) {
          throw new Error(`childRefs count mismatch for ${element.ref}`)
        }
        for (const child of expectedChildren) {
          if (!actualChildren.includes(child)) {
            throw new Error(`childRefs for ${element.ref} missing ${child}`)
          }
        }
      })
    },
  },
  {
    name: 'state derivations: defaults applied; no optional state keys fabricated',
    run(make) {
      const input = make()
      const { state } = buildScreenState(toBuildInput(input))
      input.nodes.forEach((node, i) => {
        const derived = state.elements[i].state
        const signals = node.state ?? {}
        if (derived.enabled !== (signals.enabled ?? true)) {
          throw new Error(`enabled default wrong for e${i + 1}`)
        }
        if (derived.focused !== (signals.focused ?? false)) {
          throw new Error(`focused default wrong for e${i + 1}`)
        }
        if (derived.visible !== (signals.visible ?? true)) {
          throw new Error(`visible default wrong for e${i + 1}`)
        }
        for (const key of OPTIONAL_STATE_KEYS) {
          const hadSignal = signals[key] !== undefined
          const hasKey = Object.prototype.hasOwnProperty.call(derived, key)
          if (!hadSignal && hasKey) {
            throw new Error(`fabricated optional state '${key}' on e${i + 1}`)
          }
        }
      })
    },
  },
  {
    name: 'name identity: nameNormalized equals normalizeAccessibleName(name)',
    run(make) {
      const input = make()
      const { state } = buildScreenState(toBuildInput(input))
      input.nodes.forEach((node, i) => {
        const expected = normalizeAccessibleName(node.name ?? '')
        if (state.elements[i].nameNormalized !== expected) {
          throw new Error(
            `nameNormalized mismatch on e${i + 1}: '${state.elements[i].nameNormalized}' !== '${expected}'`,
          )
        }
      })
    },
  },
  {
    // Exact on web; documented best-effort on mobile. Either way the builder
    // passes the supplied scroll through metadata unchanged.
    name: 'scroll passthrough: metadata.scroll equals buildInput.scroll',
    run(make) {
      const input = make()
      const { state } = buildScreenState(toBuildInput(input))
      const got = state.metadata.scroll
      const want = input.buildInput.scroll
      if (
        got.offsetX !== want.offsetX ||
        got.offsetY !== want.offsetY ||
        got.contentWidth !== want.contentWidth ||
        got.contentHeight !== want.contentHeight
      ) {
        throw new Error(
          `scroll passthrough violated: ${JSON.stringify(got)} !== ${JSON.stringify(want)}`,
        )
      }
    },
  },
]
