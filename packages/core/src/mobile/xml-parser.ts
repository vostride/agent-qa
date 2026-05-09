import { XMLParser } from 'fast-xml-parser'
import type { ElementInfo } from '../types/platform.js'
import type { MobileRefMap, ParsedMobileTree } from './types.js'
import { normalizeRole } from './role-map.js'

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'searchbox', 'slider', 'switch', 'tab', 'menuitem',
  // Additional interactive roles (matching expanded web set and mobile types)
  'spinbutton', 'option', 'menuitemradio', 'menuitemcheckbox',
  'gridcell', 'scrollbar', 'separator',
  'grid', 'menu', 'menubar', 'tree', 'treegrid', 'treeitem',
  'listbox', 'pickerwheel',
])

const CONTENT_ROLES = new Set([
  'text', 'heading', 'cell', 'listitem', 'image', 'navigation', 'alert',
  'progressbar',
])

function shouldAssignRef(role: string): boolean {
  return INTERACTIVE_ROLES.has(role) || CONTENT_ROLES.has(role)
}

function parseAndroidBounds(boundsStr: string): { x: number; y: number; width: number; height: number } | undefined {
  const match = boundsStr.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
  if (!match) return undefined
  const x1 = parseInt(match[1], 10)
  const y1 = parseInt(match[2], 10)
  const x2 = parseInt(match[3], 10)
  const y2 = parseInt(match[4], 10)
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

function parseIosBounds(attrs: Record<string, any>): { x: number; y: number; width: number; height: number } | undefined {
  const x = parseFloat(attrs['@_x'])
  const y = parseFloat(attrs['@_y'])
  const width = parseFloat(attrs['@_width'])
  const height = parseFloat(attrs['@_height'])
  if (isNaN(x) || isNaN(y) || isNaN(width) || isNaN(height)) return undefined
  return { x, y, width, height }
}

function extractLabel(attrs: Record<string, any>, platform: 'android' | 'ios'): string | undefined {
  if (platform === 'android') {
    const contentDesc = attrs['@_content-desc']
    if (contentDesc) return contentDesc
    const text = attrs['@_text']
    if (text) return text
    return undefined
  }
  // iOS
  const label = attrs['@_label']
  if (label) return label
  const name = attrs['@_name']
  if (name) return name
  const value = attrs['@_value']
  if (value) return value
  return undefined
}

function extractValue(attrs: Record<string, any>, platform: 'android' | 'ios'): string | undefined {
  const value = platform === 'android' ? attrs['@_text'] : attrs['@_value']
  if (value === undefined || value === null || value === '') return undefined
  return String(value)
}

interface WalkContext {
  platform: 'android' | 'ios'
  refCounter: number
  elements: ElementInfo[]
  refs: MobileRefMap
  lines: string[]
  roleNameCounts: Map<string, number>
  refToKey: Map<string, string>
  viewport?: { width: number; height: number }
}

function walkNode(node: any, tagName: string, depth: number, ctx: WalkContext): void {
  const attrs: Record<string, any> = {}
  // fast-xml-parser puts attributes with @_ prefix at the node level
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) {
      attrs[key] = node[key]
    }
  }

  const role = normalizeRole(tagName, ctx.platform)
  const label = extractLabel(attrs, ctx.platform)
  const value = extractValue(attrs, ctx.platform)

  let bounds: { x: number; y: number; width: number; height: number } | undefined
  if (ctx.platform === 'android' && attrs['@_bounds']) {
    bounds = parseAndroidBounds(attrs['@_bounds'])
  } else if (ctx.platform === 'ios') {
    bounds = parseIosBounds(attrs)
  }

  const isEnabled = attrs['@_enabled'] !== 'false' && attrs['@_enabled'] !== false

  // Container nodes with no label and non-interactive role are included in tree but don't get refs
  const isUnlabeledContainer = !label && !shouldAssignRef(role)
  const shouldRef = shouldAssignRef(role)

  const indent = '  '.repeat(depth)

  // Determine if element is offscreen (outside viewport bounds)
  const offscreen = bounds && ctx.viewport
    ? (bounds.y + bounds.height < 0 || bounds.y > ctx.viewport.height)
    : false

  if (shouldRef) {
    ctx.refCounter++
    const ref = `e${ctx.refCounter}`
    const key = `${role}:${label ?? ''}`

    const currentCount = ctx.roleNameCounts.get(key) ?? 0
    ctx.roleNameCounts.set(key, currentCount + 1)
    ctx.refToKey.set(ref, key)

    ctx.refs[ref] = { role, name: label, nth: currentCount, bounds, nativeType: tagName, value }

    const elementAttrs: Record<string, string> = {}
    if (!isEnabled) elementAttrs['disabled'] = 'true'
    elementAttrs.nativeType = tagName
    if (value) elementAttrs.value = value

    ctx.elements.push({ ref, role, name: label ?? '', value, attributes: elementAttrs })

    let line = `${indent}- ${role}`
    if (label) line += ` "${label}"`
    line += ` [ref=${ref}]`
    if (bounds) line += ` @(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height})`
    if (!isEnabled) line += ' [disabled]'
    if (offscreen) line += ' [offscreen]'
    ctx.lines.push(line)
  } else {
    // Include in tree for structure but no ref
    let line = `${indent}- ${role}`
    if (label) line += ` "${label}"`
    if (!isEnabled) line += ' [disabled]'
    if (offscreen) line += ' [offscreen]'
    ctx.lines.push(line)
  }

  // Walk children
  for (const childKey of Object.keys(node)) {
    if (childKey.startsWith('@_') || childKey === '#text') continue
    const childVal = node[childKey]
    const children = Array.isArray(childVal) ? childVal : [childVal]
    for (const child of children) {
      if (child && typeof child === 'object') {
        walkNode(child, childKey, depth + 1, ctx)
      }
    }
  }
}

