import { z } from 'zod'
import { asRef, type Ref, type Surface } from '@vostride/agent-qa-schema'
import type { ToolRegistry } from '../registry.js'
import type { ToolDefinition } from '../types.js'
import { NON_EXPOSED, VERB_SURFACE } from './surface-map.js'

const CURRENT_SCREEN_REF_DESCRIPTION = 'current-screen element reference (e.g. e12), never a CSS selector or label'
const ELEMENT_DESCRIPTION_SCHEMA = z.string().optional()
  .describe('Human-readable label of the target element for disambiguation/logging; omit when the ref is unambiguous; never the sole handle — always alongside the ref/coordinates.')

export const refSchema = (description: string) =>
  z.string().transform((v): Ref => asRef(v)).describe(description)

// 438 D-01, D-02, D-12: the element the planner means, sent beside the ref and checked against
// it before dispatch; `row` holds a repeated label's row words. No position field, no `near`
// and no selector-like field: `.strict()` rejects them.
export const targetSchema = z.object({
  role: z.string()
    .describe('The element\'s role as the observation shows it, e.g. button or textbox.'),
  name: z.string()
    .describe('The element\'s accessible name or visible label as the observation shows it.'),
  row: z.string().optional()
    .describe('Words from the element\'s row text: the ` text: "…"` of its list item, table row or card in the tree. Give it whenever the same label appears more than once on the screen; omit it when the label is unique.'),
}).strict()

// The stated-target sibling of a ref-bearing param. `noun` names the element it states (e.g.
// "element to click", "container to scroll within").
const targetSibling = (noun: string) =>
  targetSchema.optional()
    .describe(`The ${noun} you mean: role, name and, when its label repeats on the screen, row words. Send it with every element action alongside ref; the action is refused when the ref is clearly a different element. When you have no confident ref, send target alone and it is grounded against the current screen.`)

// A ref that is optional because a stated target alone may be grounded instead.
const optionalRef = (description: string) =>
  refSchema(description).optional()
    .describe(`${description}. Omit when you have no confident ref; target alone is then grounded.`)

type ActionMeta = Pick<ToolDefinition, 'destructive' | 'readOnly'>

function actionWithSurface(
  verb: string,
  surface: Surface,
  description: string,
  schema: z.ZodType,
  meta: ActionMeta = {},
): ToolDefinition {
  return {
    id: `${surface}_${verb}`,
    type: verb,
    surface,
    exposed: !NON_EXPOSED.has(verb),
    description,
    category: 'action',
    schema,
    ...meta,
  }
}

function action(verb: string, description: string, schema: z.ZodType, meta: ActionMeta = {}): ToolDefinition {
  const surface = VERB_SURFACE[verb]
  if (!surface) throw new Error(`No surface mapping for verb "${verb}"`)
  return actionWithSurface(verb, surface, description, schema, meta)
}

// Toggle/picker idempotency intent (D-13). Optional with NO default: absence means "no
// idempotency claim" (a plain gesture). The executor compares it against the element's
// persisted state at the dispatch seam and skips the gesture when already satisfied (Plan 08).
const desiredStateSchema = z.enum(['checked', 'unchecked', 'selected', 'unselected']).optional()
  .describe('For toggles/checkboxes/pickers — the state this tap should ensure; the executor skips the gesture when the element already persists this state. Omit for plain taps.')

export const fillSchema = z.object({
  ref: optionalRef(`Input field ${CURRENT_SCREEN_REF_DESCRIPTION}`),
  target: targetSibling('input field to fill'),
  text: z.string().describe('Text to enter into the field'),
  elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  clearMode: z.enum(['replace', 'append']).default('replace')
    .describe('replace = clear the field first (default); append = type at the cursor. Omit when replacing the current field value.'),
  submit: z.boolean().default(false)
    .describe('Press Enter after typing. Omit when the field should keep focus after typing.'),
}).strict()

