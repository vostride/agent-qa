import type { Page } from 'playwright-core'
import type { ScreenState, ElementInfo } from '@vostride/agent-qa-core'
import type { RefMap } from './types.js'
import { extractDom } from './dom-extractor.js'

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
  // WAI-ARIA 1.2 standalone widget roles
  'gridcell', 'scrollbar', 'separator',
  // WAI-ARIA 1.2 composite widget roles (interactive containers)
  'grid', 'menu', 'menubar', 'tree', 'treegrid',
])

const CONTENT_ROLES = new Set([
  'heading', 'cell', 'listitem', 'article', 'region', 'navigation',
  'progressbar', 'tabpanel',
])

const LINE_PATTERN = /^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/
// Playwright wraps ARIA entries in single quotes when element names contain
// colons or other characters that are ambiguous in its snapshot format.
// e.g. - 'button "Spoken Language: Any"'
const QUOTED_LINE_PATTERN = /^(\s*-\s*)'(\w+)(?:\s+"([^"]*)")?(.*)'\s*$/

export function parseAriaSnapshot(ariaTree: string): { tree: string; elements: ElementInfo[]; refs: RefMap } {
  const lines = ariaTree.split('\n')
  const elements: ElementInfo[] = []
  const refs: RefMap = {}
  const resultLines: string[] = []
  let refCounter = 0

  // Track role+name occurrences for disambiguation
  const roleNameCounts = new Map<string, number>()
  const refToKey = new Map<string, string>()

  for (const line of lines) {
    const match = line.match(LINE_PATTERN) || line.match(QUOTED_LINE_PATTERN)
    if (!match) {
      resultLines.push(line)
      continue
    }

    const [, prefix, role, name, suffix] = match
    const roleLower = role.toLowerCase()
    const shouldGetRef = INTERACTIVE_ROLES.has(roleLower) || CONTENT_ROLES.has(roleLower)

    if (!shouldGetRef) {
      resultLines.push(line)
      continue
    }

    refCounter++
    const ref = `e${refCounter}`
    const key = `${roleLower}:${name ?? ''}`

    const currentCount = roleNameCounts.get(key) ?? 0
    roleNameCounts.set(key, currentCount + 1)
    refToKey.set(ref, key)

    refs[ref] = { role: roleLower, name, nth: currentCount }

    // Parse attributes from suffix like [level=1], [checked], [disabled]
    const attributes: Record<string, string> = {}
    const attrMatches = suffix?.matchAll(/\[(\w+)(?:=([^\]]*))?\]/g)
    if (attrMatches) {
      for (const am of attrMatches) {
        attributes[am[1]] = am[2] ?? 'true'
      }
    }

    elements.push({ ref, role: roleLower, name: name ?? '', attributes })

    let enhanced = `${prefix}${role}`
    if (name) enhanced += ` "${name}"`
    enhanced += ` [ref=${ref}]`
    if (suffix?.trim()) enhanced += suffix
    resultLines.push(enhanced)
  }

  // Post-process: remove nth from refs that don't have duplicates
  for (const [ref, data] of Object.entries(refs)) {
    const key = refToKey.get(ref)!
    if ((roleNameCounts.get(key) ?? 0) <= 1) {
      delete refs[ref].nth
    }
  }

  return { tree: resultLines.join('\n'), elements, refs }
}

// Browser-context functions use (globalThis as any) to access document
// because the Node tsconfig has no DOM lib — these functions serialize and run in browser
function hideAgentQaElements() {
  const doc = (globalThis as any).document
  doc.querySelectorAll('[data-agent-qa-internal]').forEach((el: any) => {
    el.style.display = 'none'
    el.setAttribute('aria-hidden', 'true')
  })
}

function restoreAgentQaElements() {
  const doc = (globalThis as any).document
  doc.querySelectorAll('[data-agent-qa-internal]').forEach((el: any) => {
    el.style.display = ''
    el.removeAttribute('aria-hidden')
  })
}

