import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

import type {
  PlaygroundAppFetch,
  PlaygroundAppRequest,
  PlaygroundAppSource,
} from '../commands/playground-app.js'
import {
  PLAYGROUND_APP_PIN,
  playgroundAppUrl,
  type PlaygroundAppFile,
  type PlaygroundAppPin,
} from '../commands/playground-app-pin.js'
import type {
  CommandRunner,
  ProjectIo,
  RunOptions,
  RunResult,
} from '../commands/project-host.js'

const roots: string[] = []

function tracked(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix))
  roots.push(folder)
  return folder
}

export function tempProject(label: string): { root: string; home: string } {
  const root = tracked(`agent-qa-${label}-`)
  mkdirSync(join(root, '.git'))
  return { root, home: tracked(`agent-qa-${label}-home-`) }
}

export function cleanupTempProjects(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export interface RunnerCall {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: string
}

export type FakeRunner = CommandRunner & { calls: RunnerCall[] }

export function fakeRunner(
  script: (call: {
    command: string
    args: readonly string[]
    options: RunOptions
  }) => RunResult | Promise<RunResult> = () => ({ code: 0, signal: null, output: '' }),
): FakeRunner {
  const calls: RunnerCall[] = []
  const run: CommandRunner = async (command, args, options) => {
    calls.push({
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
    })
    return await script({ command, args, options })
  }
  return Object.assign(run, { calls })
}

export interface FakePlaygroundApp {
  source: PlaygroundAppSource & { pin: PlaygroundAppPin }
  requests: PlaygroundAppRequest[]
  bytes: { android: Uint8Array; ios: Uint8Array }
}

function pinnedTo(file: PlaygroundAppFile, bytes: Uint8Array): PlaygroundAppFile {
  return {
    file: file.file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

export interface ZipFixtureEntry {
  name: string
  bytes: Uint8Array
  // Written into the upper 16 bits of the external attributes, as a Unix zip does.
  mode?: number
  deflate?: boolean
  flags?: number
  method?: number
  size?: number
}

export interface ZipFixtureArchive {
  count?: number
  offset?: number
}

export function buildZip(
  entries: readonly ZipFixtureEntry[],
  archive: ZipFixtureArchive = {},
): Uint8Array {
  const records: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.deflate ? deflateRawSync(entry.bytes) : Buffer.from(entry.bytes)
    const flags = entry.flags ?? 0
    const method = entry.method ?? (entry.deflate ? 8 : 0)
    const size = entry.size ?? entry.bytes.byteLength
    const crc = crc32(entry.bytes)
    const mode = entry.mode ?? (entry.name.endsWith('/') ? 0o40755 : 0o100644)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.byteLength, 26)
    records.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.byteLength, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.byteLength, 28)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)

    offset += local.byteLength + name.byteLength + data.byteLength
  }
  const listing = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(archive.count ?? entries.length, 8)
  end.writeUInt16LE(archive.count ?? entries.length, 10)
  end.writeUInt32LE(listing.byteLength, 12)
  end.writeUInt32LE(archive.offset ?? offset, 16)
  return new Uint8Array(Buffer.concat([...records, listing, end]))
}

// The small simulator build the fake answers with: folders, a stored file, a deflated file and
// an executable, all under Playground.app/ as in the real archive.
export function fakePlaygroundIosEntries(): ZipFixtureEntry[] {
  const text = (value: string) => new TextEncoder().encode(value)
  return [
    { name: 'Playground.app/', bytes: new Uint8Array(), mode: 0o40755 },
    {
      name: 'Playground.app/Info.plist',
      bytes: text('a stand-in for the Info.plist\n'),
      mode: 0o100644,
    },
    {
      name: 'Playground.app/main.jsbundle',
      bytes: text('a stand-in for the JavaScript bundle\n'.repeat(8)),
      mode: 0o100644,
      deflate: true,
    },
    { name: 'Playground.app/Frameworks/', bytes: new Uint8Array(), mode: 0o40755 },
    {
      name: 'Playground.app/Frameworks/hermesvm.framework/',
      bytes: new Uint8Array(),
      mode: 0o40755,
    },
    {
      name: 'Playground.app/Frameworks/hermesvm.framework/hermesvm',
      bytes: text('a stand-in for an executable\n'),
      mode: 0o100755,
    },
  ]
}