export const scrollSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('direction'),
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to scroll'),
    ref: refSchema(`Element to scroll within; ${CURRENT_SCREEN_REF_DESCRIPTION}.`).optional()
      .describe(`Element to scroll within; ${CURRENT_SCREEN_REF_DESCRIPTION}. Omit when scrolling the whole page or screen, or when you have no confident ref; target alone is then grounded.`),
    target: targetSibling('container to scroll within'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    amount: z.enum(['page', 'halfPage', 'toEnd']).default('page')
      .describe('How far to scroll in the selected direction. Omit when a normal page-sized scroll is appropriate.'),
    retryOpposite: z.boolean().default(true)
      .describe('No effect in direction mode (one gesture per scroll). In untilVisible mode, allows one bounded search in the opposite direction after maxSwipes without the target or at a boundary. Omit in direction mode.'),
  }).strict(),
  z.object({
    mode: z.literal('untilVisible'),
    text: z.string().describe('Visible text or accessible name to reveal'),
    ref: refSchema(`Element or list to search within; ${CURRENT_SCREEN_REF_DESCRIPTION}.`).optional()
      .describe(`Element or list to search within; ${CURRENT_SCREEN_REF_DESCRIPTION}. Omit when searching the whole page or screen, or when you have no confident ref; target alone is then grounded.`),
    target: targetSibling('container to search within'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    direction: z.enum(['up', 'down', 'left', 'right']).default('down')
      .describe('Initial direction to search for the target. Omit when scrolling down is the natural direction.'),
    maxSwipes: z.number().int().min(1).max(20).default(10)
      .describe('Maximum scroll attempts before giving up. Omit when ten attempts is enough.'),
    retryOpposite: z.boolean().default(true)
      .describe('Reverse direction after maxSwipes without reveal. Omit when reverse search is acceptable.'),
  }).strict(),
])

export const waitForSchema = z.discriminatedUnion('on', [
  z.object({
    on: z.literal('text'),
    text: z.string().describe('Visible text to wait for'),
    timeoutMs: z.number().default(5000)
      .describe('Maximum wait time in milliseconds. Omit when the default 5000ms timeout is acceptable.'),
  }).strict(),
  z.object({
    on: z.literal('selector'),
    selector: z.string().describe('CSS selector to wait for as a condition, never an interaction target'),
    timeoutMs: z.number().default(5000)
      .describe('Maximum wait time in milliseconds. Omit when the default 5000ms timeout is acceptable.'),
  }).strict(),
  z.object({
    on: z.literal('gone'),
    text: z.string().describe('Text that must disappear'),
    timeoutMs: z.number().default(5000)
      .describe('Maximum wait time in milliseconds. Omit when the default 5000ms timeout is acceptable.'),
  }).strict(),
])

export const assertAISchema = z.object({
  claim: z.string().describe('AI-judged claim to verify against the current screen state'),
  mode: z.enum(['multimodal', 'visual', 'text']).default('multimodal')
    .describe('What the judge looks at. multimodal: the screen text, plus the screenshot when there is one. visual: the screen text and the screenshot; with no screenshot the claim cannot be judged and the step ends. text: the screen text only, never the screenshot. Omit for multimodal.'),
}).strict()

const assertValueSourceSchema = z.object({
  source: z.enum(['url', 'storage', 'network'])
    .describe('Deterministic machine-value source to assert against'),
  op: z.enum(['isNull', 'isDefined', 'equals', 'notEquals', 'gt', 'lt', 'contains'])
    .describe('Deterministic comparison operation'),
  expected: z.string().optional()
    .describe('Expected comparison value. Omit when op is isNull or isDefined.'),
}).strict()

const assertValueExprSchema = z.object({
  expr: z.string().describe('JavaScript expression whose deterministic result is asserted'),
  op: z.enum(['isNull', 'isDefined', 'equals', 'notEquals', 'gt', 'lt', 'contains'])
    .describe('Deterministic comparison operation'),
  expected: z.string().optional()
    .describe('Expected comparison value. Omit when op is isNull or isDefined.'),
}).strict()

