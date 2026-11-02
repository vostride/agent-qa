import type { Action } from './index'
import { z } from 'zod'

const refSchema = z.string().min(1)
const pointSchema = z.looseObject({ x: z.number(), y: z.number() })
const coordSpaceSchema = z.enum(['viewport', 'content', 'screen'])
const directionSchema = z.enum(['up', 'down', 'left', 'right'])
const desiredStateSchema = z.enum(['checked', 'unchecked', 'selected', 'unselected'])
const assertValueOpSchema = z.enum([
  'isNull',
  'isDefined',
  'equals',
  'notEquals',
  'gt',
  'lt',
  'contains',
])

const tabSelectorSchema = z
  .looseObject({
    index: z.number().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.index === undefined && value.title === undefined && value.url === undefined) {
      ctx.addIssue({ code: 'custom', message: 'requires at least one of index, title, or url' })
    }
  })

const fillSchema = z.looseObject({
  type: z.literal('fill'),
  ref: refSchema,
  text: z.string(),
  clearMode: z.enum(['replace', 'append']),
  submit: z.boolean(),
})

const navigateSchema = z.discriminatedUnion('to', [
  z.looseObject({ type: z.literal('navigate'), to: z.literal('url'), url: z.string() }),
  z.looseObject({ type: z.literal('navigate'), to: z.literal('back') }),
  z.looseObject({ type: z.literal('navigate'), to: z.literal('forward') }),
  z.looseObject({ type: z.literal('navigate'), to: z.literal('reload') }),
])

const tabSchema = z.union([
  z.looseObject({ type: z.literal('tab'), action: z.literal('new'), url: z.string() }),
  z
    .looseObject({
      type: z.literal('tab'),
      action: z.literal('switch'),
      index: z.number().optional(),
      title: z.string().optional(),
      url: z.string().optional(),
    })
    .superRefine((value, ctx) => {
      if (value.index === undefined && value.title === undefined && value.url === undefined) {
        ctx.addIssue({ code: 'custom', message: 'tab switch requires index, title, or url' })
      }
    }),
])

const inspectSchema = z.discriminatedUnion('what', [
  z.looseObject({
    type: z.literal('inspect'),
    what: z.literal('console'),
    level: z.enum(['log', 'info', 'warn', 'error']).optional(),
    tab: tabSelectorSchema.optional(),
  }),
  z.looseObject({
    type: z.literal('inspect'),
    what: z.literal('network'),
    urlPattern: z.string().optional(),
    tab: tabSelectorSchema.optional(),
  }),
  z.looseObject({
    type: z.literal('inspect'),
    what: z.literal('cookies'),
    name: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('inspect'),
    what: z.literal('localStorage'),
    key: z.string().optional(),
  }),
])

const networkStateSchema = z.discriminatedUnion('mode', [
  z.looseObject({ type: z.literal('networkState'), mode: z.literal('offline') }),
  z.looseObject({
    type: z.literal('networkState'),
    mode: z.literal('throttle'),
    latencyMs: z.number(),
    downloadKbps: z.number(),
    uploadKbps: z.number(),
  }),
])

const storageStateSchema = z.discriminatedUnion('op', [
  z.looseObject({ type: z.literal('storageState'), op: z.literal('save'), name: z.string() }),
  z.looseObject({ type: z.literal('storageState'), op: z.literal('restore'), name: z.string() }),
])

const cookieSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  expires: z.number().optional(),
})

const fingersSchema = z.union([z.literal(2), z.literal(3)])

const swipeSchema = z.discriminatedUnion('mode', [
  z.looseObject({
    type: z.literal('swipe'),
    mode: z.literal('direction'),
    durationMs: z.number(),
    direction: directionSchema,
    ref: refSchema.optional(),
  }),
  z.looseObject({
    type: z.literal('swipe'),
    mode: z.literal('path'),
    durationMs: z.number(),
    from: pointSchema,
    to: pointSchema,
    coordSpace: z.enum(['viewport', 'screen']),
  }),
])

const pickerSelectSchema = z.union([
  z.looseObject({ type: z.literal('pickerSelect'), ref: refSchema, value: z.string() }),
  z.looseObject({ type: z.literal('pickerSelect'), ref: refSchema, order: z.number() }),
])

const assertValueSchema = z.union([
  z.looseObject({
    type: z.literal('assertValue'),
    source: z.enum(['url', 'storage', 'network']),
    op: assertValueOpSchema,
    expected: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('assertValue'),
    expr: z.string(),
    op: assertValueOpSchema,
    expected: z.string().optional(),
  }),
])

