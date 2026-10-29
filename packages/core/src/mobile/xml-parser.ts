import { XMLParser } from 'fast-xml-parser'
import type { InterimNode, RefBinding } from '@vostride/agent-qa-runner'
import { isToggleElement, type ElementLabels, type ElementState } from '@vostride/agent-qa-schema'
import type { ParsedMobileSource, RefEntry } from './types.js'
import { IOS_EDITABLE_TYPES, iosAccessibleOtherRole, normalizeRole } from './role-map.js'

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

// Only interactive and content roles become nodes; containers drop and their children reparent.
function shouldEmit(role: string): boolean {
  return INTERACTIVE_ROLES.has(role) || CONTENT_ROLES.has(role)
}

// fast-xml-parser leaves attributes as strings, so a real boolean is the literal `"true"`.
function boolAttr(value: unknown): boolean {
  return value === true || value === 'true'
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

// Only emitted signals populate `state`; iOS reports a toggle's state only as its `value`.
function liftState(
  tagName: string,
  role: string,
  attrs: Record<string, any>,
  platform: 'android' | 'ios',
  bounds: { x: number; y: number; width: number; height: number } | undefined,
  viewport: { width: number; height: number } | undefined,
): Partial<ElementState> {
  const state: Partial<ElementState> = {}

  if (attrs['@_enabled'] !== undefined) {
    state.enabled = boolAttr(attrs['@_enabled'])
  }
  if (attrs['@_selected'] !== undefined) {
    state.selected = boolAttr(attrs['@_selected'])
  }

  if (platform === 'android') {
    // `checked` is only meaningful when the widget is `checkable` — otherwise typed-absent.
    if (boolAttr(attrs['@_checkable']) && attrs['@_checked'] !== undefined) {
      state.checked = boolAttr(attrs['@_checked'])
    }
    if (attrs['@_focused'] !== undefined) {
      state.focused = boolAttr(attrs['@_focused'])
    }
    // visible derivation (documented): explicit displayed=false, else bounds fully
    // outside the viewport ⇒ offscreen. Absent otherwise (builder defaults visible=true).
    if (attrs['@_displayed'] !== undefined && !boolAttr(attrs['@_displayed'])) {
      state.visible = false
    } else if (bounds && viewport && (bounds.y + bounds.height < 0 || bounds.y > viewport.height)) {
      state.visible = false
    }
  } else {
    if ((role === 'switch' || role === 'checkbox') && isToggleElement({ role })) {
      const value = attrs['@_value']
      if (value === '1') state.checked = true
      else if (value === '0') state.checked = false
    }
    if (attrs['@_visible'] !== undefined && !boolAttr(attrs['@_visible'])) {
      state.visible = false
    } else if (bounds && viewport && (bounds.y + bounds.height < 0 || bounds.y > viewport.height)) {
      state.visible = false
    }
    if (IOS_EDITABLE_TYPES.has(tagName) && state.enabled !== false) {
      state.editable = true
    }
  }

  return state
}

/** Android maps `resource-id -> labels.testId` and `content-desc -> labels.ariaLabel`
 * (empty strings stay absent). iOS carries no dedicated label attributes here. */
function liftLabels(attrs: Record<string, any>, platform: 'android' | 'ios'): ElementLabels {
  const labels: ElementLabels = {}
  if (platform === 'android') {
    const resourceId = attrs['@_resource-id']
    if (resourceId) labels.testId = String(resourceId)
    const contentDesc = attrs['@_content-desc']
    if (contentDesc) labels.ariaLabel = String(contentDesc)
  }
  return labels
}

interface WalkContext {
  platform: 'android' | 'ios'
  nodes: InterimNode[]
  viewport?: { width: number; height: number }
  screenReference?: { width: number; height: number }
}

const IOS_FULL_SCREEN_AREA_RATIO = 0.9
const IOS_PROMOTED_NAME_MAX = 120

function collectAttrs(node: any): Record<string, any> {
  const attrs: Record<string, any> = {}
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) attrs[key] = node[key]
  }
  return attrs
}

