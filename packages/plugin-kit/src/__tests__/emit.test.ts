import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { credential, definePlugin, emitPluginFiles, pluginManifest, z } from '../index.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempPackage(packageJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-plugin-emit-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), packageJson)
  return dir
}

function labPlugin(extra: { runFacts?: ['testName']; skill?: string } = {}) {
  return definePlugin({
    options: z.strictObject({
      apiKey: credential('API key'),
      region: z.string().default('eu'),
    }),
    settings: z.strictObject({
      pool: z.string().optional(),
      timeoutMs: z.number().int().default(30_000),
    }),
    serves: ['playwright', 'cdp'],
    ...extra,
    acquire: () => ({ handle: { id: 'a' }, protocol: 'cdp', url: 'ws://127.0.0.1:1/x' }),
    release: () => {},
    check: () => ({ state: 'ok', lines: [] }),
  })
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>

describe('credential()', () => {
  it('marks a plain string field as a credential with its description', () => {
    const schema = z.toJSONSchema(z.strictObject({ apiKey: credential('API key') }), {
      io: 'input',
    }) as Record<string, any>

    expect(schema.properties.apiKey).toEqual({
      type: 'string',
      credential: true,
      description: 'API key',
    })
    expect(schema.properties.apiKey).not.toHaveProperty('pattern')
    expect(schema.properties.apiKey).not.toHaveProperty('format')
  })

  it('leaves the description out when none is given', () => {
    const schema = z.toJSONSchema(credential(), { io: 'input' }) as Record<string, unknown>

    expect(schema.credential).toBe(true)
    expect(schema).not.toHaveProperty('description')
  })
})

describe('emitPluginFiles', () => {
  it('writes both schemas as draft 2020-12 inputs, closed where the object is strict', () => {
    const dir = tempPackage('{ "name": "@acme/agent-qa-plugin-lab", "version": "1.0.0" }\n')

    emitPluginFiles({ definition: labPlugin(), packageDir: dir })

    const options = readJson(join(dir, 'dist', 'options.schema.json'))
    const settings = readJson(join(dir, 'dist', 'settings.schema.json'))
    expect(options.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(settings.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(options.required).toEqual(['apiKey'])
    expect(options.properties.apiKey).toMatchObject({ credential: true, description: 'API key' })
    expect(options.additionalProperties).toBe(false)
    expect(settings.required ?? []).not.toContain('timeoutMs')
    expect(settings.properties.timeoutMs.default).toBe(30_000)
    expect(settings.additionalProperties).toBe(false)
  })

  it('writes the remote manifest into package.json under agent-qa.plugin', () => {
    const dir = tempPackage(
      `${JSON.stringify({ name: '@acme/agent-qa-plugin-lab', version: '1.0.0', 'agent-qa': { other: true } }, null, 2)}\n`,
    )
    const definition = labPlugin({ runFacts: ['testName'], skill: './skill' })

    emitPluginFiles({ definition, packageDir: dir })

    const pkg = readJson(join(dir, 'package.json'))
    expect(pkg['agent-qa']).toEqual({
      other: true,
      plugin: {
        protocol: 1,
        kind: 'remote',
        runs: 'process',
        entry: './dist/main.js',
        serves: ['playwright', 'cdp'],
        methods: ['check'],
        options: './dist/options.schema.json',
        settings: './dist/settings.schema.json',
        runFacts: ['testName'],
        skill: './skill',
      },
    })
    expect(pkg['agent-qa'].plugin).toEqual(pluginManifest(definition))
  })

  it('leaves runFacts and skill out of the manifest when the plugin sets neither', () => {
    const manifest = pluginManifest(labPlugin())

    expect(manifest).not.toHaveProperty('runFacts')
    expect(manifest).not.toHaveProperty('skill')
  })

  it('leaves package.json byte-identical on a second run', () => {
    const dir = tempPackage('{ "name": "@acme/agent-qa-plugin-lab", "version": "1.0.0" }\n')
    const definition = labPlugin()

    emitPluginFiles({ definition, packageDir: dir })
    const first = readFileSync(join(dir, 'package.json'), 'utf8')
    emitPluginFiles({ definition, packageDir: dir })

    expect(first.endsWith('}\n')).toBe(true)
    expect(first).toContain('\n  "agent-qa": {\n')
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(first)
  })

  it('does not rewrite a package.json whose manifest already matches', () => {
    const definition = labPlugin()
    const original = `${JSON.stringify(
      { name: '@acme/agent-qa-plugin-lab', 'agent-qa': { plugin: pluginManifest(definition) } },
      null,
      4,
    )}\n`
    const dir = tempPackage(original)

    emitPluginFiles({ definition, packageDir: dir })

    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
  })
})