const extractAIFieldSchema = z.looseObject({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  description: z.string(),
  item: z.looseObject({ type: z.enum(['string', 'number', 'boolean', 'object']) }).optional(),
})

const waitForSchema = z.discriminatedUnion('on', [
  z.looseObject({
    type: z.literal('waitFor'),
    on: z.literal('text'),
    text: z.string(),
    timeoutMs: z.number(),
  }),
  z.looseObject({
    type: z.literal('waitFor'),
    on: z.literal('selector'),
    selector: z.string(),
    timeoutMs: z.number(),
  }),
  z.looseObject({
    type: z.literal('waitFor'),
    on: z.literal('gone'),
    text: z.string(),
    timeoutMs: z.number(),
  }),
])

const scrollSchema = z.discriminatedUnion('mode', [
  z.looseObject({
    type: z.literal('scroll'),
    mode: z.literal('direction'),
    direction: directionSchema,
    ref: refSchema.optional(),
    amount: z.enum(['page', 'halfPage', 'toEnd']),
    retryOpposite: z.boolean(),
  }),
  z.looseObject({
    type: z.literal('scroll'),
    mode: z.literal('untilVisible'),
    text: z.string(),
    ref: refSchema.optional(),
    direction: directionSchema,
    maxSwipes: z.number(),
    retryOpposite: z.boolean(),
  }),
])

const intentExtraSchema = z.looseObject({
  key: z.string(),
  type: z.enum(['string', 'int', 'long', 'float', 'bool']),
  value: z.string(),
})

const refTargeted = (type: Action['type']) =>
  z.looseObject({ type: z.literal(type), ref: refSchema })