// UIKit merges an accessible element's subviews into it and exposes no child text, so its
// label is the only handle; React Native pressables without an accessibilityRole surface
// this way as XCUIElementTypeOther.
function isIosAccessibleLabelledOther(
  tagName: string,
  attrs: Record<string, any>,
  ctx: WalkContext,
): boolean {
  if (ctx.platform !== 'ios' || tagName !== 'XCUIElementTypeOther') return false
  if (!boolAttr(attrs['@_accessible'])) return false
  const label = attrs['@_label']
  if (label === undefined || label === null || String(label).trim() === '') return false
  const bounds = parseIosBounds(attrs)
  if (!bounds) return false
  if (attrs['@_visible'] !== undefined && !boolAttr(attrs['@_visible'])) return false
  // WDA reports a frame it cannot compute as (-1,-1,0,0).
  if (!(bounds.width > 0 && bounds.height > 0)) return false
  const ref = ctx.screenReference
  if (ref && ref.width > 0 && ref.height > 0) {
    const onScreen =
      bounds.x < ref.width &&
      bounds.y < ref.height &&
      bounds.x + bounds.width > 0 &&
      bounds.y + bounds.height > 0
    if (!onScreen) return false
    const area = bounds.width * bounds.height
    if (area >= IOS_FULL_SCREEN_AREA_RATIO * ref.width * ref.height) return false
  }
  return true
}

// React Native joins a pressable's subtree text into its label, which can run to paragraphs.
function capPromotedName(label: string): string {
  const chars = Array.from(label)
  if (chars.length <= IOS_PROMOTED_NAME_MAX) return label
  return chars.slice(0, IOS_PROMOTED_NAME_MAX - 1).join('') + '…'
}

function descendantCarriesLabel(node: any, label: string, ctx: WalkContext): boolean {
  for (const childKey of Object.keys(node)) {
    if (childKey.startsWith('@_') || childKey === '#text') continue
    const childVal = node[childKey]
    const children = Array.isArray(childVal) ? childVal : [childVal]
    for (const child of children) {
      if (!child || typeof child !== 'object') continue
      const attrs = collectAttrs(child)
      const childLabel = extractLabel(attrs, ctx.platform)
      if (
        childLabel !== undefined &&
        String(childLabel).trim() === label &&
        shouldEmit(normalizeRole(childKey, ctx.platform))
      ) {
        return true
      }
      if (descendantCarriesLabel(child, label, ctx)) return true
    }
  }
  return false
}

function walkNode(node: any, tagName: string, parentIndex: number | undefined, ctx: WalkContext): void {
  const attrs: Record<string, any> = {}
  // fast-xml-parser puts attributes with @_ prefix at the node level
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) {
      attrs[key] = node[key]
    }
  }

  let role = normalizeRole(tagName, ctx.platform)
  let emit = shouldEmit(role)
  let promoted = false

  if (ctx.platform === 'ios') {
    if (
      ctx.screenReference === undefined &&
      (tagName === 'XCUIElementTypeApplication' || tagName === 'XCUIElementTypeWindow')
    ) {
      const reference = parseIosBounds(attrs)
      if (reference && reference.width > 0 && reference.height > 0) {
        ctx.screenReference = { width: reference.width, height: reference.height }
      }
    }
    if (
      !emit &&
      isIosAccessibleLabelledOther(tagName, attrs, ctx) &&
      !descendantCarriesLabel(node, String(attrs['@_label']).trim(), ctx)
    ) {
      const traits = attrs['@_traits']
      role = iosAccessibleOtherRole(typeof traits === 'string' ? traits : undefined)
      emit = true
      promoted = true
    }
  }

  // The index children reparent to: this node's own index if it is emitted, else the
  // nearest surviving ancestor passed down.
  let childParentIndex = parentIndex

  if (emit) {
    const rawLabel = extractLabel(attrs, ctx.platform)
    const label = promoted && rawLabel !== undefined ? capPromotedName(String(rawLabel)) : rawLabel
    const value = extractValue(attrs, ctx.platform)

    let bounds: { x: number; y: number; width: number; height: number } | undefined
    if (ctx.platform === 'android' && attrs['@_bounds']) {
      bounds = parseAndroidBounds(attrs['@_bounds'])
    } else if (ctx.platform === 'ios') {
      bounds = parseIosBounds(attrs)
    }

    const state = liftState(tagName, role, attrs, ctx.platform, bounds, ctx.viewport)
    const labels = liftLabels(attrs, ctx.platform)

    // Retain the raw platform attribute bag (prefix stripped, values stringified).
    const attributes: Record<string, string> = {}
    for (const key of Object.keys(attrs)) {
      attributes[key.slice(2)] = String(attrs[key])
    }

    const interim: InterimNode = {
      role,
      ...(label !== undefined ? { name: label } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(parentIndex !== undefined ? { parentIndex } : {}),
      ...(bounds !== undefined ? { bounds } : {}),
      ...(Object.keys(state).length > 0 ? { state } : {}),
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      attributes,
      nativeType: tagName,
    }

    childParentIndex = ctx.nodes.length
    ctx.nodes.push(interim)
  }

  // Walk children
  for (const childKey of Object.keys(node)) {
    if (childKey.startsWith('@_') || childKey === '#text') continue
    const childVal = node[childKey]
    const children = Array.isArray(childVal) ? childVal : [childVal]
    for (const child of children) {
      if (child && typeof child === 'object') {
        walkNode(child, childKey, childParentIndex, ctx)
      }
    }
  }
}

