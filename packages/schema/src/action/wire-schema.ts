import type { Action } from './index'
import { z } from 'zod'

const refSchema = z.string().min(1)
const pointSchema = z.object({ x: z.number(), y: z.number() }).passthrough()
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
  .object({
    index: z.number().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.index === undefined && value.title === undefined && value.url === undefined) {
      ctx.addIssue({ code: 'custom', message: 'requires at least one of index, title, or url' })
    }
  })

const fillSchema = z
  .object({
    type: z.literal('fill'),
    ref: refSchema,
    text: z.string(),
    clearMode: z.enum(['replace', 'append']),
    submit: z.boolean(),
  })
  .passthrough()

const navigateSchema = z.discriminatedUnion('to', [
  z.object({ type: z.literal('navigate'), to: z.literal('url'), url: z.string() }).passthrough(),
  z.object({ type: z.literal('navigate'), to: z.literal('back') }).passthrough(),
  z.object({ type: z.literal('navigate'), to: z.literal('forward') }).passthrough(),
  z.object({ type: z.literal('navigate'), to: z.literal('reload') }).passthrough(),
])

const tabSchema = z.union([
  z.object({ type: z.literal('tab'), action: z.literal('new'), url: z.string() }).passthrough(),
  z
    .object({
      type: z.literal('tab'),
      action: z.literal('switch'),
      index: z.number().optional(),
      title: z.string().optional(),
      url: z.string().optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      if (value.index === undefined && value.title === undefined && value.url === undefined) {
        ctx.addIssue({ code: 'custom', message: 'tab switch requires index, title, or url' })
      }
    }),
])

const inspectSchema = z.discriminatedUnion('what', [
  z
    .object({
      type: z.literal('inspect'),
      what: z.literal('console'),
      level: z.enum(['log', 'info', 'warn', 'error']).optional(),
      tab: tabSelectorSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('inspect'),
      what: z.literal('network'),
      urlPattern: z.string().optional(),
      tab: tabSelectorSchema.optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal('inspect'), what: z.literal('cookies'), name: z.string().optional() })
    .passthrough(),
  z
    .object({
      type: z.literal('inspect'),
      what: z.literal('localStorage'),
      key: z.string().optional(),
    })
    .passthrough(),
])

const networkStateSchema = z.discriminatedUnion('mode', [
  z.object({ type: z.literal('networkState'), mode: z.literal('offline') }).passthrough(),
  z
    .object({
      type: z.literal('networkState'),
      mode: z.literal('throttle'),
      latencyMs: z.number(),
      downloadKbps: z.number(),
      uploadKbps: z.number(),
    })
    .passthrough(),
])

const storageStateSchema = z.discriminatedUnion('op', [
  z.object({ type: z.literal('storageState'), op: z.literal('save'), name: z.string() }).passthrough(),
  z
    .object({ type: z.literal('storageState'), op: z.literal('restore'), name: z.string() })
    .passthrough(),
])

const cookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional(),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
    expires: z.number().optional(),
  })
  .passthrough()

const fingersSchema = z.union([z.literal(2), z.literal(3)])

const swipeSchema = z.discriminatedUnion('mode', [
  z
    .object({
      type: z.literal('swipe'),
      mode: z.literal('direction'),
      durationMs: z.number(),
      direction: directionSchema,
      ref: refSchema.optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('swipe'),
      mode: z.literal('path'),
      durationMs: z.number(),
      from: pointSchema,
      to: pointSchema,
      coordSpace: z.enum(['viewport', 'screen']),
    })
    .passthrough(),
])

const pickerSelectSchema = z.union([
  z.object({ type: z.literal('pickerSelect'), ref: refSchema, value: z.string() }).passthrough(),
  z.object({ type: z.literal('pickerSelect'), ref: refSchema, order: z.number() }).passthrough(),
])

const assertValueSchema = z.union([
  z
    .object({
      type: z.literal('assertValue'),
      source: z.enum(['url', 'storage', 'network']),
      op: assertValueOpSchema,
      expected: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('assertValue'),
      expr: z.string(),
      op: assertValueOpSchema,
      expected: z.string().optional(),
    })
    .passthrough(),
])

const extractAIFieldSchema = z
  .object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
    description: z.string(),
    item: z.object({ type: z.enum(['string', 'number', 'boolean', 'object']) }).passthrough().optional(),
  })
  .passthrough()