export const ACTION_WIRE_SCHEMAS_BY_TYPE = {
  navigate: navigateSchema,
  waitForUrl: z.looseObject({ type: z.literal('waitForUrl'), pattern: z.string() }),
  click: z.looseObject({
    type: z.literal('click'),
    ref: refSchema,
    clickDelay: z.number().optional(),
    desiredState: desiredStateSchema.optional(),
  }),
  doubleClick: z.looseObject({
    type: z.literal('doubleClick'),
    ref: refSchema,
    relativePosition: pointSchema.optional(),
    clickDelay: z.number().optional(),
  }),
  rightClick: z.looseObject({
    type: z.literal('rightClick'),
    ref: refSchema,
    relativePosition: pointSchema.optional(),
    clickDelay: z.number().optional(),
  }),
  fill: fillSchema,
  select: z.looseObject({ type: z.literal('select'), value: z.string(), ref: refSchema }),
  hover: refTargeted('hover'),
  paste: z.looseObject({ type: z.literal('paste'), value: z.string(), ref: refSchema }),
  copy: refTargeted('copy'),
  fileUpload: z.looseObject({
    type: z.literal('fileUpload'),
    files: z.array(z.string()),
    ref: refSchema,
  }),
  tab: tabSchema,
  inspect: inspectSchema,
  route: z.looseObject({
    type: z.literal('route'),
    urlPattern: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    contentType: z.string().optional(),
  }),
  unroute: z.looseObject({ type: z.literal('unroute'), urlPattern: z.string().optional() }),
  networkState: networkStateSchema,
  storageState: storageStateSchema,
  handleDialog: z.looseObject({
    type: z.literal('handleDialog'),
    accept: z.boolean(),
    promptText: z.string().optional(),
  }),
  uniqueValue: z.looseObject({ type: z.literal('uniqueValue'), prefix: z.string() }),
  focus: refTargeted('focus'),
  setCookies: z.looseObject({ type: z.literal('setCookies'), cookies: z.array(cookieSchema) }),
  setLocalStorage: z.looseObject({
    type: z.literal('setLocalStorage'),
    entries: z.array(z.looseObject({ key: z.string(), value: z.string() })),
  }),
  tap: z.looseObject({
    type: z.literal('tap'),
    ref: refSchema,
    desiredState: desiredStateSchema.optional(),
  }),
  doubleTap: refTargeted('doubleTap'),
  multiTap: z.union([
    z.looseObject({ type: z.literal('multiTap'), fingers: fingersSchema, ref: refSchema }),
    z.looseObject({
      type: z.literal('multiTap'),
      fingers: fingersSchema,
      x: z.number(),
      y: z.number(),
      coordSpace: coordSpaceSchema,
    }),
  ]),
  tapCoordinate: z.looseObject({
    type: z.literal('tapCoordinate'),
    x: z.number(),
    y: z.number(),
    coordSpace: coordSpaceSchema,
  }),
  swipe: swipeSchema,
  longpress: z.looseObject({
    type: z.literal('longpress'),
    ref: refSchema,
    duration: z.number().optional(),
  }),
  pinch: z.union([
    z.looseObject({ type: z.literal('pinch'), scale: z.number(), ref: refSchema }),
    z.looseObject({
      type: z.literal('pinch'),
      scale: z.number(),
      x: z.number(),
      y: z.number(),
      coordSpace: coordSpaceSchema,
    }),
  ]),
  drag: z.looseObject({ type: z.literal('drag'), fromRef: refSchema, toRef: refSchema }),
  nativeSelect: z.looseObject({
    type: z.literal('nativeSelect'),
    value: z.string(),
    ref: refSchema,
  }),
  hideKeyboard: z.looseObject({ type: z.literal('hideKeyboard') }),
  setOrientation: z.looseObject({
    type: z.literal('setOrientation'),
    orientation: z.enum(['portrait', 'landscape']),
  }),
  stopApp: z.looseObject({ type: z.literal('stopApp'), bundleId: z.string() }),
  pressBack: z.looseObject({ type: z.literal('pressBack') }),
  pressHome: z.looseObject({ type: z.literal('pressHome') }),
  pressRecent: z.looseObject({ type: z.literal('pressRecent') }),
  openNotifications: z.looseObject({ type: z.literal('openNotifications') }),
  openQuickSettings: z.looseObject({ type: z.literal('openQuickSettings') }),
  intent: z.looseObject({
    type: z.literal('intent'),
    action: z.string(),
    data: z.string().optional(),
    packageName: z.string().optional(),
    extras: z.array(intentExtraSchema).optional(),
  }),
  keyevent: z.looseObject({ type: z.literal('keyevent'), keycode: z.string() }),
  pressButton: z.looseObject({
    type: z.literal('pressButton'),
    button: z.enum(['home', 'volumeUp', 'action']),
  }),
  pickerSelect: pickerSelectSchema,
  swipeFromEdge: z.looseObject({
    type: z.literal('swipeFromEdge'),
    edge: z.enum(['left', 'right', 'top', 'bottom']),
  }),
  openUniversalLink: z.looseObject({
    type: z.literal('openUniversalLink'),
    url: z.string(),
    bundleId: z.string().optional(),
  }),
  assertAI: z.looseObject({
    type: z.literal('assertAI'),
    claim: z.string(),
    mode: z.enum(['multimodal', 'visual', 'text']),
  }),
  assertValue: assertValueSchema,
  extractAI: z.looseObject({
    type: z.literal('extractAI'),
    query: z.string(),
    schema: z.array(extractAIFieldSchema),
  }),
  waitFor: waitForSchema,
  delay: z.looseObject({ type: z.literal('delay'), ms: z.number() }),
  scroll: scrollSchema,
  clearText: refTargeted('clearText'),
  reportValue: z.looseObject({ type: z.literal('reportValue'), value: z.string() }),
  openApp: z.union([
    z.looseObject({ type: z.literal('openApp'), appName: z.string() }),
    z.looseObject({ type: z.literal('openApp'), bundleId: z.string() }),
  ]),
  executeScript: z.looseObject({
    type: z.literal('executeScript'),
    command: z.string(),
    args: z.unknown().optional(),
  }),
  setVariable: z.looseObject({
    type: z.literal('setVariable'),
    name: z.string(),
    value: z.string(),
  }),
  keypress: z.looseObject({
    type: z.literal('keypress'),
    keys: z.array(z.string()),
    mode: z.enum(['press', 'down', 'up']),
    convertPlatformKeys: z.boolean().optional(),
  }),
} satisfies { [K in Action['type']]: z.ZodType }

export const actionWireSchema = z
  .looseObject({ type: z.string().min(1) })
  .superRefine((value, ctx) => {
    if (Object.prototype.hasOwnProperty.call(value, 'platform')) {
      ctx.addIssue({
        code: 'custom',
        path: ['platform'],
        message: 'platform is not allowed on an action payload',
      })
    }

    const schema = ACTION_WIRE_SCHEMAS_BY_TYPE[
      value.type as keyof typeof ACTION_WIRE_SCHEMAS_BY_TYPE
    ] as z.ZodType | undefined

    if (!Object.hasOwn(ACTION_WIRE_SCHEMAS_BY_TYPE, value.type) || schema === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: `unknown action type "${value.type}"`,
      })
      return
    }

    const result = schema.safeParse(value)
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message })
      }
    }
  })
