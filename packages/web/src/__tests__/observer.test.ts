import { describe, it, expect, vi } from 'vitest'
import { parseAriaSnapshot, enrichWebNodes, captureWebScroll } from '../observer.js'
import type { InterimNode } from '@vostride/agent-qa-runner'

describe('parseAriaSnapshot — interim node emission', () => {
  it('emits nodes in document order with role/name, no ref or tree in the result', () => {
    const ariaTree = [
      '- navigation "Main"',
      '  - link "Home"',
      '  - link "About"',
      '  - button "Login"',
    ].join('\n')

    const { nodes, nativeRefs } = parseAriaSnapshot(ariaTree)

    // navigation is a content role; 3 interactive + 1 content = 4 nodes
    expect(nodes).toHaveLength(4)
    expect(nodes.map(n => n.role)).toEqual(['navigation', 'link', 'link', 'button'])
    expect(nodes.map(n => n.name)).toEqual(['Main', 'Home', 'About', 'Login'])

    // No ref field is ever written onto a node.
    for (const node of nodes) {
      expect(node).not.toHaveProperty('ref')
    }
    // Default-mode text carries no native refs.
    expect(nativeRefs).toEqual([undefined, undefined, undefined, undefined])
  })

  it('derives parentIndex from indentation depth', () => {
    const ariaTree = [
      '- navigation "Main"',
      '  - link "Home"',
      '  - button "Login"',
    ].join('\n')

    const { nodes } = parseAriaSnapshot(ariaTree)

    expect(nodes[0].parentIndex).toBeUndefined() // top level
    expect(nodes[1].parentIndex).toBe(0) // child of navigation
    expect(nodes[2].parentIndex).toBe(0)
  })

  it('collapses skipped structural ancestors to the nearest SURVIVING ancestor', () => {
    const ariaTree = [
      '- navigation "Main"', // survives (content role) → index 0
      '  - list', // structural → skipped
      '    - listitem "Item 1"', // survives → parent should be navigation (index 0)
      '    - link "Deep"', // survives → parent should be navigation (index 0)
    ].join('\n')

    const { nodes } = parseAriaSnapshot(ariaTree)

    expect(nodes.map(n => n.role)).toEqual(['navigation', 'listitem', 'link'])
    // The intervening `list` row was skipped; children reattach to navigation.
    expect(nodes[1].parentIndex).toBe(0)
    expect(nodes[2].parentIndex).toBe(0)
  })

  it('does not emit nodes for structural roles', () => {
    const ariaTree = [
      '- group',
      '  - list',
      '    - listitem "Item 1"',
      '  - generic',
    ].join('\n')

    const { nodes } = parseAriaSnapshot(ariaTree)

    expect(nodes).toHaveLength(1)
    expect(nodes[0].role).toBe('listitem')
    expect(nodes[0].parentIndex).toBeUndefined() // no surviving ancestor
  })

  it('captures ai-mode [ref=eN] annotations into index-aligned nativeRefs, never onto the node', () => {
    const ariaTree = [
      '- button "Submit" [ref=e5]',
      '- link "Home" [ref=e12]',
      '- heading "Title" [level=1] [ref=e20]',
    ].join('\n')

    const { nodes, nativeRefs } = parseAriaSnapshot(ariaTree)

    expect(nodes).toHaveLength(3)
    expect(nativeRefs).toEqual(['e5', 'e12', 'e20'])

    // ref never leaks into attributes or the name.
    for (const node of nodes) {
      expect(node.attributes ?? {}).not.toHaveProperty('ref')
      expect(node.name ?? '').not.toContain('ref=')
    }
    // Non-ref attributes still parse.
    expect(nodes[2].attributes?.level).toBe('1')
  })

  it('keeps parsing default-mode (unannotated) fixtures — dual-format tolerance', () => {
    const ariaTree = [
      '- button "Submit"',
      '- button "Cancel" [ref=e2]',
    ].join('\n')

    const { nodes, nativeRefs } = parseAriaSnapshot(ariaTree)

    expect(nodes).toHaveLength(2)
    expect(nativeRefs).toEqual([undefined, 'e2'])
  })

  it('maps [disabled] annotations to state.enabled=false; plain rows carry no state', () => {
    const ariaTree = [
      '- button "On"',
      '- button "Off" [disabled]',
    ].join('\n')

    const { nodes } = parseAriaSnapshot(ariaTree)

    expect(nodes[0].state).toBeUndefined()
    expect(nodes[1].state).toEqual({ enabled: false })
  })

  it('parses single-quoted ARIA entries (colon in name) including ref annotations', () => {
    const ariaTree = [
      '- group:',
      '  - \'button "Spoken Language: Any" [ref=e3]\'',
      '- group:',
      '  - \'button "Date range: Today"\'',
    ].join('\n')

    const { nodes, nativeRefs } = parseAriaSnapshot(ariaTree)

    expect(nodes).toHaveLength(2)
    expect(nodes[0].name).toBe('Spoken Language: Any')
    expect(nodes[1].name).toBe('Date range: Today')
    expect(nativeRefs).toEqual(['e3', undefined])
  })

  it('extracts boolean attributes like [checked]', () => {
    const { nodes } = parseAriaSnapshot('- checkbox "Agree" [checked]')
    expect(nodes[0].attributes?.checked).toBe('true')
  })
})

