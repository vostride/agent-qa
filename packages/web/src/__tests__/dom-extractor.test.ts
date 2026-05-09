import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractDomTree, extractDom } from '../dom-extractor.js'

function makeElement(tag: string, opts: {
  children?: any[]
  text?: string
  hidden?: boolean
  style?: Record<string, string>
  shadowRoot?: any | null
  attrs?: Record<string, string>
} = {}) {
  const el: any = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    firstChild: null,
    nextSibling: null,
    shadowRoot: opts.shadowRoot === undefined ? null : opts.shadowRoot,
    getAttribute: (name: string) => opts.attrs?.[name] ?? null,
    offsetParent: opts.hidden ? null : {},
  }

  const children: any[] = []

  if (opts.text) {
    children.push({
      nodeType: 3,
      textContent: opts.text,
      firstChild: null,
      nextSibling: null,
    })
  }

  if (opts.children) {
    children.push(...opts.children)
  }

  // Link children as a linked list via firstChild/nextSibling
  for (let i = 0; i < children.length; i++) {
    children[i].nextSibling = children[i + 1] || null
  }
  el.firstChild = children[0] || null

  return el
}

function setupDom(bodyChildren: any[], hiddenElements = new Set<any>()) {
  const body = makeElement('BODY', { children: bodyChildren })

  ;(globalThis as any).document = { body }
  ;(globalThis as any).window = {
    getComputedStyle: (el: any) => {
      if (hiddenElements.has(el)) {
        return { display: 'none', visibility: 'visible' }
      }
      return { display: 'block', visibility: 'visible' }
    },
  }
}

afterEach(() => {
  delete (globalThis as any).document
  delete (globalThis as any).window
})