export const assertValueSchema = z.union([assertValueSourceSchema, assertValueExprSchema])

const extractArrayItemSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object']).describe('Array item type'),
}).strict()

export const extractFieldSchema = z.object({
  name: z.string().describe('Output field name'),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']).describe('Output field value type'),
  description: z.string().describe('Natural-language description of the field to extract'),
  item: extractArrayItemSchema.optional()
    .describe('Array item type, required when type is array. Omit when type is not array.'),
}).strict().superRefine((field, ctx) => {
  if (field.type === 'array' && field.item === undefined) {
    ctx.addIssue({ code: 'custom', path: ['item'], message: 'item is required when type is array' })
  }
})

export const extractAISchema = z.object({
  query: z.string().describe('Perceptual extraction request for the current rendered state'),
  schema: z.array(extractFieldSchema).describe('Typed field-list output schema'),
}).strict()

export const openAppSchema = z.union([
  z.object({
    appName: z.string().describe('Human app name, e.g. Settings'),
  }).strict(),
  z.object({
    bundleId: z.string().describe('Exact bundle id / package name'),
  }).strict(),
])

export const reportValueSchema = z.object({
  value: z.string().describe('The answer/value to report back to the caller'),
}).strict()

const pointSchema = z.object({
  x: z.number().describe('X coordinate in pixels'),
  y: z.number().describe('Y coordinate in pixels'),
}).strict()

const tabSelectorSchema = z.object({
  index: z.number().optional().describe('0-based tab index. Omit when selecting by title or url.'),
  title: z.string().optional().describe('Substring match on page title. Omit when selecting by index or url.'),
  url: z.string().optional().describe('Substring match on page URL. Omit when selecting by index or title.'),
}).strict()

export const swipeSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('direction'),
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
    ref: refSchema(`Element to swipe within; ${CURRENT_SCREEN_REF_DESCRIPTION}.`).optional()
      .describe(`Element to swipe within; ${CURRENT_SCREEN_REF_DESCRIPTION}. Omit when swiping the whole screen, or when you have no confident ref; target alone is then grounded.`),
    target: targetSibling('container to swipe within'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    durationMs: z.number().int().min(50).max(5000).default(300)
      .describe('Swipe duration in milliseconds. Omit when the default 300ms gesture duration is acceptable.'),
  }).strict(),
  z.object({
    mode: z.literal('path'),
    from: pointSchema.describe('Start coordinate for the explicit swipe path'),
    to: pointSchema.describe('End coordinate for the explicit swipe path'),
    coordSpace: z.enum(['viewport', 'screen']).default('viewport')
      .describe('Coordinate space for the explicit path: viewport = visible area; screen = physical device screen. Omit for viewport.'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    durationMs: z.number().int().min(50).max(5000).default(300)
      .describe('Swipe duration in milliseconds. Omit when the default 300ms gesture duration is acceptable.'),
  }).strict(),
])

export const navigateSchema = z.discriminatedUnion('to', [
  z.object({
    to: z.literal('url'),
    url: z.string().describe('URL to navigate to'),
  }).strict(),
  z.object({ to: z.literal('back') }).strict(),
  z.object({ to: z.literal('forward') }).strict(),
  z.object({ to: z.literal('reload') }).strict(),
])

export const webInspectSchema = z.discriminatedUnion('what', [
  z.object({
    what: z.literal('console'),
    level: z.enum(['log', 'info', 'warn', 'error']).optional()
      .describe('Filter by log level. Omit to get all levels.'),
    tab: tabSelectorSchema.optional()
      .describe('Target a specific tab. Omit to read logs from all tabs.'),
  }).strict(),
  z.object({
    what: z.literal('network'),
    urlPattern: z.string().optional()
      .describe('Filter by URL substring match. Omit to get all requests.'),
    tab: tabSelectorSchema.optional()
      .describe('Target a specific tab. Omit to read logs from all tabs.'),
  }).strict(),
  z.object({
    what: z.literal('cookies'),
    name: z.string().optional()
      .describe('Cookie name to read. Omit to get all cookies.'),
  }).strict(),
  z.object({
    what: z.literal('localStorage'),
    key: z.string().optional()
      .describe('Storage key to read. Omit to get all entries.'),
  }).strict(),
])