const waitForSchema = z.discriminatedUnion('on', [
  z
    .object({
      type: z.literal('waitFor'),
      on: z.literal('text'),
      text: z.string(),
      timeoutMs: z.number(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('waitFor'),
      on: z.literal('selector'),
      selector: z.string(),
      timeoutMs: z.number(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('waitFor'),
      on: z.literal('gone'),
      text: z.string(),
      timeoutMs: z.number(),
    })
    .passthrough(),
])

const scrollSchema = z.discriminatedUnion('mode', [
  z
    .object({
      type: z.literal('scroll'),
      mode: z.literal('direction'),
      direction: directionSchema,
      ref: refSchema.optional(),
      amount: z.enum(['page', 'halfPage', 'toEnd']),
      retryOpposite: z.boolean(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('scroll'),
      mode: z.literal('untilVisible'),
      text: z.string(),
      ref: refSchema.optional(),
      direction: directionSchema,
      maxSwipes: z.number(),
      retryOpposite: z.boolean(),
    })
    .passthrough(),
])

const intentExtraSchema = z
  .object({
    key: z.string(),
    type: z.enum(['string', 'int', 'long', 'float', 'bool']),
    value: z.string(),
  })
  .passthrough()

const refTargeted = (type: Action['type']) =>
  z.object({ type: z.literal(type), ref: refSchema }).passthrough()

/** Exhaustive Action wire schemas keyed by `Action['type']`. */
export const ACTION_WIRE_SCHEMAS_BY_TYPE = {
  navigate: navigateSchema,
  waitForUrl: z.object({ type: z.literal('waitForUrl'), pattern: z.string() }).passthrough(),
  click: z
    .object({
      type: z.literal('click'),
      ref: refSchema,
      clickDelay: z.number().optional(),
      desiredState: desiredStateSchema.optional(),
    })
    .passthrough(),
  doubleClick: z
    .object({
      type: z.literal('doubleClick'),
      ref: refSchema,
      relativePosition: pointSchema.optional(),
      clickDelay: z.number().optional(),
    })
    .passthrough(),
  rightClick: z
    .object({
      type: z.literal('rightClick'),
      ref: refSchema,
      relativePosition: pointSchema.optional(),
      clickDelay: z.number().optional(),
    })
    .passthrough(),
  fill: fillSchema,
  select: z
    .object({ type: z.literal('select'), value: z.string(), ref: refSchema })
    .passthrough(),
  hover: refTargeted('hover'),
  paste: z.object({ type: z.literal('paste'), value: z.string(), ref: refSchema }).passthrough(),
  copy: refTargeted('copy'),
  fileUpload: z
    .object({ type: z.literal('fileUpload'), files: z.array(z.string()), ref: refSchema })
    .passthrough(),
  tab: tabSchema,
  inspect: inspectSchema,
  route: z
    .object({
      type: z.literal('route'),
      urlPattern: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      contentType: z.string().optional(),
    })
    .passthrough(),
  unroute: z
    .object({ type: z.literal('unroute'), urlPattern: z.string().optional() })
    .passthrough(),
  networkState: networkStateSchema,
  storageState: storageStateSchema,
  handleDialog: z
    .object({
      type: z.literal('handleDialog'),
      accept: z.boolean(),
      promptText: z.string().optional(),
    })
    .passthrough(),
  uniqueValue: z.object({ type: z.literal('uniqueValue'), prefix: z.string() }).passthrough(),
  focus: refTargeted('focus'),
  setCookies: z
    .object({ type: z.literal('setCookies'), cookies: z.array(cookieSchema) })
    .passthrough(),
  setLocalStorage: z
    .object({
      type: z.literal('setLocalStorage'),
      entries: z.array(z.object({ key: z.string(), value: z.string() }).passthrough()),
    })
    .passthrough(),
  tap: z
    .object({
      type: z.literal('tap'),
      ref: refSchema,
      desiredState: desiredStateSchema.optional(),
    })
    .passthrough(),
  doubleTap: refTargeted('doubleTap'),
  multiTap: z.union([
    z.object({ type: z.literal('multiTap'), fingers: fingersSchema, ref: refSchema }).passthrough(),
    z
      .object({
        type: z.literal('multiTap'),
        fingers: fingersSchema,
        x: z.number(),
        y: z.number(),
        coordSpace: coordSpaceSchema,
      })
      .passthrough(),
  ]),
  tapCoordinate: z
    .object({
      type: z.literal('tapCoordinate'),
      x: z.number(),
      y: z.number(),
      coordSpace: coordSpaceSchema,
    })
    .passthrough(),
  swipe: swipeSchema,
  longpress: z
    .object({
      type: z.literal('longpress'),
      ref: refSchema,
      duration: z.number().optional(),
    })
    .passthrough(),
  pinch: z.union([
    z.object({ type: z.literal('pinch'), scale: z.number(), ref: refSchema }).passthrough(),
    z
      .object({
        type: z.literal('pinch'),
        scale: z.number(),
        x: z.number(),
        y: z.number(),
        coordSpace: coordSpaceSchema,
      })
      .passthrough(),
  ]),
  drag: z
    .object({ type: z.literal('drag'), fromRef: refSchema, toRef: refSchema })
    .passthrough(),
  nativeSelect: z
    .object({ type: z.literal('nativeSelect'), value: z.string(), ref: refSchema })
    .passthrough(),
  hideKeyboard: z.object({ type: z.literal('hideKeyboard') }).passthrough(),
  setOrientation: z
    .object({
      type: z.literal('setOrientation'),
      orientation: z.enum(['portrait', 'landscape']),
    })
    .passthrough(),
  stopApp: z.object({ type: z.literal('stopApp'), bundleId: z.string() }).passthrough(),
  pressBack: z.object({ type: z.literal('pressBack') }).passthrough(),
  pressHome: z.object({ type: z.literal('pressHome') }).passthrough(),
  pressRecent: z.object({ type: z.literal('pressRecent') }).passthrough(),
  openNotifications: z.object({ type: z.literal('openNotifications') }).passthrough(),
  openQuickSettings: z.object({ type: z.literal('openQuickSettings') }).passthrough(),
  intent: z
    .object({
      type: z.literal('intent'),
      action: z.string(),
      data: z.string().optional(),
      packageName: z.string().optional(),
      extras: z.array(intentExtraSchema).optional(),
    })
    .passthrough(),
  keyevent: z.object({ type: z.literal('keyevent'), keycode: z.string() }).passthrough(),
  pressButton: z
    .object({ type: z.literal('pressButton'), button: z.enum(['home', 'volumeUp', 'action']) })
    .passthrough(),
  pickerSelect: pickerSelectSchema,
  swipeFromEdge: z
    .object({
      type: z.literal('swipeFromEdge'),
      edge: z.enum(['left', 'right', 'top', 'bottom']),
    })
    .passthrough(),
  openUniversalLink: z
    .object({
      type: z.literal('openUniversalLink'),
      url: z.string(),
      bundleId: z.string().optional(),
    })
    .passthrough(),
  assertAI: z
    .object({
      type: z.literal('assertAI'),
      claim: z.string(),
      mode: z.enum(['multimodal', 'visual', 'text']),
    })
    .passthrough(),
  assertValue: assertValueSchema,
  extractAI: z
    .object({
      type: z.literal('extractAI'),
      query: z.string(),
      schema: z.array(extractAIFieldSchema),
    })
    .passthrough(),
  waitFor: waitForSchema,
  delay: z.object({ type: z.literal('delay'), ms: z.number() }).passthrough(),
  scroll: scrollSchema,
  clearText: refTargeted('clearText'),
  reportValue: z.object({ type: z.literal('reportValue'), value: z.string() }).passthrough(),
  openApp: z.union([
    z.object({ type: z.literal('openApp'), appName: z.string() }).passthrough(),
    z.object({ type: z.literal('openApp'), bundleId: z.string() }).passthrough(),
  ]),
  executeScript: z
    .object({ type: z.literal('executeScript'), command: z.string(), args: z.unknown().optional() })
    .passthrough(),
  setVariable: z
    .object({ type: z.literal('setVariable'), name: z.string(), value: z.string() })
    .passthrough(),
  keypress: z
    .object({
      type: z.literal('keypress'),
      keys: z.array(z.string()),
      mode: z.enum(['press', 'down', 'up']),
      convertPlatformKeys: z.boolean().optional(),
    })
    .passthrough(),
} satisfies { [K in Action['type']]: z.ZodTypeAny }

/** Known-variant wire validator that dispatches by `Action['type']`. */
export const actionWireSchema = z
  .object({ type: z.string().min(1) })
  .passthrough()
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
    ] as z.ZodTypeAny | undefined

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