export async function observePage(
  page: Page,
  options?: { filterSelector?: string; extractDom?: boolean },
): Promise<ScreenState> {
  const viewport = page.viewportSize()
  const locator = options?.filterSelector
    ? page.locator(options.filterSelector)
    : page.locator(':root')

  // Hide framework-injected elements from ARIA snapshot
  await page.evaluate(hideAgentQaElements)

  let ariaTree: string
  try {
    ariaTree = await locator.ariaSnapshot()
  } finally {
    // Restore framework-injected elements (always, even if snapshot fails)
    await page.evaluate(restoreAgentQaElements)
  }

  if (!ariaTree) {
    return {
      tree: '(empty)',
      elements: [],
      url: page.url(),
      timestamp: Date.now(),
      metadata: {
        coordSpace: 'viewport' as const,
        viewportWidth: viewport?.width ?? 0,
        viewportHeight: viewport?.height ?? 0,
        refMap: {},
      },
    }
  }

  const { tree, elements, refs } = parseAriaSnapshot(ariaTree)

  // Bulk bounding box enrichment — single page.evaluate collects all rects in one DOM call.
  // Previous approach used N sequential getByRole().boundingBox({timeout:500}) calls which
  // all timed out on complex external pages (100+ elements), reporting "0 visible elements".
  try {
    const refEntries = Object.entries(refs)
    if (refEntries.length > 0) {
      const refArgs: Array<[string, string, string | undefined, number | undefined]> = refEntries.map(
        ([ref, data]) => [ref, data.role, data.name, data.nth]
      )

      type BBoxResult = Array<[string, { x: number; y: number; width: number; height: number } | null]>
      const result = await Promise.race([
        page.evaluate((args: Array<[string, string, string | undefined, number | undefined]>) => {
          const doc = (globalThis as any).document
          const IMPLICIT_ROLES: Record<string, string> = {
            button: 'button', a: 'link', input: 'textbox', select: 'combobox',
            textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading',
            h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation',
            main: 'main', aside: 'complementary', footer: 'contentinfo',
            header: 'banner', form: 'form', table: 'table', img: 'img',
            ul: 'list', ol: 'list', li: 'listitem', dialog: 'dialog',
            details: 'group', summary: 'button', progress: 'progressbar',
            meter: 'meter', output: 'status', article: 'article',
            section: 'region', fieldset: 'group', legend: 'legend',
          }
          const INPUT_TYPE_ROLES: Record<string, string> = {
            checkbox: 'checkbox', radio: 'radio', range: 'slider',
            number: 'spinbutton', search: 'searchbox', email: 'textbox',
            tel: 'textbox', url: 'textbox', password: 'textbox',
          }

          function getAccessibleName(el: any): string {
            const label = el.getAttribute('aria-label')
            if (label) return label.trim()
            const labelledBy = el.getAttribute('aria-labelledby')
            if (labelledBy) {
              const parts = labelledBy.split(/\s+/).map((id: string) => {
                const ref = doc.getElementById(id)
                return ref ? (ref.textContent || '').trim() : ''
              }).filter(Boolean)
              if (parts.length) return parts.join(' ')
            }
            const title = el.getAttribute('title')
            if (title) return title.trim()
            const alt = el.getAttribute('alt')
            if (alt) return alt.trim()
            return (el.textContent || '').trim()
          }

          function matchesName(elName: string, targetName: string): boolean {
            return elName.toLowerCase().includes(targetName.toLowerCase())
          }

          function getImplicitRole(el: any): string | null {
            const tag = el.tagName.toLowerCase()
            if (tag === 'input') {
              const type = (el.getAttribute('type') || 'text').toLowerCase()
              return INPUT_TYPE_ROLES[type] || 'textbox'
            }
            if (tag === 'a' && el.hasAttribute('href')) return 'link'
            return IMPLICIT_ROLES[tag] || null
          }

          const results: Array<[string, { x: number; y: number; width: number; height: number } | null]> = []
          for (const [ref, role, name, nth] of args) {
            const candidates: any[] = []
            doc.querySelectorAll(`[role="${role}"]`).forEach((el: any) => candidates.push(el))
            doc.querySelectorAll('*').forEach((el: any) => {
              if (el.getAttribute('role')) return
              if (getImplicitRole(el) === role) candidates.push(el)
            })
            let matched = candidates
            if (name) {
              matched = candidates.filter((el: any) => matchesName(getAccessibleName(el), name))
            }
            const target = matched[nth ?? 0]
            if (target) {
              const rect = target.getBoundingClientRect()
              results.push([ref, {
                x: Math.round(rect.x), y: Math.round(rect.y),
                width: Math.round(rect.width), height: Math.round(rect.height),
              }])
            } else {
              results.push([ref, null])
            }
          }
          return results
        }, refArgs),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
      ]) as BBoxResult | null

      if (result) {
        for (const [ref, box] of result) {
          if (box) refs[ref].bounds = box
        }
      }
    }
  } catch {
    // Bounding box enrichment is best-effort — never block observation
  }

  let domContext: string | undefined
  if (options?.extractDom) {
    try {
      domContext = await extractDom(page)
    } catch {
      // DOM extraction is best-effort
    }
  }

  return {
    tree,
    elements,
    url: page.url(),
    timestamp: Date.now(),
    metadata: {
      coordSpace: 'viewport' as const,
      viewportWidth: viewport?.width ?? 0,
      viewportHeight: viewport?.height ?? 0,
      refMap: refs,
      ...(domContext ? { domContext } : {}),
    },
  }
}
