import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../registry.js'
import { registerAllActions } from '../actions/index.js'
import { MOBILE_ONLY_ACTIONS } from '../actions/platform-filters.js'
import type { ToolDefinition } from '../types.js'

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  describe('register and get', () => {
    it('stores a ToolDefinition and retrieves it by name', () => {
      const def: ToolDefinition = {
        name: 'click',
        description: 'Click an element',
        category: 'action',
        schema: z.object({ ref: z.string() }),
      }
      registry.register(def)
      expect(registry.get('click')).toBe(def)
    })

    it('returns undefined for unknown tool', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('getAll', () => {
    it('returns all registered tools', () => {
      registry.register({ name: 'a', description: 'A', category: 'action', schema: z.object({}) })
      registry.register({ name: 'b', description: 'B', category: 'file', schema: z.object({}) })
      expect(registry.getAll()).toHaveLength(2)
    })
  })

  describe('getFiltered', () => {
    it('excludes mobile-only actions when platform is web', () => {
      registerAllActions(registry)
      const webTools = registry.getFiltered({ platform: 'web' })
      const names = webTools.map(t => t.name)
      expect(names).not.toContain('tap')
      expect(names).not.toContain('swipe')
      expect(names).not.toContain('longpress')
      expect(names).not.toContain('launchApp')
      expect(names).not.toContain('stopApp')
      expect(names).not.toContain('setOrientation')
      expect(names).not.toContain('hideKeyboard')
      expect(names).not.toContain('pinch')
      expect(names).not.toContain('multiTap')
      expect(names).not.toContain('executeScript')
      expect(names).not.toContain('nativeSelect')
      expect(names).toContain('click')
      expect(names).toContain('hover')
      expect(names).toContain('paste')
      expect(names).toContain('keyDown')
      expect(names).toContain('keyUp')
      expect(names).toContain('refresh')
      expect(names).toContain('navigateHistory')
      expect(names).toContain('readConsoleLogs')
      expect(names).toContain('readNetworkLogs')
      expect(names).toContain('readCookies')
      expect(names).toContain('setCookies')
      expect(names).toContain('readLocalStorage')
      expect(names).toContain('setLocalStorage')
      expect(names).toContain('newTab')
      expect(names).toContain('switchTab')
      expect(names).toContain('doubleTap')
      expect(names).toContain('doubleClick')
      expect(names).toContain('rightClick')
      expect(names).toContain('keypress')
      expect(names).not.toContain('back')
    })

    it('excludes web-only actions when platform is android', () => {
      registerAllActions(registry)
      const androidTools = registry.getFiltered({ platform: 'android' })
      const names = androidTools.map(t => t.name)
      expect(names).not.toContain('hover')
      expect(names).not.toContain('paste')
      expect(names).not.toContain('keyDown')
      expect(names).not.toContain('keyUp')
      expect(names).not.toContain('refresh')
      expect(names).not.toContain('navigateHistory')
      expect(names).toContain('readConsoleLogs')
      expect(names).not.toContain('readNetworkLogs')
      expect(names).not.toContain('readCookies')
      expect(names).not.toContain('setCookies')
      expect(names).not.toContain('readLocalStorage')
      expect(names).not.toContain('setLocalStorage')
      expect(names).not.toContain('newTab')
      expect(names).not.toContain('switchTab')
      expect(names).not.toContain('doubleClick')
      expect(names).not.toContain('rightClick')
      expect(names).toContain('tap')
      expect(names).toContain('click')
      expect(names).toContain('doubleTap')
      expect(names).toContain('executeScript')
      expect(names).toContain('nativeSelect')
      expect(names).toContain('keypress')
    })

    it('excludes web-only actions when platform is ios', () => {
      registerAllActions(registry)
      const iosTools = registry.getFiltered({ platform: 'ios' })
      const names = iosTools.map(t => t.name)
      expect(names).not.toContain('hover')
      expect(names).not.toContain('paste')
      expect(names).not.toContain('keyDown')
      expect(names).not.toContain('keyUp')
      expect(names).not.toContain('refresh')
      expect(names).not.toContain('navigateHistory')
      expect(names).toContain('readConsoleLogs')
      expect(names).not.toContain('readNetworkLogs')
      expect(names).not.toContain('readCookies')
      expect(names).not.toContain('setCookies')
      expect(names).not.toContain('readLocalStorage')
      expect(names).not.toContain('setLocalStorage')
      expect(names).not.toContain('newTab')
      expect(names).not.toContain('switchTab')
      expect(names).not.toContain('doubleClick')
      expect(names).not.toContain('rightClick')
      expect(names).toContain('tap')
      expect(names).toContain('doubleTap')
      expect(names).toContain('executeScript')
      expect(names).toContain('nativeSelect')
      expect(names).toContain('keypress')
    })

    it('returns all actions when no platform filter', () => {
      registerAllActions(registry)
      const all = registry.getFiltered({})
      expect(all).toHaveLength(45)
    })

    it('filters by category', () => {
      registerAllActions(registry)
      registry.register({ name: 'readFile', description: 'Read a file', category: 'file', schema: z.object({}) })
      const actions = registry.getFiltered({ categories: ['action'] })
      expect(actions.every(t => t.category === 'action')).toBe(true)
      expect(actions).toHaveLength(45)
    })

    it('treats nativeSelect as mobile-only', () => {
      registerAllActions(registry)
      expect(MOBILE_ONLY_ACTIONS).toContain('nativeSelect')
      expect(registry.getFiltered({ platform: 'web' }).map(t => t.name)).not.toContain('nativeSelect')
      expect(registry.getFiltered({ platform: 'android' }).map(t => t.name)).toContain('nativeSelect')
      expect(registry.getFiltered({ platform: 'ios' }).map(t => t.name)).toContain('nativeSelect')
    })
  })

  describe('getSchema', () => {
    it('returns the schema for a registered tool', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('click')
      expect(schema).toBeDefined()
      const result = schema.safeParse({ ref: 'e1' })
      expect(result.success).toBe(true)
    })

    it('throws for unknown tool', () => {
      expect(() => registry.getSchema('nonexistent')).toThrow()
    })
  })

  describe('keypress schema shape (phase 137)', () => {
    it('accepts { keys: ["Enter"] } with default convertPlatformKeys=true', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('keypress')
      const result = schema.safeParse({ keys: ['Enter'] })
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { keys: string[]; convertPlatformKeys: boolean }
        expect(data.keys).toEqual(['Enter'])
        expect(data.convertPlatformKeys).toBe(true)
      }
    })

    it('accepts combo strings with "+" separators', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('keypress')
      const result = schema.safeParse({ keys: ['Meta+k', 'Control+Shift+T'] })
      expect(result.success).toBe(true)
    })

    it('accepts explicit convertPlatformKeys=false', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('keypress')
      const result = schema.safeParse({ keys: ['Meta+k'], convertPlatformKeys: false })
      expect(result.success).toBe(true)
      if (result.success) {
        const data = result.data as { convertPlatformKeys: boolean }
        expect(data.convertPlatformKeys).toBe(false)
      }
    })

    it('REJECTS empty keys array (min 1)', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('keypress')
      const result = schema.safeParse({ keys: [] })
      expect(result.success).toBe(false)
    })

    it('REJECTS old { key: "Enter" } shape (breaking change)', () => {
      registerAllActions(registry)
      const schema = registry.getSchema('keypress')
      const result = schema.safeParse({ key: 'Enter' })
      expect(result.success).toBe(false)
    })
  })

  describe('generateDocs', () => {
    it('produces doc string with one line per action excluding mobile-only for web', () => {
      registerAllActions(registry)
      const docs = registry.generateDocs('web')
      expect(docs).toContain('- click:')
      expect(docs).toContain('- hover:')
      expect(docs).toContain('- readConsoleLogs:')
      expect(docs).toContain('- readNetworkLogs:')
      expect(docs).toContain('- readCookies:')
      expect(docs).toContain('- setCookies:')
      expect(docs).toContain('- readLocalStorage:')
      expect(docs).toContain('- setLocalStorage:')
      expect(docs).not.toContain('- tap:')
      expect(docs).not.toContain('- swipe:')
      expect(docs).not.toContain('- pinch:')
      expect(docs).not.toContain('- multiTap:')
      expect(docs).not.toContain('- executeScript:')
    })

    it('returns all 45 actions when no platform specified', () => {
      registerAllActions(registry)
      const docs = registry.generateDocs()
      const lines = docs.split('\n').filter(l => l.startsWith('- '))
      expect(lines).toHaveLength(45)
    })

    it('keeps generated docs platform availability aligned for nativeSelect', () => {
      registerAllActions(registry)
      const webLines = registry.generateDocs('web').split('\n').filter(l => l.startsWith('- '))
      const androidLines = registry.generateDocs('android').split('\n').filter(l => l.startsWith('- '))
      const iosLines = registry.generateDocs('ios').split('\n').filter(l => l.startsWith('- '))
      expect(webLines).toHaveLength(34)
      expect(androidLines).toHaveLength(27)
      expect(iosLines).toHaveLength(27)
      expect(registry.generateDocs('web')).not.toMatch(/^- nativeSelect:/m)
      expect(registry.generateDocs('android')).toMatch(/^- nativeSelect:/m)
      expect(registry.generateDocs('ios')).toMatch(/^- nativeSelect:/m)
    })

    it('includes param descriptions', () => {
      registerAllActions(registry)
      const docs = registry.generateDocs()
      expect(docs).toContain('Params:')
      expect(docs).toContain('ref')
    })
  })
})