export function parseMobileSource(
  xml: string,
  platform: 'android' | 'ios',
  viewport?: { width: number; height: number },
): ParsedMobileSource {
  // WDA writes a newline in an attribute as `&#10;`; numeric references are decoded on iOS
  // only, so a multi-line value is observed as typed (Android parsing is left as it was).
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    preserveOrder: false,
    htmlEntities: platform === 'ios',
  })

  const parsed = parser.parse(xml)

  const ctx: WalkContext = {
    platform,
    nodes: [],
    viewport,
    ...(platform === 'ios' && viewport ? { screenReference: viewport } : {}),
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
            walkNode(child, childKey, undefined, ctx)
          }
        }
      }
    }
  }

  return { nodes: ctx.nodes }
}

// Planner-ref to live-node resolution for the adapters; no position lives on the binding.
export function buildRefEntries(
  nodes: InterimNode[],
  binding: Record<string, RefBinding>,
): Record<string, RefEntry> {
  const entries: Record<string, RefEntry> = {}
  for (const [ref, { index }] of Object.entries(binding)) {
    const node = nodes[index]
    if (!node) continue
    const rawInputType = node.attributes?.['input-type']
    entries[ref] = {
      role: node.role,
      ...(node.name !== undefined ? { name: node.name } : {}),
      ...(node.bounds !== undefined ? { bounds: node.bounds } : {}),
      ...(node.nativeType !== undefined ? { nativeType: node.nativeType } : {}),
      ...(node.value !== undefined ? { value: node.value } : {}),
      ...(node.state?.editable === true ? { editable: true } : {}),
      ...(rawInputType !== undefined && /^\d+$/.test(rawInputType)
        ? { inputType: Number(rawInputType) }
        : {}),
    }
  }
  return entries
}

// An approximation: page source has no scroll offset, so offsets are 0 and size is the node extent.
export function deriveMobileScroll(
  nodes: InterimNode[],
  viewport: { width: number; height: number },
): { offsetX: number; offsetY: number; contentWidth: number; contentHeight: number } {
  let maxX = viewport.width
  let maxY = viewport.height
  let sawBounds = false
  for (const node of nodes) {
    if (!node.bounds) continue
    sawBounds = true
    maxX = Math.max(maxX, node.bounds.x + node.bounds.width)
    maxY = Math.max(maxY, node.bounds.y + node.bounds.height)
  }
  return {
    offsetX: 0,
    offsetY: 0,
    contentWidth: sawBounds ? maxX : viewport.width,
    contentHeight: sawBounds ? maxY : viewport.height,
  }
}
