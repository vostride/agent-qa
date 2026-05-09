import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { AutomationSchema } from '../automation/schema.js'
import { AutomationLoader } from '../automation/loader.js'
import { readJsonBody } from '../server/body-parser.js'

describe('AutomationSchema', () => {
  it('validates a valid automation config', () => {
    const result = AutomationSchema.safeParse({
      name: 'smoke-tests',
      target: { suite: 'smoke', tags: ['critical'] },
      schedule: { frequency: 'daily', timeOfDay: '09:00' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('smoke-tests')
      expect(result.data.enabled).toBe(true)
      expect(result.data.target.suite).toBe('smoke')
    }
  })

  it('rejects config missing name', () => {
    const result = AutomationSchema.safeParse({
      target: { suite: 'smoke' },
    })
    expect(result.success).toBe(false)
  })

  it('defaults enabled to true', () => {
    const result = AutomationSchema.safeParse({
      name: 'test',
      target: {},
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enabled).toBe(true)
    }
  })

  it('accepts optional fields', () => {
    const result = AutomationSchema.safeParse({
      name: 'full-config',
      enabled: false,
      target: { suite: 'regression', app: 'myapp', environment: 'staging', tests: ['a.yaml'], tags: ['fast'] },
      schedule: { frequency: 'weekly', dayOfWeek: 1, cron: '0 9 * * 1' },
      timeout: 300000,
      overrides: { browser: 'firefox' },
      description: 'Full regression suite',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.enabled).toBe(false)
      expect(result.data.timeout).toBe(300000)
      expect(result.data.description).toBe('Full regression suite')
    }
  })

  it('rejects invalid schedule frequency', () => {
    const result = AutomationSchema.safeParse({
      name: 'bad',
      target: {},
      schedule: { frequency: 'biweekly' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects dayOfWeek out of range', () => {
    const result = AutomationSchema.safeParse({
      name: 'bad',
      target: {},
      schedule: { dayOfWeek: 7 },
    })
    expect(result.success).toBe(false)
  })
})

describe('AutomationLoader', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-qa-loader-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('loads all YAML files from directory', async () => {
    await writeFile(join(tmpDir, 'smoke.yaml'), `name: smoke-tests\ntarget:\n  suite: smoke\n`)
    await writeFile(join(tmpDir, 'regression.yml'), `name: regression\ntarget:\n  tags:\n    - all\n`)

    const loader = new AutomationLoader(tmpDir)
    const { automations, files } = await loader.loadAll()

    expect(automations).toHaveLength(2)
    const names = automations.map(a => a.name).sort()
    expect(names).toEqual(['regression', 'smoke-tests'])
    expect(files.get('smoke-tests')).toContain('smoke.yaml')
    expect(files.get('regression')).toContain('regression.yml')
  })

  it('skips invalid YAML files', async () => {
    await writeFile(join(tmpDir, 'valid.yaml'), `name: valid\ntarget:\n  suite: smoke\n`)
    await writeFile(join(tmpDir, 'invalid.yaml'), `target:\n  suite: smoke\n`)

    const loader = new AutomationLoader(tmpDir)
    const { automations } = await loader.loadAll()

    expect(automations).toHaveLength(1)
    expect(automations[0].name).toBe('valid')
  })

  it('loads a single automation by name', async () => {
    await writeFile(join(tmpDir, 'smoke.yaml'), `name: smoke-tests\ntarget:\n  suite: smoke\n`)
    await writeFile(join(tmpDir, 'regression.yaml'), `name: regression\ntarget:\n  tags:\n    - all\n`)

    const loader = new AutomationLoader(tmpDir)
    const automation = await loader.load('regression')

    expect(automation).toBeDefined()
    expect(automation!.name).toBe('regression')
  })

  it('returns undefined for non-existent automation', async () => {
    const loader = new AutomationLoader(tmpDir)
    const automation = await loader.load('nonexistent')
    expect(automation).toBeUndefined()
  })

  it('saves a new automation as YAML file', async () => {
    const loader = new AutomationLoader(tmpDir)
    const path = await loader.save({
      name: 'nightly',
      enabled: true,
      target: { suite: 'regression' },
      schedule: { frequency: 'daily', timeOfDay: '02:00' },
    })

    expect(path).toContain('nightly.yaml')
    const content = await readFile(path, 'utf-8')
    expect(content).toContain('nightly')
    expect(content).toContain('regression')
  })

  it('preserves comments in existing YAML file on save', async () => {
    const original = `# Smoke test automation\nname: smoke-tests\n# Run the smoke suite\ntarget:\n  suite: smoke\nenabled: true\n`
    const filePath = join(tmpDir, 'smoke.yaml')
    await writeFile(filePath, original)

    const loader = new AutomationLoader(tmpDir)
    await loader.save({
      name: 'smoke-tests',
      enabled: false,
      target: { suite: 'smoke', tags: ['fast'] },
    }, filePath)

    const updated = await readFile(filePath, 'utf-8')
    expect(updated).toContain('# Smoke test automation')
    expect(updated).toContain('# Run the smoke suite')
    expect(updated).toContain('enabled: false')
  })

  it('creates directory if it does not exist', async () => {
    const nestedDir = join(tmpDir, 'nested', 'automations')
    const loader = new AutomationLoader(nestedDir)
    const path = await loader.save({
      name: 'test',
      enabled: true,
      target: {},
    })

    expect(path).toContain('test.yaml')
    const content = await readFile(path, 'utf-8')
    expect(content).toContain('test')
  })

  it('deletes an automation by name', async () => {
    await writeFile(join(tmpDir, 'to-delete.yaml'), `name: to-delete\ntarget:\n  suite: smoke\n`)

    const loader = new AutomationLoader(tmpDir)
    const deleted = await loader.delete('to-delete')
    expect(deleted).toBe(true)

    const automation = await loader.load('to-delete')
    expect(automation).toBeUndefined()
  })

  it('returns false when deleting non-existent automation', async () => {
    const loader = new AutomationLoader(tmpDir)
    const deleted = await loader.delete('nonexistent')
    expect(deleted).toBe(false)
  })

  it('slugifies names correctly', async () => {
    const loader = new AutomationLoader(tmpDir)
    const path = await loader.save({
      name: 'My Smoke Tests!',
      enabled: true,
      target: { suite: 'smoke' },
    })
    expect(path).toContain('my-smoke-tests.yaml')
  })
})

describe('readJsonBody', () => {
  function createMockRequest(body: string, opts: { maxChunkSize?: number } = {}): IncomingMessage {
    const socket = new Socket()
    const req = new IncomingMessage(socket)
    const chunkSize = opts.maxChunkSize ?? body.length

    process.nextTick(() => {
      for (let i = 0; i < body.length; i += chunkSize) {
        req.push(Buffer.from(body.slice(i, i + chunkSize)))
      }
      req.push(null)
    })

    return req
  }

  it('parses valid JSON body', async () => {
    const req = createMockRequest(JSON.stringify({ name: 'test', value: 42 }))
    const result = await readJsonBody<{ name: string; value: number }>(req)
    expect(result.name).toBe('test')
    expect(result.value).toBe(42)
  })

  it('rejects empty body', async () => {
    const req = createMockRequest('')
    await expect(readJsonBody(req)).rejects.toThrow('Empty request body')
  })

  it('rejects oversized body', async () => {
    const largeBody = 'x'.repeat(1024 * 1024 + 1)
    const req = createMockRequest(largeBody, { maxChunkSize: 1024 })
    await expect(readJsonBody(req, 1024 * 1024)).rejects.toThrow('exceeds maximum size')
  })

  it('rejects invalid JSON', async () => {
    const req = createMockRequest('not json at all')
    await expect(readJsonBody(req)).rejects.toThrow('Invalid JSON')
  })

  it('handles chunked data', async () => {
    const data = JSON.stringify({ items: [1, 2, 3] })
    const req = createMockRequest(data, { maxChunkSize: 5 })
    const result = await readJsonBody<{ items: number[] }>(req)
    expect(result.items).toEqual([1, 2, 3])
  })
})