export const routeSchema = z.object({
  urlPattern: z.string().describe('URL glob or substring pattern to intercept'),
  headers: z.record(z.string(), z.string()).optional()
    .describe('Header overrides to apply to mocked responses. Omit when no header override needed.'),
  body: z.string().optional()
    .describe('JSON-stringified response body. Omit for pass-through routes.'),
  contentType: z.string().optional()
    .describe('Response content type. Omit when body is absent or content type is application/json.'),
}).strict()

export const unrouteSchema = z.object({
  urlPattern: z.string().optional()
    .describe('URL pattern to stop intercepting. Omit when removing all web routes.'),
}).strict()

export const networkStateSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('offline'),
  }).strict(),
  z.object({
    mode: z.literal('throttle'),
    latencyMs: z.number().int().min(0).describe('Additional network latency in milliseconds'),
    downloadKbps: z.number().positive().describe('Download throughput limit in kilobits per second'),
    uploadKbps: z.number().positive().describe('Upload throughput limit in kilobits per second'),
  }).strict(),
])

export const storageStateSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('save'),
    name: z.string().describe('Named auth/storage-state slot to save'),
  }).strict(),
  z.object({
    op: z.literal('restore'),
    name: z.string().describe('Named auth/storage-state slot to restore'),
  }).strict(),
])

export const handleDialogSchema = z.object({
  accept: z.boolean().describe('true to accept the dialog, false to dismiss it'),
  promptText: z.string().optional()
    .describe('Text to enter into a prompt dialog. Omit when the dialog has no text input or you accept the default.'),
}).strict()

export const uniqueValueSchema = z.object({
  prefix: z.string().describe('Prefix for the generated unique test value'),
}).strict()