// A few bytes stand in for the APK and a small zip for the simulator build, and the pin is the
// real one with their sha256 and size.
export function fakePlaygroundApp(
  answers: { android?: Uint8Array | Error; ios?: Uint8Array | Error } = {},
): FakePlaygroundApp {
  const bytes = {
    android: new TextEncoder().encode('a stand-in for the Playground APK\n'),
    ios: buildZip(fakePlaygroundIosEntries()),
  }
  const pin: PlaygroundAppPin = {
    ...PLAYGROUND_APP_PIN,
    android: pinnedTo(PLAYGROUND_APP_PIN.android, bytes.android),
    ios: pinnedTo(PLAYGROUND_APP_PIN.ios, bytes.ios),
  }
  const requests: PlaygroundAppRequest[] = []
  const fetch: PlaygroundAppFetch = async (request) => {
    requests.push(request)
    const runtime = (['android', 'ios'] as const).find(
      (name) => request.url === playgroundAppUrl(pin, name),
    )
    if (runtime === undefined) throw new Error(`no Playground file is at ${request.url}`)
    const answer = answers[runtime] ?? bytes[runtime]
    if (answer instanceof Error) throw answer
    return answer
  }
  return { source: { fetch, pin }, requests, bytes }
}

// A running agent-qa whose package.json names its bin, readable where node:fs is mocked.
export function runningAgentQa(
  io: ProjectIo,
  dir = '/running/agent-qa',
): { io: ProjectIo; runningPackageDir: string } {
  const manifest = join(dir, 'package.json')
  const text = `${JSON.stringify({ name: 'agent-qa', bin: { 'agent-qa': 'dist/cli.js' } })}\n`
  return {
    runningPackageDir: dir,
    io: { ...io, readText: (path) => (path === manifest ? text : io.readText(path)) },
  }
}

export function skillFolderFiles(
  name: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const files: Record<string, string> = {
    [`skills/${name}/SKILL.md`]: [
      '---',
      `name: ${name}`,
      `description: Use when a test needs ${name}, with a description long enough that a YAML writer would fold it at eighty columns if it were allowed to.`,
      'metadata:',
      `  short-description: ${name} in short`,
      '---',
      '',
      `# ${name}`,
      '',
      'The body stays as it is.',
      '',
    ].join('\n'),
  }
  for (const [path, content] of Object.entries(extra)) files[`skills/${name}/${path}`] = content
  return files
}

export function writeInstalledPackage(
  dir: string,
  name: string,
  version: string,
  extra: { packageJson?: Record<string, unknown>; files?: Record<string, string> } = {},
): string {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  const manifest = join(packageDir, 'package.json')
  writeFileSync(manifest, `${JSON.stringify({ name, version, ...extra.packageJson }, null, 2)}\n`)
  for (const [path, content] of Object.entries(extra.files ?? {})) {
    const file = join(packageDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return manifest
}

const EMPTY_OBJECT_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {},
  additionalProperties: false,
})

// The entry throws, so code that ran the plugin instead of reading its files would fail loudly.
export function writeRemotePluginPackage(
  root: string,
  name: string,
  version: string,
  extra: { manifest?: Record<string, unknown>; files?: Record<string, string> } = {},
): string {
  const manifest = {
    kind: 'remote',
    runs: 'process',
    protocol: 1,
    entry: './dist/main.js',
    serves: ['playwright'],
    methods: [],
    options: './dist/options.schema.json',
    settings: './dist/settings.schema.json',
    skill: './skill',
    ...extra.manifest,
  }
  return join(
    writeInstalledPackage(root, name, version, {
      packageJson: { 'agent-qa': { plugin: manifest } },
      files: {
        'dist/main.js': "throw new Error('plugin code ran')\n",
        'dist/options.schema.json': EMPTY_OBJECT_SCHEMA,
        'dist/settings.schema.json': EMPTY_OBJECT_SCHEMA,
        ...extra.files,
      },
    }),
    '..',
  )
}