describe('registerAllActions', () => {
  it('registers exactly 45 action tools', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const all = registry.getAll()
    expect(all).toHaveLength(45)
  })

  it('every action has category "action"', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const all = registry.getAll()
    expect(all.every(t => t.category === 'action')).toBe(true)
  })

  it('each action schema does NOT contain type or plan metadata fields', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    for (const def of registry.getAll()) {
      const shape = (def.schema as z.ZodObject<any>).shape
      expect(shape).not.toHaveProperty('type')
      expect(shape).not.toHaveProperty('reasoning')
      expect(shape).not.toHaveProperty('confidence')
      expect(shape).not.toHaveProperty('stepComplete')
      expect(shape).not.toHaveProperty('visualCheck')
    }
  })

  it('click schema has ref field', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const clickSchema = registry.getSchema('click') as z.ZodObject<any>
    expect(clickSchema.shape).toHaveProperty('ref')
  })

  it('fill schema has ref and value fields', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const fillSchema = registry.getSchema('fill') as z.ZodObject<any>
    expect(fillSchema.shape).toHaveProperty('ref')
    expect(fillSchema.shape).toHaveProperty('value')
  })

  it('scroll schema has scrollType, value, optional ref, duration', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const scrollSchema = registry.getSchema('scroll') as z.ZodObject<any>
    expect(scrollSchema.shape).toHaveProperty('scrollType')
    expect(scrollSchema.shape).toHaveProperty('value')
    expect(scrollSchema.shape).toHaveProperty('ref')
    expect(scrollSchema.shape).toHaveProperty('duration')
    expect(scrollSchema.shape).not.toHaveProperty('direction')
    expect(scrollSchema.shape).not.toHaveProperty('deltaX')
    expect(scrollSchema.shape).not.toHaveProperty('deltaY')
  })

  it('pinch schema has scale, optional x, y, ref', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const pinchSchema = registry.getSchema('pinch') as z.ZodObject<any>
    expect(pinchSchema.shape).toHaveProperty('scale')
    expect(pinchSchema.shape).toHaveProperty('x')
    expect(pinchSchema.shape).toHaveProperty('y')
    expect(pinchSchema.shape).toHaveProperty('ref')
  })

  it('executeScript schema has command, optional args', () => {
    const registry = new ToolRegistry()
    registerAllActions(registry)
    const schema = registry.getSchema('executeScript') as z.ZodObject<any>
    expect(schema.shape).toHaveProperty('command')
    expect(schema.shape).toHaveProperty('args')
  })
})
