import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, EXPOSURE } from '../registry.js'
import { registerAllActions } from '../actions/index.js'
import { toolCallToActionPlan } from '../builder.js'
import type { ToolDefinition } from '../types.js'
import type { Platform } from '@vostride/agent-qa-schema'

const platforms: Platform[] = ['web', 'android', 'ios']
const androidToolIds = [
  'android_pressBack',
  'android_pressHome',
  'android_pressRecent',
  'android_openNotifications',
  'android_openQuickSettings',
  'android_intent',
  'android_keyevent',
]

const iosToolIds = [
  'ios_pressButton',
  'ios_pickerSelect',
  'ios_swipeFromEdge',
  'ios_openUniversalLink',
]

function schemaShapes(schema: z.ZodType): Array<Record<string, z.ZodType>> {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return schema.options.map(option => (option as z.ZodObject<any>).shape as Record<string, z.ZodType>)
  }
  if (schema instanceof z.ZodUnion) {
    return schema.options.map(option => (option as z.ZodObject<any>).shape as Record<string, z.ZodType>)
  }
  return [(schema as z.ZodObject<any>).shape as Record<string, z.ZodType>]
}

function typesFor(registry: ToolRegistry, platform: Platform): string[] {
  return registry.getForPlatform(platform).map(def => def.type)
}

function idsFor(registry: ToolRegistry, platform: Platform): string[] {
  return registry.getForPlatform(platform).map(def => def.id)
}

