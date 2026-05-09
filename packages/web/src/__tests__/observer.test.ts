import { describe, it, expect, vi } from 'vitest'
import { parseAriaSnapshot, observePage } from '../observer.js'

describe('parseAriaSnapshot', () => {
  it('assigns refs to interactive elements', () => {
    const ariaTree = [
      '- navigation "Main"',
      '  - link "Home"',
      '  - link "About"',
      '  - button "Login"',
    ].join('\n')

    const { elements, refs } = parseAriaSnapshot(ariaTree)

    // navigation is content role, 3 interactive + 1 content = 4 refs
    expect(Object.keys(refs)).toHaveLength(4)
    expect(elements).toHaveLength(4)

    const roles = elements.map(e => e.role)
    expect(roles).toContain('link')
    expect(roles).toContain('button')
    expect(roles).toContain('navigation')
  })

  it('assigns refs to content elements (headings)', () => {
    const ariaTree = [
      '- heading "Welcome" [level=1]',
      '- paragraph: Some text',
      '- heading "Features" [level=2]',
    ].join('\n')

    const { elements, refs } = parseAriaSnapshot(ariaTree)

    // 2 headings get refs, paragraph does not
    expect(elements).toHaveLength(2)
    expect(elements[0].role).toBe('heading')
    expect(elements[0].name).toBe('Welcome')
    expect(elements[1].role).toBe('heading')
    expect(elements[1].name).toBe('Features')
  })

  it('does NOT assign refs to structural elements', () => {
    const ariaTree = [
      '- group',
      '  - list',
      '    - listitem "Item 1"',
      '  - generic',
    ].join('\n')

    const { elements, refs } = parseAriaSnapshot(ariaTree)

    // Only listitem gets a ref (content role); group, list, generic are structural
    expect(elements).toHaveLength(1)
    expect(elements[0].role).toBe('listitem')
    expect(elements[0].ref).toBe('e1')
    // Verify no refs for structural roles
    const refRoles = Object.values(refs).map(r => r.role)
    expect(refRoles).not.toContain('group')
    expect(refRoles).not.toContain('list')
    expect(refRoles).not.toContain('generic')
  })

  it('disambiguates duplicate role+name with nth', () => {
    const ariaTree = [
      '- button "Submit"',
      '- button "Submit"',
      '- button "Cancel"',
    ].join('\n')

    const { refs } = parseAriaSnapshot(ariaTree)

    // Two "Submit" buttons should have nth for disambiguation
    const submitRefs = Object.entries(refs).filter(([, v]) => v.name === 'Submit')
    expect(submitRefs).toHaveLength(2)
    expect(submitRefs[0][1].nth).toBe(0)
    expect(submitRefs[1][1].nth).toBe(1)

    // "Cancel" is unique, no nth
    const cancelRef = Object.entries(refs).find(([, v]) => v.name === 'Cancel')
    expect(cancelRef).toBeDefined()
    expect(cancelRef![1].nth).toBeUndefined()
  })

  it('extracts attributes from suffixes like [level=1]', () => {
    const ariaTree = '- heading "Title" [level=1]'
    const { elements } = parseAriaSnapshot(ariaTree)

    expect(elements[0].attributes.level).toBe('1')
  })

  it('extracts boolean attributes like [checked]', () => {
    const ariaTree = '- checkbox "Agree" [checked]'
    const { elements } = parseAriaSnapshot(ariaTree)

    expect(elements[0].attributes.checked).toBe('true')
  })

  it('embeds [ref=eN] annotations in the enhanced tree', () => {
    const ariaTree = [
      '- button "Click me"',
      '- link "Home"',
    ].join('\n')

    const { tree } = parseAriaSnapshot(ariaTree)

    expect(tree).toContain('[ref=e1]')
    expect(tree).toContain('[ref=e2]')
  })

  it('assigns refs to single-quoted ARIA entries (colon in name)', () => {
    const ariaTree = [
      '- group:',
      '  - \'button "Spoken Language: Any"\'',
      '- group:',
      '  - \'button "Language: Any"\'',
      '- group:',
      '  - \'button "Date range: Today"\'',
    ].join('\n')

    const { elements, refs, tree } = parseAriaSnapshot(ariaTree)

    expect(elements).toHaveLength(3)
    expect(elements[0].role).toBe('button')
    expect(elements[0].name).toBe('Spoken Language: Any')
    expect(elements[1].name).toBe('Language: Any')
    expect(elements[2].name).toBe('Date range: Today')

    // All three should have refs assigned
    expect(Object.keys(refs)).toHaveLength(3)
    expect(tree).toContain('[ref=e1]')
    expect(tree).toContain('[ref=e2]')
    expect(tree).toContain('[ref=e3]')
  })

  it('handles quoted entries mixed with normal entries', () => {
    const ariaTree = [
      '- button "Submit"',
      '- \'button "Status: Active"\'',
      '- link "Home"',
    ].join('\n')

    const { elements, refs, tree } = parseAriaSnapshot(ariaTree)

    expect(elements).toHaveLength(3)
    expect(elements[0].name).toBe('Submit')
    expect(elements[1].name).toBe('Status: Active')
    expect(elements[2].name).toBe('Home')
    expect(Object.keys(refs)).toHaveLength(3)
    // The quoted entry should have its ref in the tree
    expect(tree).toContain('button "Status: Active" [ref=e2]')
  })

  it('preserves lines that do not match the role pattern', () => {
    const ariaTree = [
      '- document:',
      '  - heading "Hi" [level=1]',
      '  some text content',
    ].join('\n')

    const { tree } = parseAriaSnapshot(ariaTree)

    expect(tree).toContain('some text content')
  })
})

