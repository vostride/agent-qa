import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, emitPluginFiles, z } from '../index.js'
import { expectManifestCurrent, runConformance, writeScriptedPlugin } from '../testing/index.js'

const answer = { protocol: 'playwright', url: 'ws://127.0.0.1:9222/lab' }
const kitVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version
const openSchema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
})

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-plugin-conformance-'))
  dirs.push(dir)
  return dir
}

function readLedger(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

interface HandWritten {
  printHello?: boolean
  ignoreStdinClose?: boolean
  requirePlaywright?: string
}

// A plugin written without the kit, answering the protocol by hand.
const HAND_WRITTEN_MAIN = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const behaviour = BEHAVIOUR
const ledger = new URL('./ledger.jsonl', import.meta.url)
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
let host
let issued = 0

if (behaviour.printHello) process.stdout.write('hello\\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  appendFileSync(ledger, JSON.stringify({ method: message.method, params: message.params }) + '\\n')
  if (message.method === 'initialize') {
    host = message.params.host
    const plugin = { name: 'hand-written', version: '1.0.0' }
    return send({ id: message.id, result: { protocolVersion: 1, plugin, serves: ['cdp'], methods: [] } })
  }
  if (message.method === 'acquire') {
    const wanted = behaviour.requirePlaywright
    if (wanted !== undefined && host.playwrightVersion !== wanted) {
      const error = { code: -32000, message: 'Playwright ' + host.playwrightVersion + ' is not supported', data: { kind: 'version' } }
      return send({ id: message.id, error })
    }
    issued += 1
    return send({ id: message.id, result: { handle: { n: issued }, protocol: 'cdp', url: 'ws://127.0.0.1:9/hand' } })
  }
  if (message.method === 'release' || message.method === 'shutdown') {
    return send({ id: message.id, result: {} })
  }
  send({ id: message.id, error: { code: -32601, message: message.method + ' is not a method' } })
})
if (behaviour.ignoreStdinClose) setInterval(() => {}, 1000)
else lines.on('close', () => process.exit(0))
`

function writeHandWrittenPlugin(behaviour: HandWritten = {}): { dir: string; ledgerFile: string } {
  const dir = tempDir()
  const manifest = {
    kind: 'remote',
    runs: 'process',
    protocol: 1,
    entry: './main.mjs',
    serves: ['cdp'],
    methods: [],
    options: './options.schema.json',
    settings: './settings.schema.json',
  }
  const packageJson = {
    name: 'agent-qa-plugin-hand-written',
    version: '1.0.0',
    type: 'module',
    'agent-qa': { plugin: manifest },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  writeFileSync(join(dir, 'options.schema.json'), openSchema)
  writeFileSync(join(dir, 'settings.schema.json'), openSchema)
  writeFileSync(
    join(dir, 'main.mjs'),
    HAND_WRITTEN_MAIN.replace('BEHAVIOUR', JSON.stringify(behaviour)),
  )
  return { dir, ledgerFile: join(dir, 'ledger.jsonl') }
}

function editManifest(dir: string, edit: (manifest: Record<string, unknown>) => void) {
  const file = join(dir, 'package.json')
  const packageJson = JSON.parse(readFileSync(file, 'utf8')) as {
    'agent-qa': { plugin: Record<string, unknown> }
  }
  edit(packageJson['agent-qa'].plugin)
  writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`)
}

const checkOf = (report: Awaited<ReturnType<typeof runConformance>>, name: string) =>
  report.checks.find((check) => check.name === name)