describe('extractDomTree', () => {
  it('extracts simple nested elements', () => {
    const p = makeElement('p', { text: 'Hello world' })
    const div = makeElement('div', { children: [p] })
    setupDom([div])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toBe('div\n  p\n    Hello world')
  })

  it('skips script, style, svg, noscript, link, meta, template, iframe tags', () => {
    const skipTags = ['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'LINK', 'META', 'TEMPLATE', 'IFRAME']
    const children = skipTags.map(tag => makeElement(tag, { text: 'should not appear' }))
    const visible = makeElement('p', { text: 'visible' })
    children.push(visible)
    setupDom(children)

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toBe('p\n  visible')
    for (const tag of skipTags) {
      expect(result).not.toContain(tag.toLowerCase())
    }
  })

  it('skips hidden elements (display:none)', () => {
    const hidden = makeElement('div', { text: 'hidden', hidden: true })
    const visible = makeElement('div', { text: 'visible' })
    setupDom([hidden, visible], new Set([hidden]))

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toBe('div\n  visible')
    expect(result).not.toContain('hidden')
  })

  it('skips hidden elements (visibility:hidden)', () => {
    const hidden = makeElement('div', { text: 'secret', hidden: true })
    const visible = makeElement('span', { text: 'shown' })
    ;(globalThis as any).document = {
      body: makeElement('BODY', { children: [hidden, visible] }),
    }
    ;(globalThis as any).window = {
      getComputedStyle: (el: any) => {
        if (el === hidden) {
          return { display: 'block', visibility: 'hidden' }
        }
        return { display: 'block', visibility: 'visible' }
      },
    }

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toBe('span\n  shown')
  })

  it('annotates custom elements (hyphenated tag names)', () => {
    const custom = makeElement('my-component', { text: 'inside' })
    setupDom([custom])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toContain('my-component (custom element)')
    expect(result).toContain('inside')
  })

  it('pierces open shadow DOM and annotates #shadow-root', () => {
    const shadowContent = makeElement('span', { text: 'shadow text' })
    const shadowRoot: any = {
      nodeType: 11,
      firstChild: shadowContent,
      nextSibling: null,
    }
    shadowContent.nextSibling = null
    const custom = makeElement('my-widget', { shadowRoot })
    setupDom([custom])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toContain('my-widget (custom element)')
    expect(result).toContain('#shadow-root')
    expect(result).toContain('shadow text')
  })

  it('annotates closed shadow root on custom elements', () => {
    const custom = makeElement('my-closed', { shadowRoot: null })
    setupDom([custom])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toContain('my-closed (custom element, closed shadow root)')
  })

  it('does NOT annotate closed shadow root on non-custom elements', () => {
    const div = makeElement('div')
    setupDom([div])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toBe('div')
    expect(result).not.toContain('closed shadow root')
  })

  it('truncates text longer than maxTextLen', () => {
    const longText = 'a'.repeat(300)
    const p = makeElement('p', { text: longText })
    setupDom([p])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 50 })

    expect(result).toContain('a'.repeat(50) + '...')
    expect(result).not.toContain('a'.repeat(51))
  })

  it('stops at maxDepth with truncation message', () => {
    const deep = makeElement('span', { text: 'deep content' })
    const mid = makeElement('div', { children: [deep] })
    const top = makeElement('div', { children: [mid] })
    setupDom([top])

    const result = extractDomTree({ maxDepth: 2, maxTextLen: 200 })

    expect(result).toContain('[... deeper content truncated]')
    expect(result).not.toContain('deep content')
  })

  it('annotates elements with role attribute', () => {
    const nav = makeElement('div', { text: 'nav content', attrs: { role: 'navigation' } })
    setupDom([nav])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toContain('div [navigation]')
  })

  it('annotates elements with aria-label', () => {
    const btn = makeElement('button', { text: 'Click', attrs: { 'aria-label': 'Submit form' } })
    setupDom([btn])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toContain('button [Submit form]')
  })

  it('prefers aria-label over role for annotation', () => {
    const el = makeElement('div', {
      attrs: { 'aria-label': 'Main menu', role: 'navigation' },
    })
    setupDom([el])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toContain('div [Main menu]')
  })

  it('returns empty string for empty body', () => {
    setupDom([])

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toBe('')
  })

  it('ignores whitespace-only text nodes', () => {
    const whitespace: any = {
      nodeType: 3,
      textContent: '   \n  \t  ',
      firstChild: null,
      nextSibling: null,
    }
    const p = makeElement('p', { text: 'real text' })
    ;(globalThis as any).document = {
      body: makeElement('BODY', { children: [whitespace, p] }),
    }
    ;(globalThis as any).window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    }

    const result = extractDomTree({ maxDepth: 20, maxTextLen: 200 })

    expect(result).toBe('p\n  real text')
  })
})

describe('extractDom', () => {
  it('calls page.evaluate with extractDomTree and default options', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue('div\n  p\n    Hello'),
    }

    const result = await extractDom(mockPage as any)

    expect(mockPage.evaluate).toHaveBeenCalledWith(extractDomTree, { maxDepth: 20, maxTextLen: 200 })
    expect(result).toBe('div\n  p\n    Hello')
  })

  it('passes custom maxDepth and maxTextLen', async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue('div'),
    }

    await extractDom(mockPage as any, { maxDepth: 10, maxTextLen: 50 })

    expect(mockPage.evaluate).toHaveBeenCalledWith(extractDomTree, { maxDepth: 10, maxTextLen: 50 })
  })

  it('returns undefined on error (best-effort)', async () => {
    const mockPage = {
      evaluate: vi.fn().mockRejectedValue(new Error('Execution context destroyed')),
    }

    const result = await extractDom(mockPage as any)

    expect(result).toBeUndefined()
  })

  it('returns undefined on timeout', async () => {
    const mockPage = {
      evaluate: vi.fn().mockRejectedValue(new Error('Timeout 30000ms')),
    }

    const result = await extractDom(mockPage as any)

    expect(result).toBeUndefined()
  })
})