function expectedSliceCount(registry: ToolRegistry, platform: Platform): number {
  const surfaces = EXPOSURE[platform]
  return registry.getAll().filter(def => surfaces.has(def.surface)).length
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  describe('register and get', () => {
    it('stores a ToolDefinition and retrieves it by id', () => {
      const def: ToolDefinition = {
        id: 'web_click',
        type: 'click',
        surface: 'web',
        description: 'Click an element',
        category: 'action',
        schema: z.object({ ref: z.string() }),
      }
      registry.register(def)
      expect(registry.get('web_click')).toBe(def)
    })

    it('returns undefined for unknown tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('getAll', () => {
    it('returns all registered tools', () => {
      registry.register({
        id: 'web_a',
        type: 'a',
        surface: 'web',
        description: 'A',
        category: 'action',
        schema: z.object({}),
      })
      registry.register({
        id: 'common_b',
        type: 'b',
        surface: 'common',
        description: 'B',
        category: 'action',
        schema: z.object({}),
      })
      expect(registry.getAll()).toHaveLength(2)
    })
  })

  describe('getForPlatform', () => {
    it('returns the web slice with click and without tap', () => {
      registerAllActions(registry)
      const types = typesFor(registry, 'web')
      const ids = idsFor(registry, 'web')

      for (const type of [
        'click',
        'doubleClick',
        'rightClick',
        'hover',
        'copy',
        'paste',
        'inspect',
        'navigate',
        'tab',
        'setCookies',
        'setLocalStorage',
        'waitForUrl',
        'assertAI',
        'assertValue',
        'extractAI',
        'openApp',
        'reportValue',
        'waitFor',
        'delay',
        'scroll',
        'clearText',
        'keypress',
        'setVariable',
      ]) {
        expect(types).toContain(type)
      }

      expect(ids).toContain('web_fill')
      expect(ids).not.toContain('mobile_fill')
      expect(registry.getForPlatform('web')).toHaveLength(33)

      for (const type of [
        'keyDown',
        'keyUp',
        'refresh',
        'navigateHistory',
        'readConsoleLogs',
        'readNetworkLogs',
        'readCookies',
        'readLocalStorage',
        'newTab',
        'switchTab',
        'tap',
        'doubleTap',
        'multiTap',
        'tapCoordinate',
        'swipe',
        'longpress',
        'pinch',
        'drag',
        'nativeSelect',
        'hideKeyboard',
        'setOrientation',
      ]) {
        expect(types).not.toContain(type)
      }
    })

    it('returns the android slice with tap and without click', () => {
      registerAllActions(registry)
      const types = typesFor(registry, 'android')
      const ids = idsFor(registry, 'android')

      for (const type of ['tap', 'doubleTap', 'nativeSelect', 'keypress']) {
        expect(types).toContain(type)
      }

      expect(ids).toContain('mobile_fill')
      expect(ids).not.toContain('web_fill')

      for (const type of [
        'click',
        'doubleClick',
        'rightClick',
        'hover',
        'readConsoleLogs',
        'readNetworkLogs',
        'readCookies',
        'setCookies',
        'readLocalStorage',
        'setLocalStorage',
      ]) {
        expect(types).not.toContain(type)
      }
    })

    it('returns the ios slice with tap and without click', () => {
      registerAllActions(registry)
      const types = typesFor(registry, 'ios')
      const ids = idsFor(registry, 'ios')

      for (const type of ['tap', 'doubleTap', 'nativeSelect', 'keypress']) {
        expect(types).toContain(type)
      }

      expect(ids).toContain('mobile_fill')
      expect(ids).not.toContain('web_fill')

      for (const type of [
        'click',
        'doubleClick',
        'rightClick',
        'hover',
        'readConsoleLogs',
        'readNetworkLogs',
        'readCookies',
        'setCookies',
        'readLocalStorage',
        'setLocalStorage',
      ]) {
        expect(types).not.toContain(type)
      }
    })

    it('keeps nativeSelect out of web and present on mobile platforms', () => {
      registerAllActions(registry)

      expect(typesFor(registry, 'web')).not.toContain('nativeSelect')
      expect(typesFor(registry, 'android')).toContain('nativeSelect')
      expect(typesFor(registry, 'ios')).toContain('nativeSelect')
    })

    it('matches the exposed surface count for each platform', () => {
      registerAllActions(registry)

      for (const platform of platforms) {
        expect(registry.getForPlatform(platform)).toHaveLength(expectedSliceCount(registry, platform))
      }
    })
  })

  describe('getSchema', () => {
    it('returns the schema for a registered tool id', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('web_click')
      expect(schema).toBeDefined()
      const result = schema.safeParse({ ref: 'e1' })
      expect(result.success).toBe(true)
    })

    it('throws for unknown tool', () => {
      expect(() => registry.getSchema('nonexistent')).toThrow()
    })
  })

  describe('keypress schema shape', () => {
    it('accepts { keys: ["Enter"] } with default convertPlatformKeys=true', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('common_keypress')
      const result = schema.safeParse({ keys: ['Enter'] })
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { keys: string[]; convertPlatformKeys: boolean; mode: string }
        expect(data.keys).toEqual(['Enter'])
        expect(data.convertPlatformKeys).toBe(true)
        expect(data.mode).toBe('press')
      }
    })

    it('accepts hold and release keypress modes', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('common_keypress')
      const down = schema.safeParse({ keys: ['Shift'], mode: 'down' })
      const up = schema.safeParse({ keys: ['Shift'], mode: 'up' })

      expect(down.success).toBe(true)
      expect(up.success).toBe(true)
      if (down.success) {
        expect((down.data as { mode: string }).mode).toBe('down')
      }
      if (up.success) {
        expect((up.data as { mode: string }).mode).toBe('up')
      }
    })

    it('accepts combo strings with "+" separators', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('common_keypress')
      const result = schema.safeParse({ keys: ['Meta+k', 'Control+Shift+T'] })
      expect(result.success).toBe(true)
    })

    it('accepts explicit convertPlatformKeys=false', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('common_keypress')
      const result = schema.safeParse({ keys: ['Meta+k'], convertPlatformKeys: false })
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { convertPlatformKeys: boolean }
        expect(data.convertPlatformKeys).toBe(false)
      }
    })

    it('REJECTS empty keys array (min 1)', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('common_keypress')
      const result = schema.safeParse({ keys: [] })
      expect(result.success).toBe(false)
    })

    it('REJECTS old { key: "Enter" } shape (breaking change)', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('common_keypress')
      const result = schema.safeParse({ key: 'Enter' })
      expect(result.success).toBe(false)
    })
  })

  describe('generateDocs', () => {
    it('produces web docs from the web slice', () => {
      registerAllActions(registry)
      const docs = registry.generateDocs('web')
      expect(docs).toMatch(/^- web_click:/m)
      expect(docs).toMatch(/^- web_hover:/m)
      expect(docs).toMatch(/^- web_inspect:/m)
      expect(docs).toMatch(/^- common_keypress:/m)
      expect(docs).not.toMatch(/^- mobile_tap:/m)
      expect(docs).not.toMatch(/^- mobile_swipe:/m)
      expect(docs).not.toMatch(/^- common_executeScript:/m)
    })

    it('returns all 56 registered actions when no platform is specified', () => {
      registerAllActions(registry)
      const docs = registry.generateDocs()
      const lines = docs.split('\n').filter(l => l.startsWith('- '))
      expect(lines).toHaveLength(56)
    })

    it('keeps generated docs platform availability aligned for nativeSelect', () => {
      registerAllActions(registry)
      const webLines = registry.generateDocs('web').split('\n').filter(l => l.startsWith('- '))
      const androidLines = registry.generateDocs('android').split('\n').filter(l => l.startsWith('- '))
      const iosLines = registry.generateDocs('ios').split('\n').filter(l => l.startsWith('- '))

      expect(webLines).toHaveLength(expectedSliceCount(registry, 'web'))
      expect(androidLines).toHaveLength(expectedSliceCount(registry, 'android'))
      expect(iosLines).toHaveLength(expectedSliceCount(registry, 'ios'))
      expect(registry.generateDocs('web')).not.toMatch(/^- mobile_nativeSelect:/m)
      expect(registry.generateDocs('android')).toMatch(/^- mobile_nativeSelect:/m)
      expect(registry.generateDocs('ios')).toMatch(/^- mobile_nativeSelect:/m)
    })

    it('includes param descriptions', () => {
      registerAllActions(registry)
      const docs = registry.generateDocs()
      expect(docs).toContain('Params:')
      expect(docs).toContain('ref')
    })
  })
})

