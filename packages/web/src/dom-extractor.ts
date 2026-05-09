import type { Page } from 'playwright-core'

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT', 'LINK', 'META',
  'TEMPLATE', 'IFRAME',
])

// Browser-context functions use (globalThis as any) to access document
// because the Node tsconfig has no DOM lib — these functions serialize and run in browser
export function extractDomTree(opts: { maxDepth: number; maxTextLen: number }): string {
  const { maxDepth, maxTextLen } = opts
  const doc = (globalThis as any).document
  const win = (globalThis as any).window
  const lines: string[] = []

  function isHidden(el: any): boolean {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
      const style = win.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return true
    }
    return false
  }

  function walk(node: any, depth: number, indent: string): void {
    if (depth > maxDepth) {
      lines.push(indent + '[... deeper content truncated]')
      return
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        const text = child.textContent.trim()
        if (text) {
          const truncated = text.length > maxTextLen
            ? text.slice(0, maxTextLen) + '...'
            : text
          lines.push(indent + truncated)
        }
        continue
      }

      if (child.nodeType !== 1) continue

      const tag = child.tagName
      if (SKIP_TAGS.has(tag)) continue
      if (isHidden(child)) continue

      const isCustom = tag.toLowerCase().includes('-')
      const annotation = child.getAttribute('aria-label')
        || child.getAttribute('role')
        || ''

      let label = tag.toLowerCase()
      if (isCustom) {
        if (!child.shadowRoot && !child.firstChild) {
          label += ' (custom element, closed shadow root)'
        } else {
          label += ' (custom element)'
        }
      }
      if (annotation) label += ` [${annotation}]`

      lines.push(indent + label)

      if (child.shadowRoot) {
        lines.push(indent + '  #shadow-root')
        walk(child.shadowRoot, depth + 1, indent + '    ')
      }

      walk(child, depth + 1, indent + '  ')
    }
  }

  walk(doc.body, 0, '')
  return lines.join('\n')
}

export interface ExtractDomOptions {
  maxDepth?: number
  maxTextLen?: number
}

export async function extractDom(
  page: Page,
  opts?: ExtractDomOptions,
): Promise<string | undefined> {
  const maxDepth = opts?.maxDepth ?? 20
  const maxTextLen = opts?.maxTextLen ?? 200

  try {
    return await page.evaluate(extractDomTree, { maxDepth, maxTextLen })
  } catch {
    return undefined
  }
}