export const focusSchema = z.object({
  ref: optionalRef(`Element to focus; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
  target: targetSibling('element to focus'),
  elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
}).strict()

export const pressBackSchema = z.object({}).strict()
export const pressHomeSchema = z.object({}).strict()
export const pressRecentSchema = z.object({}).strict()
export const openNotificationsSchema = z.object({}).strict()
export const openQuickSettingsSchema = z.object({}).strict()

export const intentExtraSchema = z.object({
  key: z.string().describe('Android intent extra key'),
  type: z.enum(['string', 'int', 'long', 'float', 'bool'])
    .describe('Android am CLI extra type tag, e.g. --es/--ei/--ez'),
  value: z.string().describe('Stringified extra value parsed according to the type tag'),
}).strict()

export const intentSchema = z.object({
  action: z.string().describe('Android intent action, e.g. android.intent.action.VIEW'),
  data: z.string().optional()
    .describe('Data URI for the intent. Omit when the intent needs no data URI.'),
  packageName: z.string().optional()
    .describe('Target Android package name. Omit to let the system resolve the intent.'),
  extras: z.array(intentExtraSchema).optional()
    .describe('Typed Android intent extras. Omit when the intent carries no extras.'),
}).strict()

export const keyeventSchema = z.object({
  keycode: z.string().describe('Android KEYCODE_* value, e.g. KEYCODE_ENTER'),
}).strict()

export const pressButtonSchema = z.object({
  button: z.enum(['home', 'volumeUp', 'action']).describe('iOS hardware button to press'),
}).strict()

export const pickerSelectSchema = z.union([
  z.object({
    ref: optionalRef(`iOS picker wheel ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('iOS picker wheel'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    value: z.string().describe('Visible value to select'),
  }).strict(),
  z.object({
    ref: optionalRef(`iOS picker wheel ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('iOS picker wheel'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    order: z.number().int().describe('0-based wheel index'),
  }).strict(),
])

export const swipeFromEdgeSchema = z.object({
  edge: z.enum(['left', 'right', 'top', 'bottom']).describe('Screen edge to start the iOS edge swipe from'),
}).strict()

export const openUniversalLinkSchema = z.object({
  url: z.string().describe('Universal link URL to open on iOS'),
  bundleId: z.string().optional()
    .describe('Target iOS bundle id: the link opens in that app (com.apple.mobilesafari opens it in Safari). Omit it to use the configured app; with none configured, iOS routes an http(s) link to the app that claims it, and the action fails if iOS hands it to Safari from another app. A custom-scheme link needs a bundle id.'),
}).strict()

export const pinchSchema = z.union([
  z.object({
    scale: z.number().describe('Scale factor: >1 to zoom in (spread fingers), <1 to zoom out (pinch fingers)'),
    ref: optionalRef(`Element to center the pinch on; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to center the pinch on'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict(),
  z.object({
    scale: z.number().describe('Scale factor: >1 to zoom in (spread fingers), <1 to zoom out (pinch fingers)'),
    x: z.number().describe('Center X coordinate for pinch gesture'),
    y: z.number().describe('Center Y coordinate for pinch gesture'),
    coordSpace: z.enum(['viewport', 'content', 'screen'])
      .describe('Which coordinate space x/y are in: viewport = visible area; content = full scrollable page; screen = physical device screen. Read it from the [Viewport: WxH] observation header.'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict(),
])

export const multiTapSchema = z.union([
  z.object({
    fingers: z.union([z.literal(2), z.literal(3)]).describe('Number of fingers'),
    ref: optionalRef(`Element to center the tap on; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to center the tap on'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict(),
  z.object({
    fingers: z.union([z.literal(2), z.literal(3)]).describe('Number of fingers'),
    x: z.number().describe('Center X coordinate for multi-finger tap'),
    y: z.number().describe('Center Y coordinate for multi-finger tap'),
    coordSpace: z.enum(['viewport', 'content', 'screen'])
      .describe('Which coordinate space x/y are in: viewport = visible area; content = full scrollable page; screen = physical device screen. Read it from the [Viewport: WxH] observation header.'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict(),
])

export const tabSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('new'),
    url: z.string().describe('URL to open in the new tab'),
  }).strict(),
  z.object({
    action: z.literal('switch'),
    index: z.number().optional().describe('0-based tab index to switch to. Omit when selecting by title or url instead.'),
    title: z.string().optional().describe('Substring match on page title. Omit when selecting by index or url instead.'),
    url: z.string().optional().describe('Substring match on page URL. Omit when selecting by index or title instead.'),
  }).strict(),
])

const mobileFillDefinition = actionWithSurface('fill', 'mobile', 'Fill text into an input field', fillSchema, { destructive: true })
if (mobileFillDefinition.id !== 'mobile_fill') {
  throw new Error(`Unexpected mobile fill id "${mobileFillDefinition.id}"`)
}

export const ACTION_DEFINITIONS: ToolDefinition[] = [
  action('click', 'Click an element', z.object({
    ref: optionalRef(`Element to click; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to click'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    clickDelay: z.number().optional().describe('Omit when there is no requested delay. Only provide a positive value when the user explicitly asks for a delay.'),
    desiredState: desiredStateSchema,
  }).strict()),

  action('fill', 'Fill text into an input field', fillSchema, { destructive: true }),

  mobileFillDefinition,

  action('select', 'Select an option from a dropdown', z.object({
    ref: optionalRef(`Select/dropdown control ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('select/dropdown control'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    value: z.string().describe('Option value to select'),
  }).strict()),

  action('nativeSelect', 'Select a value from a native mobile picker, picker wheel, spinner, or dropdown/list control', z.object({
    ref: optionalRef(`Native picker/dropdown control ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('native picker/dropdown control'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    value: z.string().describe('Visible text/value to select'),
  }).strict()),

  action('navigate', 'Navigate to a URL, browser history entry, or reload the current page', navigateSchema, { destructive: true }),

  action('scroll', 'Scroll the page or a specific element', scrollSchema),

  action('delay', 'Pause execution for a fixed duration — use when a specific duration is requested (e.g. "wait 3 seconds"). Do NOT use for waiting on conditions (use waitFor for that).', z.object({
    ms: z.number().describe('Duration in milliseconds'),
  })),

  action('waitFor', 'Wait for text, selector presence, or text disappearance', waitForSchema, { readOnly: true }),

  action('assertAI', 'Ask AI to judge a perceptual claim about the current screen state', assertAISchema, { readOnly: true }),

  action('assertValue', 'Assert a deterministic machine-readable value without AI judgment', assertValueSchema, { readOnly: true }),

  action('extractAI', 'Extract structured perceptual data from the current screen state', extractAISchema, { readOnly: true }),

  action('openApp', 'Open an installed app by human-readable app name or exact bundle/package id', openAppSchema),

  action('reportValue', 'Report an answer or extracted value back to the caller', reportValueSchema, { readOnly: true }),

  action('keypress', 'Press one or more keyboard keys/combos in sequence, or hold/release a modifier key', z.object({
    keys: z.array(z.string()).min(1).describe('Array of keys/combos to press in sequence. Each entry may be a single key (e.g. "Enter", "Tab", "Escape") or a combo with "+" separators (e.g. "Meta+k", "Control+Shift+T"). Use "Meta" for the Cmd/Win/Super key — on non-Mac platforms it is automatically converted to "Control" when convertPlatformKeys is true. On mobile, only single special keys from the KEY_MAP work meaningfully; combos are a no-op.'),
    mode: z.enum(['press', 'down', 'up']).default('press')
      .describe('press = atomic press and release (default); down = hold without releasing for modifier combos; up = release a previously held key. Omit for a normal key press.'),
    convertPlatformKeys: z.boolean().optional().default(true).describe('When true (default), replaces "Meta" with "Control" in each key string on non-Mac platforms so that "Meta+k" works as Cmd+K on Mac and Ctrl+K on Windows/Linux. Set to false to pass keys through unchanged. No-op on mobile. Omit to keep the default platform conversion.'),
  })),

  action('hover', 'Hover over an element', z.object({
    ref: optionalRef(`Element to hover over; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to hover over'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict()),

  action('paste', 'Paste text into an element via clipboard paste event', z.object({
    ref: optionalRef(`Paste target ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('paste target'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    value: z.string().describe('Text value to paste'),
  }).strict(), { destructive: true }),

  action('focus', 'Focus an element without typing text', focusSchema, { readOnly: true }),

  action('inspect', 'Read browser console, network, cookie, or localStorage data', webInspectSchema, { readOnly: true }),

  action('route', 'Mock or intercept web network requests matching a URL pattern', routeSchema, { destructive: true }),

  action('unroute', 'Remove web network request mocks/intercepts', unrouteSchema, { destructive: true }),

  action('networkState', 'Set web network state to offline or a throttled profile', networkStateSchema, { readOnly: true }),

  action('storageState', 'Save or restore a named web auth/storage state', storageStateSchema, { destructive: true }),

  action('handleDialog', 'Accept or dismiss a native web alert/confirm/prompt dialog', handleDialogSchema, { destructive: true }),

  action('uniqueValue', 'Generate a unique test value with a stable prefix', uniqueValueSchema, { readOnly: true }),

  action('pressBack', 'Press the Android system Back button', pressBackSchema, { destructive: true }),

  action('pressHome', 'Press the Android system Home button', pressHomeSchema, { destructive: true }),

  action('pressRecent', 'Open the Android recent-apps overview', pressRecentSchema, { destructive: true }),

  action('openNotifications', 'Open the Android notification shade', openNotificationsSchema, { destructive: true }),

  action('openQuickSettings', 'Open Android quick settings', openQuickSettingsSchema, { destructive: true }),

  action('intent', 'Start an Android intent with typed action/data/package/extras fields', intentSchema, { destructive: true }),

  action('keyevent', 'Send an Android KEYCODE_* key event', keyeventSchema, { destructive: true }),

  action('pressButton', 'Press an iOS hardware button such as Home, Volume Up, or Action', pressButtonSchema, { destructive: true }),

  action('pickerSelect', 'Select a value from an iOS picker wheel by visible value or wheel index', pickerSelectSchema, { destructive: true }),

  action('swipeFromEdge', 'Perform an iOS edge swipe from the selected screen edge', swipeFromEdgeSchema, { destructive: true }),

  action('openUniversalLink', 'Open an iOS universal link, optionally scoped to a bundle id', openUniversalLinkSchema, { destructive: true }),

  action('setCookies', 'Set browser cookies', z.object({
    cookies: z.array(z.object({
      name: z.string().describe('Cookie name'),
      value: z.string().describe('Cookie value'),
      domain: z.string().optional().describe('Cookie domain. Omit to scope the cookie to the current page host.'),
      path: z.string().optional().describe("Cookie path. Omit to use the default '/' path."),
      httpOnly: z.boolean().optional().describe('HTTP only flag. Omit when the cookie may be read by client scripts.'),
      secure: z.boolean().optional().describe('Secure flag. Omit when the cookie need not be HTTPS-only.'),
      sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite attribute. Omit to use the browser default SameSite policy.'),
      expires: z.number().optional().describe('Expiry as Unix timestamp in seconds. Omit for a session cookie.'),
    })).describe('Array of cookies to set'),
  }), { destructive: true }),

  action('setLocalStorage', 'Set local storage entries', z.object({
    entries: z.array(z.object({
      key: z.string().describe('Storage key'),
      value: z.string().describe('Storage value'),
    })).describe('Array of key-value pairs to set'),
  }), { destructive: true }),

  action('tap', 'Tap an element on a mobile device', z.object({
    ref: optionalRef(`Element to tap; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to tap'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    desiredState: desiredStateSchema,
  }).strict()),

  action('swipe', 'Swipe gesture on a mobile device', swipeSchema),

  action('longpress', 'Long-press an element on a mobile device', z.object({
    ref: optionalRef(`Element to long-press; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to long-press'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    duration: z.number().optional().describe('Long-press duration in ms. Omit to use the platform default press duration.'),
  }).strict()),

  action('hideKeyboard', 'Dismiss the on-screen keyboard (mobile only, no-op on web)', z.object({})),

  action('clearText', 'Clear all text from an input field without typing new text', z.object({
    ref: optionalRef(`Input field to clear; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('input field to clear'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict()),

  action('drag', 'Drag an element to another element (reorder lists, sliders)', z.object({
    fromRef: refSchema(`Drag source ${CURRENT_SCREEN_REF_DESCRIPTION}`).optional()
      .describe(`Drag source ${CURRENT_SCREEN_REF_DESCRIPTION}. Omit when you have no confident fromRef; fromTarget alone is then grounded.`),
    toRef: refSchema(`Drop target ${CURRENT_SCREEN_REF_DESCRIPTION}`).optional()
      .describe(`Drop target ${CURRENT_SCREEN_REF_DESCRIPTION}. Omit when you have no confident toRef; toTarget alone is then grounded.`),
    fromTarget: targetSibling('drag source').describe('The drag source you mean: role, name and, when its label repeats on the screen, row words. Send it alongside fromRef; the drag is refused when fromRef is clearly a different element. When you have no confident fromRef, send fromTarget alone and it is grounded against the current screen.'),
    toTarget: targetSibling('drop target').describe('The drop target you mean: role, name and, when its label repeats on the screen, row words. Send it alongside toRef; the drag is refused when toRef is clearly a different element. When you have no confident toRef, send toTarget alone and it is grounded against the current screen.'),
    fromDescription: z.string().optional()
      .describe('Human-readable label of the drag source. Omit when fromRef is unambiguous.'),
    toDescription: z.string().optional()
      .describe('Human-readable label of the drop target. Omit when toRef is unambiguous.'),
  }).strict()),

  action('doubleTap', 'Double-tap an element (text selection, zoom)', z.object({
    ref: optionalRef(`Element to double-tap; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to double-tap'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict()),

  action('setOrientation', 'Set the device orientation (mobile only)', z.object({
    orientation: z.enum(['portrait', 'landscape']).describe('Device orientation'),
  })),

  action('pinch', 'Pinch zoom gesture on a mobile device (mobile only)', pinchSchema),

  action('multiTap', 'Multi-finger tap gesture on a mobile device (mobile only)', multiTapSchema),

  action('tapCoordinate', 'Tap at specific pixel coordinates — use when target element has no ref in accessibility tree', z.object({
    x: z.number().describe('X coordinate in pixels'),
    y: z.number().describe('Y coordinate in pixels'),
    coordSpace: z.enum(['viewport', 'content', 'screen'])
      .describe('Which coordinate space x/y are in: viewport = visible area; content = full scrollable page; screen = physical device screen. Read it from the [Viewport: WxH] observation header.'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict()),

  action('setVariable', 'Set a runtime environment variable for use in subsequent steps', z.object({
    name: z.string().describe('Variable name (will be accessible via {{env:varName}})'),
    value: z.string().describe('Variable value to store'),
  })),

  action('tab', 'Open a new browser tab or switch to an existing tab', tabSchema),

  action('doubleClick', 'Double-click an element (text selection, expand, web-only)', z.object({
    ref: optionalRef(`Element to double-click; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to double-click'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    relativePosition: z.object({
      x: z.number().describe('X offset in pixels from element top-left'),
      y: z.number().describe('Y offset in pixels from element top-left'),
    }).strict().optional().describe('Omit for normal element-center interaction. Only provide when the user explicitly asks for an offset. Do not use { x: 0, y: 0 } for a normal button double-click/right-click; top-left is often intercepted.'),
    clickDelay: z.number().optional().describe('Omit when there is no requested delay. Only provide a positive value when the user explicitly asks for a delay.'),
  }).strict()),

  action('rightClick', 'Right-click an element to open context menu (web-only)', z.object({
    ref: optionalRef(`Element to right-click; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element to right-click'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    relativePosition: z.object({
      x: z.number().describe('X offset in pixels from element top-left'),
      y: z.number().describe('Y offset in pixels from element top-left'),
    }).strict().optional().describe('Omit for normal element-center interaction. Only provide when the user explicitly asks for an offset. Do not use { x: 0, y: 0 } for a normal button double-click/right-click; top-left is often intercepted.'),
    clickDelay: z.number().optional().describe('Omit when there is no requested delay. Only provide a positive value when the user explicitly asks for a delay.'),
  }).strict()),

  action('waitForUrl', 'Wait for the page URL to match a glob pattern (web only)', z.object({
    pattern: z.string().describe('URL glob pattern. Use "**" for substring matching (e.g., "**/dashboard**"). Plain strings WITHOUT wildcards require EXACT URL match, not substring.'),
  })),

  action('fileUpload', 'Upload one or more files to a file input element (web only)', z.object({
    ref: optionalRef(`File input ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('file input'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
    files: z.array(z.string()).min(1).describe('Paths to files — relative to the test YAML file, or absolute paths. Missing files fail the action.'),
  }).strict(), { destructive: true }),

  action('copy', 'Copy the text content of an element to the system clipboard (web only, chromium only)', z.object({
    ref: optionalRef(`Element whose text content to copy; ${CURRENT_SCREEN_REF_DESCRIPTION}`),
    target: targetSibling('element whose text content to copy'),
    elementDescription: ELEMENT_DESCRIPTION_SCHEMA,
  }).strict(), { destructive: true }),
]

export function registerAllActions(registry: ToolRegistry): void {
  for (const def of ACTION_DEFINITIONS) {
    registry.register(def)
  }
}