describe('captureWebScroll', () => {
  it('returns exact window scroll + viewport from the page evaluate', async () => {
    const mockPage = {
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
      evaluate: vi.fn().mockResolvedValue({
        width: 1280, height: 720,
        offsetX: 40, offsetY: 200,
        contentWidth: 1280, contentHeight: 4000,
      }),
    }

    const result = await captureWebScroll(mockPage as any)

    expect(result.viewport).toEqual({ width: 1280, height: 720 })
    expect(result.scroll).toEqual({
      offsetX: 40, offsetY: 200, contentWidth: 1280, contentHeight: 4000,
    })
  })

  it('degrades to viewport size + zero scroll when evaluate fails', async () => {
    const mockPage = {
      viewportSize: vi.fn().mockReturnValue({ width: 800, height: 600 }),
      evaluate: vi.fn().mockRejectedValue(new Error('evaluate failed')),
    }

    const result = await captureWebScroll(mockPage as any)

    expect(result.viewport).toEqual({ width: 800, height: 600 })
    expect(result.scroll).toEqual({ offsetX: 0, offsetY: 0, contentWidth: 0, contentHeight: 0 })
  })
})

describe('enrichWebNodes — aria-ref locator enrichment', () => {
  function nodesFrom(): InterimNode[] {
    return [
      { role: 'button', name: 'Submit' },
      { role: 'link', name: 'Home' },
    ]
  }

  it('fills bounds/state/labels for resolvable refs via aria-ref locators', async () => {
    const locatorCalls: string[] = []
    const mockPage = {
      locator: vi.fn().mockImplementation((sel: string) => {
        locatorCalls.push(sel)
        return { elementHandle: vi.fn().mockResolvedValue({ __handle: sel }) }
      }),
      evaluate: vi.fn().mockResolvedValue([
        {
          bounds: { x: 10, y: 20, width: 100, height: 40 },
          enabled: true, focused: false, visible: true,
          testId: 'submit-btn', ariaLabel: null, placeholder: null, title: null,
        },
        {
          bounds: { x: 10, y: 80, width: 200, height: 30 },
          enabled: true, focused: true, visible: true,
          testId: null, ariaLabel: 'Go home', placeholder: null, title: 'Home',
        },
      ]),
    }

    const nodes = nodesFrom()
    await enrichWebNodes(mockPage as any, nodes, ['e5', 'e12'])

    // Resolution went through aria-ref locators.
    expect(locatorCalls).toEqual(['aria-ref=e5', 'aria-ref=e12'])

    expect(nodes[0].bounds).toEqual({ x: 10, y: 20, width: 100, height: 40 })
    expect(nodes[0].state).toMatchObject({ enabled: true, focused: false, visible: true })
    expect(nodes[0].labels).toEqual({ testId: 'submit-btn' })

    expect(nodes[1].bounds).toEqual({ x: 10, y: 80, width: 200, height: 30 })
    expect(nodes[1].state).toMatchObject({ focused: true })
    expect(nodes[1].labels).toEqual({ ariaLabel: 'Go home', title: 'Home' })
  })

  it('leaves bounds absent (honest absence) for a null boundingBox — no zero geometry', async () => {
    const mockPage = {
      locator: vi.fn().mockReturnValue({
        elementHandle: vi.fn().mockResolvedValue({ __handle: true }),
      }),
      evaluate: vi.fn().mockResolvedValue([
        { bounds: null, enabled: true, focused: false, visible: false,
          testId: null, ariaLabel: null, placeholder: null, title: null },
      ]),
    }

    const nodes: InterimNode[] = [{ role: 'button', name: 'Hidden' }]
    await enrichWebNodes(mockPage as any, nodes, ['e1'])

    expect(nodes[0].bounds).toBeUndefined()
    expect(nodes[0].state).toMatchObject({ visible: false })
  })

  it('skips nodes with no native ref and never resolves a locator for them', async () => {
    const mockPage = {
      locator: vi.fn(),
      evaluate: vi.fn(),
    }

    const nodes = nodesFrom()
    await enrichWebNodes(mockPage as any, nodes, [undefined, undefined])

    expect(mockPage.locator).not.toHaveBeenCalled()
    expect(mockPage.evaluate).not.toHaveBeenCalled()
    expect(nodes[0].bounds).toBeUndefined()
  })

  it('degrades to unenriched nodes when the batched evaluate throws (never throws out)', async () => {
    const mockPage = {
      locator: vi.fn().mockReturnValue({
        elementHandle: vi.fn().mockResolvedValue({ __handle: true }),
      }),
      evaluate: vi.fn().mockRejectedValue(new Error('evaluate failed')),
    }

    const nodes: InterimNode[] = [{ role: 'button', name: 'Submit' }]
    await expect(enrichWebNodes(mockPage as any, nodes, ['e1'])).resolves.toBeUndefined()
    expect(nodes[0].bounds).toBeUndefined()
  })
})