describe('toolCallToActionPlan', () => {
  it('emits the bare action type for a web tool id', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    const result = toolCallToActionPlan('web_click', {
      ref: 'e1',
      reasoning: 'x',
      confidence: 1,
      stepComplete: true,
    }, registry)

    expect(result.action.type).toBe('click')
  })

  it('emits the bare action type for a mobile tool id', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    const result = toolCallToActionPlan('mobile_tap', {
      ref: 'e1',
      reasoning: 'x',
      confidence: 1,
      stepComplete: true,
    }, registry)

    expect(result.action.type).toBe('tap')
  })
})

describe('surface + id integrity', () => {
  it('registers exactly 56 action tools', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const all = registry.getAll()
    expect(all).toHaveLength(56)
  })

  it('every action has category "action"', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const all = registry.getAll()
    expect(all.every(t => t.category === 'action')).toBe(true)
  })

  it('every registered definition has a surface and matching id', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const all = registry.getAll()

    expect(all.every(d => d.surface)).toBe(true)
    expect(all.every(d => d.id === `${d.surface}_${d.type}`)).toBe(true)
  })

  it('carries advisory static metadata on existing read and mutation tools', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    expect(registry.get('web_inspect')?.readOnly).toBe(true)
    expect(registry.get('common_assertAI')?.readOnly).toBe(true)
    expect(registry.get('common_assertValue')?.readOnly).toBe(true)
    expect(registry.get('common_extractAI')?.readOnly).toBe(true)
    expect(registry.get('common_reportValue')?.readOnly).toBe(true)

    for (const id of [
      'web_fill',
      'mobile_fill',
      'web_navigate',
      'web_setCookies',
      'web_setLocalStorage',
      'web_fileUpload',
      'web_paste',
      'web_copy',
    ]) {
      expect(registry.get(id)?.destructive).toBe(true)
    }
  })

  it('keeps advisory metadata out of platform slice filtering', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    expect(registry.getForPlatform('web')).toHaveLength(33)
    expect(registry.getForPlatform('android')).toHaveLength(30)
    expect(registry.getForPlatform('ios')).toHaveLength(27)
  })

  it('each action schema keeps plan metadata out of registry args', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    for (const def of registry.getAll()) {
      for (const shape of schemaShapes(def.schema)) {
        expect(shape).not.toHaveProperty('type')
        expect(shape).not.toHaveProperty('reasoning')
        expect(shape).not.toHaveProperty('confidence')
        expect(shape).not.toHaveProperty('stepComplete')
        expect(shape).not.toHaveProperty('doesActionAdvanceUsTowardsGoal')
        expect(shape).not.toHaveProperty('visualCheck')
      }
    }
  })

  it('registers reportValue and openApp while removing openLink', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    expect(registry.get('common_openLink')).toBeUndefined()

    const openApp = registry.get('common_openApp')
    const reportValue = registry.get('common_reportValue')
    expect(openApp?.surface).toBe('common')
    expect(reportValue?.surface).toBe('common')
    expect(reportValue?.readOnly).toBe(true)

    const openAppSchema = registry.getSchema('common_openApp') as z.ZodType
    expect(openAppSchema.safeParse({ appName: 'Settings' }).success).toBe(true)
    expect(openAppSchema.safeParse({ bundleId: 'com.apple.Preferences' }).success).toBe(true)
    expect(openAppSchema.safeParse({}).success).toBe(false)
    expect(openAppSchema.safeParse({ appName: 'Settings', bundleId: 'com.apple.Preferences' }).success).toBe(false)

    const reportValueSchema = registry.getSchema('common_reportValue') as z.ZodType
    expect(reportValueSchema.safeParse({ value: 'the order total is 42' }).success).toBe(true)
    expect(reportValueSchema.safeParse({}).success).toBe(false)

    expect(registry.get('common_executeScript')).toBeUndefined()
  })

  it('registers web-tier tool definitions on the web surface only', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    for (const id of [
      'web_route',
      'web_unroute',
      'web_networkState',
      'web_storageState',
      'web_handleDialog',
      'web_uniqueValue',
      'web_focus',
    ]) {
      const def = registry.get(id)
      expect(def?.surface).toBe('web')
      expect(registry.getForPlatform('web').map(tool => tool.id)).toContain(id)
      expect(registry.getForPlatform('android').map(tool => tool.id)).not.toContain(id)
      expect(registry.getForPlatform('ios').map(tool => tool.id)).not.toContain(id)
    }

    expect(registry.get('web_route')?.destructive).toBe(true)
    expect(registry.get('web_networkState')?.readOnly).toBe(true)
    expect(registry.get('web_uniqueValue')?.readOnly).toBe(true)
  })

  it('validates web-tier schemas without escape-hatch shapes', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    const routeSchema = registry.getSchema('web_route') as z.ZodType
    expect(routeSchema.safeParse({
      urlPattern: '**/api/users',
      headers: { 'X-Test': '1' },
      body: '{"a":1}',
      contentType: 'application/json',
    }).success).toBe(true)
    expect(routeSchema.safeParse({ urlPattern: '**/api/users' }).success).toBe(true)
    expect(routeSchema.safeParse({ urlPattern: '**/api/users', extra: true }).success).toBe(false)

    const unrouteSchema = registry.getSchema('web_unroute') as z.ZodType
    expect(unrouteSchema.safeParse({ urlPattern: '**/api/users' }).success).toBe(true)
    expect(unrouteSchema.safeParse({}).success).toBe(true)

    const networkStateSchema = registry.getSchema('web_networkState') as z.ZodType
    expect(networkStateSchema.safeParse({ mode: 'offline' }).success).toBe(true)
    expect(networkStateSchema.safeParse({
      mode: 'throttle',
      latencyMs: 150,
      downloadKbps: 750,
      uploadKbps: 250,
    }).success).toBe(true)
    expect(networkStateSchema.safeParse({ mode: 'throttle' }).success).toBe(false)

    const storageStateSchema = registry.getSchema('web_storageState') as z.ZodType
    expect(storageStateSchema.safeParse({ op: 'save', name: 'admin' }).success).toBe(true)
    expect(storageStateSchema.safeParse({ op: 'restore', name: 'admin' }).success).toBe(true)
    expect(storageStateSchema.safeParse({ op: 'delete', name: 'admin' }).success).toBe(false)

    const handleDialogSchema = registry.getSchema('web_handleDialog') as z.ZodType
    expect(handleDialogSchema.safeParse({ accept: true }).success).toBe(true)
    expect(handleDialogSchema.safeParse({ accept: true, promptText: 'hello' }).success).toBe(true)

    const uniqueValueSchema = registry.getSchema('web_uniqueValue') as z.ZodType
    expect(uniqueValueSchema.safeParse({ prefix: 'user' }).success).toBe(true)

    const focusSchema = registry.getSchema('web_focus') as z.ZodObject<any>
    expect(focusSchema.safeParse({ ref: 'e1' }).success).toBe(true)
    expect(focusSchema.safeParse({ ref: 'e1', elementDescription: 'email field' }).success).toBe(true)
    // ref is now optional because a target descriptor may replace it; the
    // exactly-one-of ref/target rule is enforced at the Plan-04 grounding gate, not zod.
    expect(focusSchema.safeParse({ target: { role: 'textbox', name: 'Email' } }).success).toBe(true)
    expect(focusSchema.safeParse({ target: { name: 'Email' }, selector: '#email' }).success).toBe(false)
    expect(focusSchema.shape).toHaveProperty('ref')
    expect(focusSchema.shape).toHaveProperty('target')
    expect(focusSchema.shape).toHaveProperty('elementDescription')
    expect(focusSchema.shape).not.toHaveProperty('text')
  })

  it('registers android-tier tool definitions on the android surface only', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    for (const id of androidToolIds) {
      const def = registry.get(id)
      expect(def?.surface).toBe('android')
      expect(registry.getForPlatform('android').map(tool => tool.id)).toContain(id)
      expect(registry.getForPlatform('web').map(tool => tool.id)).not.toContain(id)
      expect(registry.getForPlatform('ios').map(tool => tool.id)).not.toContain(id)
    }

    expect(registry.get('android_intent')?.destructive).toBe(true)
    expect(registry.get('android_keyevent')?.destructive).toBe(true)
  })

  it('validates android schemas with typed intent extras', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    for (const id of [
      'android_pressBack',
      'android_pressHome',
      'android_pressRecent',
      'android_openNotifications',
      'android_openQuickSettings',
    ]) {
      const schema = registry.getSchema(id) as z.ZodType
      expect(schema.safeParse({}).success).toBe(true)
      expect(schema.safeParse({ extra: true }).success).toBe(false)
    }

    const intentSchema = registry.getSchema('android_intent') as z.ZodObject<any>
    expect(intentSchema.safeParse({ action: 'android.intent.action.VIEW' }).success).toBe(true)
    expect(intentSchema.safeParse({
      action: 'android.intent.action.VIEW',
      data: 'https://x',
      packageName: 'com.app',
      extras: [{ key: 'k', type: 'string', value: 'v' }],
    }).success).toBe(true)
    expect(intentSchema.safeParse({
      action: 'android.intent.action.VIEW',
      extras: [{ key: 'k', type: 'bytes', value: 'v' }],
    }).success).toBe(false)
    expect(intentSchema.shape).toHaveProperty('extras')

    const keyeventSchema = registry.getSchema('android_keyevent') as z.ZodType
    expect(keyeventSchema.safeParse({ keycode: 'KEYCODE_ENTER' }).success).toBe(true)
    expect(keyeventSchema.safeParse({}).success).toBe(false)
  })

  it('registers ios-tier tool definitions on the ios surface only', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    for (const id of iosToolIds) {
      const def = registry.get(id)
      expect(def?.surface).toBe('ios')
      expect(registry.getForPlatform('ios').map(tool => tool.id)).toContain(id)
      expect(registry.getForPlatform('web').map(tool => tool.id)).not.toContain(id)
      expect(registry.getForPlatform('android').map(tool => tool.id)).not.toContain(id)
    }

    expect(registry.get('ios_pressHome')).toBeUndefined()
    expect(registry.getForPlatform('ios').map(tool => tool.id)).toContain('mobile_nativeSelect')
  })

  it('validates ios schemas with pickerSelect ref/value and ref/order variants', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)

    const pressButtonSchema = registry.getSchema('ios_pressButton') as z.ZodType
    expect(pressButtonSchema.safeParse({ button: 'home' }).success).toBe(true)
    expect(pressButtonSchema.safeParse({ button: 'volumeUp' }).success).toBe(true)
    expect(pressButtonSchema.safeParse({ button: 'action' }).success).toBe(true)
    expect(pressButtonSchema.safeParse({ button: 'lock' }).success).toBe(false)

    const pickerSelectSchema = registry.getSchema('ios_pickerSelect') as z.ZodUnion<any>
    expect(pickerSelectSchema.safeParse({ ref: 'e1', value: 'March' }).success).toBe(true)
    expect(pickerSelectSchema.safeParse({ ref: 'e1', order: 0 }).success).toBe(true)
    expect(pickerSelectSchema.safeParse({}).success).toBe(false)
    expect(pickerSelectSchema.safeParse({ ref: 'e1' }).success).toBe(false)
    for (const option of pickerSelectSchema.options as z.ZodObject<any>[]) {
      expect(option.shape).toHaveProperty('ref')
      expect(option.shape).toHaveProperty('elementDescription')
    }

    const swipeFromEdgeSchema = registry.getSchema('ios_swipeFromEdge') as z.ZodType
    expect(swipeFromEdgeSchema.safeParse({ edge: 'left' }).success).toBe(true)
    expect(swipeFromEdgeSchema.safeParse({ edge: 'diagonal' }).success).toBe(false)

    const openUniversalLinkSchema = registry.getSchema('ios_openUniversalLink') as z.ZodObject<any>
    expect(openUniversalLinkSchema.safeParse({ url: 'https://x' }).success).toBe(true)
    expect(openUniversalLinkSchema.safeParse({ url: 'https://x', bundleId: 'com.app' }).success).toBe(true)
    expect(openUniversalLinkSchema.safeParse({}).success).toBe(false)
    expect(openUniversalLinkSchema.shape.bundleId.description).toMatch(/omit/i)
    expect(openUniversalLinkSchema.shape.bundleId.description).toContain('com.apple.mobilesafari')
  })

  it('click schema has ref field', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const clickSchema = registry.getSchema('web_click') as z.ZodObject<any>
    expect(clickSchema.shape).toHaveProperty('ref')
  })

  it('fill schemas have ref, text, clearMode, and submit fields', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const webFillSchema = registry.getSchema('web_fill') as z.ZodObject<any>
    const mobileFillSchema = registry.getSchema('mobile_fill') as z.ZodObject<any>
    expect(webFillSchema).toBe(mobileFillSchema)
    expect(webFillSchema.shape).toHaveProperty('ref')
    expect(webFillSchema.shape).toHaveProperty('text')
    expect(webFillSchema.shape).toHaveProperty('clearMode')
    expect(webFillSchema.shape).toHaveProperty('submit')
    expect(webFillSchema.shape).not.toHaveProperty('value')
    expect(mobileFillSchema.shape).toHaveProperty('ref')
    expect(mobileFillSchema.shape).toHaveProperty('text')
    expect(mobileFillSchema.shape).toHaveProperty('clearMode')
    expect(mobileFillSchema.shape).toHaveProperty('submit')
    expect(mobileFillSchema.shape).not.toHaveProperty('value')
  })

  it('scroll schema validates discriminated mode variants', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const scrollSchema = registry.getSchema('common_scroll') as z.ZodType
    expect(scrollSchema.safeParse({ mode: 'direction', direction: 'down' }).success).toBe(true)
    expect(scrollSchema.safeParse({ mode: 'untilVisible', text: 'Submit' }).success).toBe(true)
    expect(scrollSchema.safeParse({ scrollType: 'vertical', value: 500 }).success).toBe(false)
  })

  it('swipe schema validates discriminated mode variants', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const swipeSchema = registry.getSchema('mobile_swipe') as z.ZodType
    expect(swipeSchema.safeParse({ mode: 'direction', direction: 'up' }).success).toBe(true)
    expect(swipeSchema.safeParse({ mode: 'path', from: { x: 0, y: 0 }, to: { x: 10, y: 20 } }).success).toBe(true)
    expect(swipeSchema.safeParse({ direction: 'up', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }).success).toBe(false)
    expect(swipeSchema.safeParse({ mode: 'path', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, direction: 'up' }).success).toBe(false)
  })

  it('web_inspect schema validates browser read variants', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const inspectSchema = registry.getSchema('web_inspect') as z.ZodType

    expect(inspectSchema.safeParse({ what: 'console' }).success).toBe(true)
    expect(inspectSchema.safeParse({ what: 'network', urlPattern: '/api' }).success).toBe(true)
    expect(inspectSchema.safeParse({ what: 'cookies', name: 'sid' }).success).toBe(true)
    expect(inspectSchema.safeParse({ what: 'localStorage', key: 'k' }).success).toBe(true)
    expect(inspectSchema.safeParse({ what: 'bogus' }).success).toBe(false)
  })

  it('navigate schema validates folded navigation variants', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const navigateSchema = registry.getSchema('web_navigate') as z.ZodType

    expect(navigateSchema.safeParse({ to: 'url', url: 'https://x' }).success).toBe(true)
    expect(navigateSchema.safeParse({ to: 'back' }).success).toBe(true)
    expect(navigateSchema.safeParse({ to: 'reload' }).success).toBe(true)
    expect(navigateSchema.safeParse({ to: 'url' }).success).toBe(false)
  })

  it('tab schema validates new and switch variants', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const tabSchema = registry.getSchema('web_tab') as z.ZodType

    expect(tabSchema.safeParse({ action: 'new', url: 'https://x' }).success).toBe(true)
    expect(tabSchema.safeParse({ action: 'switch', index: 0 }).success).toBe(true)
    expect(tabSchema.safeParse({ action: 'switch' }).success).toBe(true)
  })

  it('pinch schema accepts a ref, a coordinate target, or a descriptor target', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const pinchSchema = registry.getSchema('mobile_pinch') as z.ZodType

    expect(pinchSchema.safeParse({ scale: 2, ref: 'e1' }).success).toBe(true)
    expect(pinchSchema.safeParse({ scale: 2, x: 10, y: 20, coordSpace: 'viewport' }).success).toBe(true)
    // the ref-branch ref is now optional (a target descriptor may replace it); the
    // exactly-one-of ref/target rule is enforced at the Plan-04 grounding gate, not zod.
    expect(pinchSchema.safeParse({ scale: 2, target: { role: 'image', name: 'Map' } }).success).toBe(true)
    expect(pinchSchema.safeParse({ scale: 2, near: { nameNormalized: 'map' } }).success).toBe(false)
  })

  it('multiTap schema accepts a ref, a coordinate target, or a descriptor target', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const multiTapSchema = registry.getSchema('mobile_multiTap') as z.ZodType

    expect(multiTapSchema.safeParse({ fingers: 2, ref: 'e1' }).success).toBe(true)
    expect(multiTapSchema.safeParse({ fingers: 3, x: 10, y: 20, coordSpace: 'content' }).success).toBe(true)
    // the ref-branch ref is now optional (a target descriptor may replace it).
    expect(multiTapSchema.safeParse({ fingers: 2, target: { role: 'image', name: 'Canvas' } }).success).toBe(true)
    expect(multiTapSchema.safeParse({ fingers: 2, selector: '#canvas' }).success).toBe(false)
  })

  it('executeScript is not registered as a planner-facing tool', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    expect(registry.get('common_executeScript')).toBeUndefined()
  })
})