describe('runConformance', () => {
  it('passes the scripted plugin on every check, each reported by name', async () => {
    const { dir } = writeScriptedPlugin(tempDir())

    const report = await runConformance({ packageDir: dir, options: { answer } })

    expect(report.checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: 'manifest', ok: true },
      { name: 'handshake', ok: true },
      { name: 'unknown-method', ok: true },
      { name: 'idempotent-release', ok: true },
      { name: 'answered-cancel', ok: true },
      { name: 'clean-stdout', ok: true },
      { name: 'exit-on-stdin-close', ok: true },
    ])
    expect(report.ok).toBe(true)
  })

  it("starts the plugin with agent-qa's environment, not the runner's", async () => {
    const { dir } = writeScriptedPlugin(tempDir())
    const ledgerFile = join(dir, 'ledger.jsonl')
    process.env.ACME_API_KEY = 'from-the-runner'
    try {
      await runConformance({
        packageDir: dir,
        quick: true,
        options: { ledgerFile, answer, recordProcess: true },
      })
    } finally {
      delete process.env.ACME_API_KEY
    }

    const envKeys = readLedger(ledgerFile)[0]?.envKeys
    expect(envKeys).toContain('PATH')
    expect(envKeys).not.toContain('ACME_API_KEY')
  })

  it('fails clean-stdout for a plugin that prints to stdout', async () => {
    const { dir } = writeHandWrittenPlugin({ printHello: true })

    const report = await runConformance({ packageDir: dir, options: {} })

    expect(report.ok).toBe(false)
    expect(checkOf(report, 'clean-stdout')).toMatchObject({ ok: false })
    expect(checkOf(report, 'clean-stdout')?.detail).toContain('hello')
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      'clean-stdout',
    ])
  })

  it('fails exit-on-stdin-close for a plugin that keeps running after stdin closes', async () => {
    const { dir } = writeHandWrittenPlugin({ ignoreStdinClose: true })

    const report = await runConformance({ packageDir: dir, options: {} })

    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      'exit-on-stdin-close',
    ])
  })

  it('passes a well-formed initialize refusal in quick mode and never acquires', async () => {
    const { dir } = writeScriptedPlugin(tempDir())
    const ledgerFile = join(dir, 'ledger.jsonl')

    const report = await runConformance({
      packageDir: dir,
      quick: true,
      options: {
        ledgerFile,
        answer,
        script: {
          initialize: {
            error: { kind: 'refused', message: 'region is not offered', path: 'options.region' },
          },
        },
      },
    })

    expect(report.checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: 'manifest', ok: true },
      { name: 'handshake', ok: true },
      { name: 'unknown-method', ok: true },
      { name: 'clean-stdout', ok: true },
      { name: 'exit-on-stdin-close', ok: true },
    ])
    expect(checkOf(report, 'handshake')?.detail).toContain('region is not offered')
    expect(readLedger(ledgerFile).map((line) => line.method)).toEqual(['initialize'])
  })

  it('fails the same refusal outside quick mode', async () => {
    const { dir } = writeScriptedPlugin(tempDir())

    const report = await runConformance({
      packageDir: dir,
      options: {
        answer,
        script: { initialize: { error: { kind: 'refused', message: 'region is not offered' } } },
      },
    })

    expect(checkOf(report, 'handshake')).toMatchObject({ ok: false })
    expect(report.ok).toBe(false)
  })

  it('fails manifest with the path of the issue when the manifest lacks methods', async () => {
    const { dir } = writeScriptedPlugin(tempDir())
    editManifest(dir, (manifest) => {
      delete manifest.methods
    })

    const report = await runConformance({ packageDir: dir, options: { answer } })

    expect(report.ok).toBe(false)
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({ name: 'manifest', ok: false })
    expect(report.checks[0]?.detail).toContain('agent-qa.plugin.methods')
  })

  it('fails manifest and starts nothing when the entry resolves outside the package', async () => {
    const root = tempDir()
    const dir = join(root, 'plugin')
    mkdirSync(dir)
    writeScriptedPlugin(dir)
    const marker = join(root, 'ran')
    writeFileSync(
      join(root, 'escape.mjs'),
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`,
    )
    editManifest(dir, (manifest) => {
      manifest.entry = '../escape.mjs'
    })

    const report = await runConformance({ packageDir: dir, options: { answer } })

    expect(report.checks).toEqual([
      {
        name: 'manifest',
        ok: false,
        detail: 'entry ../escape.mjs does not resolve inside the package',
      },
    ])
    expect(existsSync(marker)).toBe(false)
  })

  it('fails manifest when a schema file is not draft 2020-12', async () => {
    const { dir } = writeScriptedPlugin(tempDir())
    writeFileSync(
      join(dir, 'settings.schema.json'),
      JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }),
    )

    const report = await runConformance({ packageDir: dir, options: { answer } })

    expect(report.checks[0]).toMatchObject({ name: 'manifest', ok: false })
    expect(report.checks[0]?.detail).toContain('not JSON Schema draft 2020-12')
  })

  it('sends the default host identity and passes a version-checking plugin only with a host override', async () => {
    const refused = writeHandWrittenPlugin({ requirePlaywright: '1.63.0' })

    const withDefaults = await runConformance({ packageDir: refused.dir, options: {} })

    expect(checkOf(withDefaults, 'idempotent-release')).toMatchObject({ ok: false })
    expect(checkOf(withDefaults, 'idempotent-release')?.detail).toContain('kind version')
    const initialize = readLedger(refused.ledgerFile).find((line) => line.method === 'initialize')
    expect(initialize?.params).toMatchObject({
      protocolVersions: [1],
      host: {
        pid: process.pid,
        agentQaVersion: kitVersion,
        playwrightVersion: 'unknown',
        webdriverioVersion: 'unknown',
      },
    })

    const accepted = writeHandWrittenPlugin({ requirePlaywright: '1.63.0' })
    const withOverride = await runConformance({
      packageDir: accepted.dir,
      options: {},
      host: { playwrightVersion: '1.63.0' },
    })

    expect(withOverride.checks.every((check) => check.ok)).toBe(true)
    expect(withOverride.ok).toBe(true)
    const overridden = readLedger(accepted.ledgerFile).find((line) => line.method === 'initialize')
    expect(overridden?.params).toMatchObject({
      host: { pid: process.pid, agentQaVersion: kitVersion, playwrightVersion: '1.63.0' },
    })
  })
})

describe('expectManifestCurrent', () => {
  const definitionWith = (check: boolean) =>
    definePlugin({
      options: z.strictObject({ region: z.string().optional() }),
      settings: z.strictObject({}),
      serves: ['cdp'],
      acquire: () => ({ handle: 'a', protocol: 'cdp', url: 'ws://127.0.0.1:1/a' }),
      release: () => {},
      ...(check ? { check: () => ({ state: 'ok' as const, lines: [] }) } : {}),
    })

  it('accepts a package.json whose manifest the emitter wrote from the same definition', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), '{ "name": "@acme/agent-qa-plugin-lab" }\n')
    emitPluginFiles({ definition: definitionWith(true), packageDir: dir })

    expect(() => expectManifestCurrent(dir, definitionWith(true))).not.toThrow()
  })

  it('names the manifest fields that differ from the definition', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), '{ "name": "@acme/agent-qa-plugin-lab" }\n')
    emitPluginFiles({ definition: definitionWith(true), packageDir: dir })

    expect(() => expectManifestCurrent(dir, definitionWith(false))).toThrow(
      "package.json's agent-qa.plugin differs from the definition in methods",
    )
  })
})