export function parseMobileSource(
  xml: string,
  platform: 'android' | 'ios',
  viewport?: { width: number; height: number },
): ParsedMobileTree {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    preserveOrder: false,
  })

  const parsed = parser.parse(xml)

  const ctx: WalkContext = {
    platform,
    refCounter: 0,
    elements: [],
    refs: {},
    lines: [],
    roleNameCounts: new Map(),
    refToKey: new Map(),
    viewport,
  }

  // Find root element(s) to walk
  // Android: <hierarchy>...</hierarchy>
  // iOS: <AppiumAUT>...</AppiumAUT>
  const rootKeys = Object.keys(parsed).filter(k => !k.startsWith('?'))
  for (const rootKey of rootKeys) {
    const rootVal = parsed[rootKey]
    if (rootVal && typeof rootVal === 'object') {
      // Walk children of root container (hierarchy or AppiumAUT)
      for (const childKey of Object.keys(rootVal)) {
        if (childKey.startsWith('@_') || childKey === '#text') continue
        const childVal = rootVal[childKey]
        const children = Array.isArray(childVal) ? childVal : [childVal]
        for (const child of children) {
          if (child && typeof child === 'object') {
            walkNode(child, childKey, 0, ctx)
          }
        }
      }
    }
  }

  // Post-process: remove nth from refs that don't have duplicates
  for (const [ref, data] of Object.entries(ctx.refs)) {
    const key = ctx.refToKey.get(ref)!
    if ((ctx.roleNameCounts.get(key) ?? 0) <= 1) {
      delete ctx.refs[ref].nth
    }
  }

  let tree = ctx.lines.join('\n')

  // Add viewport summary so LLM can understand scroll position
  if (viewport) {
    const allBounds = Object.values(ctx.refs)
      .filter(r => r.bounds)
      .map(r => r.bounds!)

    const visible = allBounds.filter(b => b.y + b.height > 0 && b.y < viewport.height)
    const above = allBounds.filter(b => b.y + b.height <= 0)
    const below = allBounds.filter(b => b.y >= viewport.height)

    const parts = [`[Viewport: ${viewport.width}x${viewport.height}]`]
    if (above.length > 0 || below.length > 0) {
      parts.push(`[${visible.length} visible, ${above.length} scrolled above, ${below.length} below]`)
    }
    tree = parts.join(' ') + '\n' + tree
  }

  return {
    tree,
    elements: ctx.elements,
    refs: ctx.refs,
  }
}
