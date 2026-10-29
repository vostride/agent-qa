import { describe, it, expect } from 'vitest'
import { buildScreenState, screenConformanceCases, type ConformanceInput } from '@vostride/agent-qa-runner'
import { parseAriaSnapshot } from '../observer.js'

// The shared adapter conformance suite (D-09) run against the WEB walker: real
// Playwright ARIA snapshot text is parsed by parseAriaSnapshot into the interim nodes
// the builder consumes, then every case in screenConformanceCases asserts the pinned
// builder-contract invariants over those nodes. Enrichment is simulated (a subset of
// nodes given bounds) rather than run against a live browser — the cases assert
// builder invariants over the walker's nodes, not live-DOM behavior.

// An ai-mode snapshot fixture (reuses the observer.test.ts shapes): nested nav + a
// form region, each row annotated with a native [ref=eN] handle.
const WEB_SNAPSHOT = [
  '- navigation "Main" [ref=e1]',
  '  - link "Home" [ref=e2]',
  '  - link "About" [ref=e3]',
  '  - button "Login" [ref=e4]',
  '- region "Content" [ref=e5]',
  '  - textbox "Email" [ref=e6]',
  '  - textbox "Password" [ref=e7]',
  '  - button "Sign In" [ref=e8]',
].join('\n')

// Nodes that "resolved" bounds during best-effort enrichment. The remainder stay
// boundsless — the honest-absence reality the web walker produces (Pitfall #3).
const ENRICHED_INDICES = new Set([1, 3, 5, 7])

// Fixed timestamp so repeated builds are byte-identical (the determinism case builds
// the input twice and compares screenStateHash).
const FIXED_TIMESTAMP = 1_700_000_000_000

function makeWebInput(): ConformanceInput {
  const { nodes } = parseAriaSnapshot(WEB_SNAPSHOT)
  nodes.forEach((node, i) => {
    if (ENRICHED_INDICES.has(i)) {
      node.bounds = { x: i * 10, y: i * 20, width: 120, height: 32 }
    }
  })
  return {
    platform: 'web',
    nodes,
    buildInput: {
      viewport: { width: 1280, height: 720 },
      scroll: { offsetX: 0, offsetY: 240, contentWidth: 1280, contentHeight: 4000 },
      coordSpace: 'viewport',
      timestamp: FIXED_TIMESTAMP,
      url: 'https://example.com',
    },
  }
}

describe('web adapter conformance (shared cases)', () => {
  // Iterate the FULL exported case list — no cherry-picking.
  for (const conformanceCase of screenConformanceCases) {
    it(conformanceCase.name, () => {
      expect(() => conformanceCase.run(makeWebInput)).not.toThrow()
    })
  }

  // Web-specific pin beyond the shared cases: an element whose bounds enrichment could
  // not resolve appears in elements[] but gets NO refMap entry, while a bounded sibling
  // does — the web best-effort geometry reality (Pitfall #3).
  it('web best-effort geometry: boundsless element is in elements[] but absent from refMap', () => {
    const input = makeWebInput()
    const { state } = buildScreenState({ platform: input.platform, nodes: input.nodes, ...input.buildInput })

    const boundsless = state.elements.find(el => el.bounds === undefined)
    expect(boundsless).toBeDefined()
    expect(state.elements).toContain(boundsless)
    expect(Object.prototype.hasOwnProperty.call(state.refMap, boundsless!.ref)).toBe(false)

    const bounded = state.elements.find(el => el.bounds !== undefined)
    expect(bounded).toBeDefined()
    expect(state.refMap[bounded!.ref]).toBeDefined()
    expect(state.refMap[bounded!.ref].bounds).toEqual(bounded!.bounds)
  })
})