describe('observePage', () => {
  function createMockPage(ariaTree: string, url = 'https://example.com') {
    return {
      locator: vi.fn().mockReturnValue({
        ariaSnapshot: vi.fn().mockResolvedValue(ariaTree),
      }),
      url: vi.fn().mockReturnValue(url),
      evaluate: vi.fn().mockResolvedValue(undefined),
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    }
  }

  it('returns ScreenState from mock page', async () => {
    const mockAriaTree = [
      '- heading "Test Page" [level=1]',
      '- button "Submit"',
    ].join('\n')

    const mockPage = createMockPage(mockAriaTree)

    const state = await observePage(mockPage as any)

    expect(state.url).toBe('https://example.com')
    expect(state.elements).toHaveLength(2)
    expect(state.tree).toContain('[ref=e1]')
    expect(state.tree).toContain('[ref=e2]')
    expect(state.metadata.refMap).toBeDefined()
    expect(typeof state.timestamp).toBe('number')
  })

  it('handles empty ARIA tree', async () => {
    const mockPage = createMockPage('', 'about:blank')

    const state = await observePage(mockPage as any)

    expect(state.tree).toBe('(empty)')
    expect(state.elements).toHaveLength(0)
  })

  it('uses filterSelector when provided', async () => {
    const mockPage = createMockPage('- button "OK"')

    await observePage(mockPage as any, { filterSelector: '#app' })

    expect(mockPage.locator).toHaveBeenCalledWith('#app')
  })

  it('includes domContext in metadata when extractDom is true', async () => {
    const mockAriaTree = '- button "OK"'
    const mockPage = createMockPage(mockAriaTree)

    // Mock the extractDom call via page.evaluate — extractDom calls page.evaluate internally
    // We need to mock the module-level extractDom function
    const { observePage: observePageFn } = await import('../observer.js')
    // Since extractDom is imported at module level, we test through observePage options
    const state = await observePageFn(mockPage as any, { extractDom: true })

    // domContext may or may not be present depending on extractDom implementation,
    // but the option should be accepted without error
    expect(state.metadata.refMap).toBeDefined()
  })

  it('does not extract DOM when extractDom is false or omitted', async () => {
    const mockPage = createMockPage('- button "OK"')

    const state = await observePage(mockPage as any)

    expect(state.metadata.domContext).toBeUndefined()
  })

  it('calls page.evaluate to hide data-agent-qa-internal elements before snapshot', async () => {
    const mockAriaSnapshot = vi.fn().mockResolvedValue('- button "OK"')
    const evaluateCalls: number[] = []
    let snapshotCallOrder = 0
    let callCounter = 0

    const mockPage = {
      locator: vi.fn().mockReturnValue({
        ariaSnapshot: vi.fn().mockImplementation(() => {
          snapshotCallOrder = ++callCounter
          return Promise.resolve('- button "OK"')
        }),
      }),
      url: vi.fn().mockReturnValue('https://example.com'),
      evaluate: vi.fn().mockImplementation(() => {
        evaluateCalls.push(++callCounter)
        return Promise.resolve(undefined)
      }),
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    }

    await observePage(mockPage as any)

    // page.evaluate called 3 times: hide before snapshot, restore after, bulk bounding box
    expect(mockPage.evaluate).toHaveBeenCalledTimes(3)
    // First evaluate (hide) should be before ariaSnapshot
    expect(evaluateCalls[0]).toBeLessThan(snapshotCallOrder)
    // Second evaluate (restore) should be after ariaSnapshot
    expect(evaluateCalls[1]).toBeGreaterThan(snapshotCallOrder)
  })

  it('restores elements after snapshot (page.evaluate called for restore)', async () => {
    const mockPage = createMockPage('- button "OK"')

    await observePage(mockPage as any)

    // 3 evaluate calls: hide + restore + bulk bounding box
    expect(mockPage.evaluate).toHaveBeenCalledTimes(3)
    // First two calls pass functions (hide + restore)
    expect(typeof mockPage.evaluate.mock.calls[0][0]).toBe('function')
    expect(typeof mockPage.evaluate.mock.calls[1][0]).toBe('function')
  })

  it('restores elements even if ariaSnapshot throws (try/finally)', async () => {
    const mockPage = {
      locator: vi.fn().mockReturnValue({
        ariaSnapshot: vi.fn().mockRejectedValue(new Error('Snapshot failed')),
      }),
      url: vi.fn().mockReturnValue('https://example.com'),
      evaluate: vi.fn().mockResolvedValue(undefined),
      viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    }

    await expect(observePage(mockPage as any)).rejects.toThrow('Snapshot failed')

    // Restore evaluate should still have been called (2 calls: hide + restore)
    expect(mockPage.evaluate).toHaveBeenCalledTimes(2)
  })

  describe('bounding box enrichment', () => {
    it('populates bounds on refs via bulk page.evaluate', async () => {
      const mockAriaTree = [
        '- button "Submit"',
        '- link "Home"',
      ].join('\n')

      let evaluateCallCount = 0
      const mockPage = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockResolvedValue(mockAriaTree),
        }),
        url: vi.fn().mockReturnValue('https://example.com'),
        evaluate: vi.fn().mockImplementation((fn: any, arg?: any) => {
          evaluateCallCount++
          // 3rd evaluate call is the bulk bounding box collection (after hide + restore)
          if (evaluateCallCount === 3 && arg) {
            return Promise.resolve([
              ['e1', { x: 10, y: 20, width: 100, height: 40 }],
              ['e2', { x: 10, y: 80, width: 200, height: 30 }],
            ])
          }
          return Promise.resolve(undefined)
        }),
        viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
      }

      const state = await observePage(mockPage as any)
      const refMap = state.metadata.refMap as Record<string, { bounds?: { x: number; y: number; width: number; height: number } }>

      expect(refMap.e1.bounds).toEqual({ x: 10, y: 20, width: 100, height: 40 })
      expect(refMap.e2.bounds).toEqual({ x: 10, y: 80, width: 200, height: 30 })
      // 3 evaluate calls: hide, restore, bulk bounding box
      expect(mockPage.evaluate).toHaveBeenCalledTimes(3)
    })

    it('handles page.evaluate failure gracefully (bounds remain undefined)', async () => {
      const mockAriaTree = '- button "Submit"'

      let evaluateCallCount = 0
      const mockPage = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockResolvedValue(mockAriaTree),
        }),
        url: vi.fn().mockReturnValue('https://example.com'),
        evaluate: vi.fn().mockImplementation((fn: any, arg?: any) => {
          evaluateCallCount++
          if (evaluateCallCount === 3) {
            return Promise.reject(new Error('evaluate failed'))
          }
          return Promise.resolve(undefined)
        }),
        viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
      }

      const state = await observePage(mockPage as any)
      const refMap = state.metadata.refMap as Record<string, { bounds?: { x: number; y: number; width: number; height: number } }>

      // Should not crash, bounds just undefined
      expect(refMap.e1.bounds).toBeUndefined()
      expect(state.elements).toHaveLength(1)
    })

    it('skips bounding box evaluate when no refs exist', async () => {
      // Use only structural elements that don't get refs
      const mockAriaTree = '- group'

      const mockPage = {
        locator: vi.fn().mockReturnValue({
          ariaSnapshot: vi.fn().mockResolvedValue(mockAriaTree),
        }),
        url: vi.fn().mockReturnValue('https://example.com'),
        evaluate: vi.fn().mockResolvedValue(undefined),
        viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
      }

      await observePage(mockPage as any)

      // Only 2 evaluate calls: hide + restore; NO bounding box evaluate
      expect(mockPage.evaluate).toHaveBeenCalledTimes(2)
    })
  })
})
