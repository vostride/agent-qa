import { EventEmitter } from 'node:events'
import { constants, existsSync, readFileSync, statSync } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseAllDocuments, parse as parseYaml } from 'yaml'
import {
  parseSuiteFile,
  parseTestFile,
  resolveWorkspacePaths,
  type ResolvedWorkspacePaths,
} from '@vostride/agent-qa-core'
import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'

import { DashboardDatabase } from '../db/database.js'
import type { ExecutionBackend } from '../execution/execution-backend.js'
import { startServer } from '../server/server.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { TestFileManager } from '../tests/test-file-manager.js'

// 2026-10-18 (444-33, D-65): reading the test or suite list never damages a file or a save racing it.
// 2026-10-18 (444-35, D-66): a read after a save or delete sees it; empty, unnamed and long-named files list truthfully.
// 2026-10-18 (444-36, D-67): an id write keeps a ---led file one document, and a key's value is read from its own line.
// 2026-10-19 (444-37, D-68): a file that parses is read from its mapping, and an id write lands only if it parses to the old mapping plus the id.

type Hold = { suffix: string; content: string | null; reach: () => void; gate: Promise<void>; release: () => void }

// An armed observer reads each matching file in a loop while its write runs, so every observed
// read overlaps the write it checks. The write settles on its own; a cell awaits `reads`.
type WriteObserver = {
  matches: (absolutePath: string) => boolean
  seen: (absolutePath: string, text: string | null) => void
  failed: (absolutePath: string, error: unknown) => void
}

const fileWrites = vi.hoisted(() => ({
  hold: undefined as Hold | undefined,
  holds: [] as Hold[],
  inProgress: new Map<string, number>(),
  lockAsks: [] as string[],
  observer: undefined as WriteObserver | undefined,
  reads: new Set<Promise<void>>(),
  aborted: false,
}))

vi.mock('../tests/replace-file-atomic.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tests/replace-file-atomic.js')>()
  const { readFile: readNow } = await import('node:fs/promises')
  const observed = (observer: WriteObserver, absolutePath: string, write: Promise<void>): Promise<void> => {
    let writing = true
    const settled = write.finally(() => {
      writing = false
    })
    const reads = (async () => {
      try {
        do {
          let text: string | null
          try {
            text = await readNow(absolutePath, 'utf-8')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
            text = null
          }
          observer.seen(absolutePath, text)
        } while (writing && !fileWrites.aborted)
      } catch (error) {
        observer.failed(absolutePath, error)
      }
    })()
    fileWrites.reads.add(reads)
    void reads.then(() => fileWrites.reads.delete(reads))
    return settled
  }
  return {
    ...real,
    replaceFileAtomic: async (absolutePath: string, content: string): Promise<void> => {
      fileWrites.inProgress.set(absolutePath, (fileWrites.inProgress.get(absolutePath) ?? 0) + 1)
      try {
        const hold = fileWrites.hold
        if (hold !== undefined && absolutePath.endsWith(hold.suffix)) {
          fileWrites.hold = undefined
          hold.content = content
          hold.reach()
          await hold.gate
        }
        const observer = fileWrites.observer
        if (observer?.matches(absolutePath) === true && !fileWrites.aborted) {
          await observed(observer, absolutePath, real.replaceFileAtomic(absolutePath, content))
        } else {
          await real.replaceFileAtomic(absolutePath, content)
        }
      } finally {
        const left = (fileWrites.inProgress.get(absolutePath) ?? 1) - 1
        if (left > 0) fileWrites.inProgress.set(absolutePath, left)
        else fileWrites.inProgress.delete(absolutePath)
      }
    },
    createPathLock: (): ReturnType<typeof real.createPathLock> => {
      const lock = real.createPathLock()
      return (key, work) => {
        fileWrites.lockAsks.push(key)
        return lock(key, work)
      }
    },
  }
})

function holdReplace(suffix: string): { reached: Promise<void>; release: () => void; readonly content: string | null } {
  let reach = (): void => undefined
  let release = (): void => undefined
  const reachedNow = new Promise<void>((resolve) => {
    reach = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const hold: Hold = { suffix, content: null, reach, gate, release }
  fileWrites.hold = hold
  fileWrites.holds.push(hold)
  let timer: ReturnType<typeof setTimeout> | undefined
  const reached = Promise.race([
    reachedNow,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the held id write for ${suffix} never started`)), 5_000)
    }),
  ]).finally(() => clearTimeout(timer))
  return {
    reached,
    release,
    get content() {
      return hold.content
    },
  }
}

async function waitUntil(predicate: () => boolean, label: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${label}: not within ${String(ms)} ms`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

class IdleBackend extends EventEmitter {
  execute = (): void => undefined
  kill = (): boolean => false
  killAll = (): void => undefined
  getActiveExecutions = (): [] => []
}

type Kind = 'test' | 'suite'
type Answer = { status: number; body: any }
type Workspace = { dir: string; configPath: string; paths: ResolvedWorkspacePaths }

let root: string
const started: Array<Awaited<ReturnType<typeof startServer>>> = []

beforeEach(async () => {
  fileWrites.aborted = false
  root = await mkdtemp(join(tmpdir(), 'agent-qa-444-list-write-safe-'))
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(async () => {
  // Nothing may still write under root when it is removed: stop the loops, let every write land,
  // and wait for each server to finish closing.
  fileWrites.aborted = true
  for (const hold of fileWrites.holds.splice(0)) hold.release()
  fileWrites.hold = undefined
  let draining: Error | undefined
  try {
    await waitUntil(() => fileWrites.inProgress.size === 0, 'teardown waits for in-progress writes', 10_000)
  } catch {
    draining = new Error(`writes still in progress at teardown: ${[...fileWrites.inProgress.keys()].join(', ')}`)
  }
  await Promise.all([...fileWrites.reads])
  fileWrites.observer = undefined
  fileWrites.inProgress.clear()
  fileWrites.lockAsks.length = 0
  await Promise.all(
    started.splice(0).map(
      (handle) =>
        new Promise<void>((resolve) => {
          if (!handle.server.listening) {
            handle.close()
            resolve()
            return
          }
          handle.server.once('close', () => resolve())
          handle.server.closeAllConnections()
          handle.close()
        }),
    ),
  )
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
  if (draining !== undefined) throw draining
})

function posixOnly(): void {
  if (process.platform === 'win32') throw new Error('POSIX file modes, symlinks and rename required; never skip')
}

async function workspace(name: string): Promise<Workspace> {
  const dir = join(root, name)
  await mkdir(join(dir, 'tests'), { recursive: true })
  await mkdir(join(dir, 'suites'), { recursive: true })
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, 'testDir: tests\n')
  const paths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/*.yaml'],
        suiteMatch: ['suites/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge', commitArtifacts: 'none' },
    },
    configPath,
  })
  return { dir, configPath, paths }
}

async function startDashboard(ws: Workspace): Promise<string> {
  const handle = await startServer({
    declaredSecretMask: (text) => text,
    db: new DashboardDatabase({ dbPath: join(ws.dir, 'runs.db') }),
    port: 0,
    configPath: ws.configPath,
    workspacePaths: ws.paths,
    executionBackend: new IdleBackend() as unknown as ExecutionBackend,
  })
  started.push(handle)
  return `http://127.0.0.1:${String((handle.server.address() as AddressInfo).port)}`
}

async function answer(response: Response): Promise<Answer> {
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, body: type.includes('application/json') ? await response.json() : await response.text() }
}

async function read(url: string): Promise<Answer> {
  return answer(await fetch(url))
}

async function send(url: string, method: 'POST' | 'PUT', payload: unknown): Promise<Answer> {
  return answer(await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
}

function rowsOf(reply: Answer, key: 'files' | 'tests' | 'suites'): Array<Record<string, any>> {
  const rows = reply.body !== null && typeof reply.body === 'object' ? reply.body[key] : undefined
  return Array.isArray(rows) ? rows : []
}

const idField = (kind: Kind): 'testId' | 'suiteId' => (kind === 'test' ? 'testId' : 'suiteId')

function splitIdLine(text: string, kind: Kind): { id: string | null; rest: string; idLines: number } {
  const newline = text.indexOf('\n')
  const first = newline === -1 ? text : text.slice(0, newline)
  const match = first.match(kind === 'test' ? /^test-id: (\S+)$/ : /^suite-id: (\S+)$/)
  const idLines = (text.match(kind === 'test' ? /^test-id:/gm : /^suite-id:/gm) ?? []).length
  return { id: match ? match[1] : null, rest: match ? text.slice(newline + 1) : text, idLines }
}

function oneIdOver(text: string, body: string, kind: Kind): string | null {
  const split = splitIdLine(text, kind)
  return split.id !== null && split.idLines === 1 && split.rest === body ? split.id : null
}

function describeFile(text: string | null, kind: Kind): string {
  if (text === null) return 'absent'
  const split = splitIdLine(text, kind)
  return `${String(text.length)} bytes, ${String(split.idLines)} id lines, first line ${JSON.stringify(text.slice(0, 48))}`
}

function filler(head: string, bytes: number, tag: string): string {
  const lines = [head]
  let size = head.length
  for (let index = 0; size < bytes; index++) {
    const line = `# ${tag} filler line ${String(index)} keeps this file large enough to be written in many chunks\n`
    lines.push(line)
    size += line.length
  }
  return lines.join('')
}

function smallTest(index: number): string {
  const steps = Array.from(
    { length: 12 },
    (_, step) => `  - step ${String(step)} of test ${String(index)} clicks the checkout button and checks the total\n`,
  )
  return `name: Test ${String(index)}\nsteps:\n${steps.join('')}`
}

function smallSuite(index: number): string {
  const notes = Array.from(
    { length: 12 },
    (_, note) => `# suite ${String(index)} note ${String(note)}: the nightly checkout suite runs against staging\n`,
  )
  return `name: Suite ${String(index)}\ntests: []\n${notes.join('')}`
}

const bigTest = (name: string, bytes: number): string =>
  filler(`name: ${name}\ntarget: web\nsteps:\n  - Open the ${name} page\n`, bytes, name)
const bigSuite = (name: string, bytes: number): string => filler(`name: ${name}\ntests: []\n`, bytes, name)

async function tmpFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.filter((entry) => entry.endsWith('.tmp')).sort()
}

const pad = (index: number): string => String(index).padStart(3, '0')
const SAVE_BYTES = 950_000

const idTest = (id: string, name: string): string => `test-id: ${id}\nname: ${name}\ntarget: web\nsteps:\n  - Click a\n`
const idSuite = (id: string, name: string, test: string, testId: string): string =>
  `suite-id: ${id}\nname: ${name}\ntarget: web\ntests:\n  - test: ${test}\n    id: ${testId}\n`

function otherTab(url: string): { settled: () => boolean; answer: Promise<Answer> } {
  let done = false
  const answer = read(url).finally(() => {
    done = true
  })
  return { settled: () => done, answer }
}

const asksFor = (suffix: string): number => fileWrites.lockAsks.filter((key) => key.endsWith(suffix)).length

type LayoutRow = {
  row: string
  path: string
  text: string
  outcome: 'minted' | 'kept' | 'left'
  expected: (id: string) => string
  held: string | null
  name: string
  target: string | null
}

function layoutCorpus(kind: Kind, namedId: string): LayoutRow[] {
  const key = kind === 'test' ? 'test-id' : 'suite-id'
  const fileOf = (row: string): string => (kind === 'test' ? `tests/${row}.yaml` : `suites/${row}.suite.yaml`)
  const nameOf = (row: string): string => (kind === 'test' ? `${row}.yaml` : `${row}.suite.yaml`)
  const base = (row: string): string =>
    kind === 'test'
      ? `name: Layout ${row}\ntarget: web\nsteps:\n  - Click a\n`
      : `name: Layout ${row}\ntarget: web\ntests:\n  - test: tests/named.yaml\n    id: ${namedId}\n`
  const crlf = (text: string): string => text.replace(/\n/g, '\r\n')
  const heldId = (): string => (kind === 'test' ? generateTestId() : generateSuiteId())
  const rows: LayoutRow[] = []
  const minted = (row: string, head: string, before: string, after: string, body = base(row)): void => {
    rows.push({
      row,
      path: fileOf(row),
      text: `${head}${body}`,
      outcome: 'minted',
      expected: (id) => `${before}${key}: ${id}${after}${body}`,
      held: null,
      name: `Layout ${row}`,
      target: 'web',
    })
  }
  const fixed = (row: string, text: string, outcome: 'kept' | 'left', held: string | null, named: boolean, target: string | null): void => {
    rows.push({
      row,
      path: fileOf(row),
      text,
      outcome,
      expected: () => text,
      held,
      name: named ? `Layout ${row}` : nameOf(row),
      target,
    })
  }
  minted('bom', '﻿', '﻿', '\n')
  minted('bom-marker', '﻿---\n', '﻿---\n', '\n')
  minted('blank-marker', '\n---\n', '\n---\n', '\n')
  minted('comment-marker', '# header\n---\n', '# header\n---\n', '\n')
  minted('directive-marker', '%YAML 1.2\n---\n', '%YAML 1.2\n---\n', '\n')
  minted('marker-comment', '--- # doc\n', '--- # doc\n', '\n')
  minted('marker-spaces', '---   \n', '---   \n', '\n')
  minted('comment-id', `${key}: # fill later\n`, '', '\n')
  minted('empty-quoted-id', kind === 'test' ? `${key}: ""\n` : `${key}: ''\n`, '', '\n')
  const nextLine = heldId()
  fixed('next-line-id', `${key}:\n  ${nextLine}\n${base('next-line-id')}`, 'kept', nextLine, true, 'web')
  const commented = heldId()
  const commentBody = base('comment-name')
    .replace('name: Layout comment-name', 'name: # TODO')
    .replace('target: web', kind === 'test' ? 'target: # TODO' : 'target: web')
  fixed('comment-name', `${key}: ${commented}\n${commentBody}`, 'kept', commented, false, kind === 'test' ? null : 'web')
  fixed('quoted-key', `"${key}": ""\n${base('quoted-key')}`, 'left', null, true, 'web')
  fixed('spaced-key', `${key} : \n${base('spaced-key')}`, 'left', null, true, 'web')
  fixed(
    'explicit-null',
    `${key}: ${kind === 'test' ? 'null' : '~'}\n${base('explicit-null').replace('name: Layout explicit-null', 'name: ~')}`,
    'left',
    null,
    false,
    'web',
  )
  minted('crlf', '', '', '\r\n', crlf(base('crlf')))
  minted('crlf-marker', '---\r\n', '---\r\n', '\r\n', crlf(base('crlf-marker')))
  minted('plain', '', '', '\n')
  // 2026-10-19 (444.1-11, D-20, D-22): a nested bare id key, the CRLF and byte-order-mark fills, and the unminted flow and indented mappings.
  const listKey = kind === 'test' ? 'steps: [Click a]' : 'tests: []'
  fixed('nested-flow-id', `{name: Layout nested-flow-id, target: web,\nuse: {\n${key}:\n},\n${listKey}}\n`, 'left', null, true, 'web')
  minted('crlf-comment-id', `${key}: # fill later\r\n`, '', '\r\n', crlf(base('crlf-comment-id')))
  minted('bom-comment-id', `﻿${key}: # fill later\n`, '﻿', '\n')
  fixed(
    'flow-mapping',
    `{"name": "Layout flow-mapping", "target": "web", ${kind === 'test' ? '"steps": ["Click a"]' : '"tests": []'}}\n`,
    'left',
    null,
    true,
    'web',
  )
  fixed(
    'indented-mapping',
    `  name: Layout indented-mapping\n  target: web\n${kind === 'test' ? '  steps:\n    - Click a\n' : '  tests: []\n'}`,
    'left',
    null,
    true,
    'web',
  )
  return rows
}

async function checkLayoutCorpus(kind: Kind): Promise<{ rows: number; findings: string[] }> {
  const ws = await workspace(`layout-${kind}`)
  const findings: string[] = []
  const namedId = generateTestId()
  await writeFile(join(ws.dir, 'tests/named.yaml'), idTest(namedId, 'Named'))
  const corpus = layoutCorpus(kind, namedId)
  const key = kind === 'test' ? 'test-id' : 'suite-id'
  const route = kind === 'test' ? 'tests' : 'suites'
  for (const row of corpus) {
    await writeFile(join(ws.dir, row.path), row.text)
    const old: unknown = parseYaml(row.text)
    expect(old !== null && typeof old === 'object' && !Array.isArray(old), `fixture ${row.row} parses to a mapping`).toBe(true)
  }
  const tests = new TestFileManager(ws.paths)
  const suites = new SuiteFileManager(ws.paths, tests)
  const listOnce = async (): Promise<Array<{ path: string; name: string; id: string | null; target: string | null }>> =>
    kind === 'test'
      ? (await tests.list()).map((file) => ({ path: file.path, name: file.name, id: file.testId, target: file.targetName }))
      : (await suites.list()).map((file) => ({ path: file.path, name: file.name, id: file.suiteId, target: null }))
  const first = await listOnce()
  const second = await listOnce()
  const origin = await startDashboard(ws)
  const served = rowsOf(await read(`${origin}/api/${route}`), 'files')

  let rows = 0
  for (const row of corpus) {
    rows++
    const say = (text: string): void => {
      findings.push(`(${row.row}) ${text}`)
    }
    const listed = first.find((file) => file.path === row.path)
    const again = second.find((file) => file.path === row.path)
    const id = listed?.id ?? null
    const disk = await readFile(join(ws.dir, row.path), 'utf-8')
    if (listed === undefined) say('the first list does not name the file')
    if ((again?.id ?? null) !== id) say(`the second list names ${JSON.stringify(again?.id ?? null)}, the first ${JSON.stringify(id)}`)
    if (listed !== undefined && listed.name !== row.name) say(`listed the name ${JSON.stringify(listed.name)}, not ${JSON.stringify(row.name)}`)
    if (kind === 'test' && listed !== undefined && listed.target !== row.target) {
      say(`listed the target ${JSON.stringify(listed.target)}, not ${JSON.stringify(row.target)}`)
    }
    const servedId = served.find((file) => file.path === row.path)?.[idField(kind)] ?? null

    if (row.outcome === 'left') {
      if (id !== null) say(`listed the id ${JSON.stringify(id)}, not null`)
      if (servedId !== null) say(`GET /api/${route} listed the id ${JSON.stringify(servedId)}, not null`)
      if (disk !== row.text) say(`was written: reads ${JSON.stringify(disk.slice(0, 80))}`)
      continue
    }

    const want = row.outcome === 'kept' ? row.held : id
    if (id === null) say('listed no id')
    if (row.outcome === 'kept' && id !== row.held) say(`listed the id ${JSON.stringify(id)}, not the held ${JSON.stringify(row.held)}`)
    if (servedId !== want) say(`GET /api/${route} listed the id ${JSON.stringify(servedId)}, not ${JSON.stringify(want)}`)
    if (want === null) continue
    const expected = row.expected(want)
    if (disk !== expected) say(`reads ${JSON.stringify(disk.slice(0, 80))}, not ${JSON.stringify(expected.slice(0, 80))}`)
    let parsed: unknown
    try {
      parsed = parseYaml(disk)
    } catch (err) {
      say(`stopped parsing: ${(err as Error).message.split('\n')[0]}`)
    }
    if (row.outcome === 'minted') {
      const old = parseYaml(row.text) as Record<string, unknown>
      if (!isDeepStrictEqual(parsed, { ...old, [key]: want })) say(`parses to ${JSON.stringify(parsed)}, not the old mapping plus the id`)
      const documents = parseAllDocuments(disk).length
      if (documents !== 1) say(`holds ${String(documents)} YAML documents`)
      if (row.text.includes('\r\n') ? /(?<!\r)\n/.test(disk) : disk.includes('\r')) say('mixes line endings')
    }
    if (row.outcome === 'minted' || row.row === 'next-line-id') {
      if (kind === 'test') {
        const product = parseTestFile(disk, row.path)
        if (product.errors.length > 0 || product.tests.length !== 1 || product.tests[0]['test-id'] !== want) {
          say(
            `parseTestFile read ${String(product.tests.length)} tests and ${String(product.errors.length)} errors${product.errors.length > 0 ? `, first: ${product.errors[0].message.split('\n')[0]}` : ''}`,
          )
        }
      } else {
        try {
          const suite = (await parseSuiteFile(join(ws.dir, row.path))) as Record<string, unknown>
          if (suite['suite-id'] !== want) say(`parseSuiteFile read the id ${String(suite['suite-id'])}`)
        } catch (err) {
          say(`parseSuiteFile refused it: ${(err as Error).message.replace(ws.dir, '<ws>').replace(/\s+/g, ' ').slice(0, 160)}`)
        }
      }
    }
    const found = kind === 'test' ? await tests.findByTestId(want) : await suites.findBySuiteId(want)
    if (found?.path !== row.path) say(`find by ${want} answered ${JSON.stringify(found?.path ?? null)}`)
    const opened = await read(`${origin}/api/${route}/${encodeURIComponent(want)}`)
    if (opened.status !== 200 || opened.body?.path !== row.path) say(`GET /api/${route}/:id answered ${String(opened.status)}`)
  }
  for (const row of corpus.filter((entry) => entry.outcome === 'left')) {
    const after = await readFile(join(ws.dir, row.path), 'utf-8')
    if (after !== row.text) findings.push(`(${row.row}) was written by the time the ids were opened: reads ${JSON.stringify(after.slice(0, 80))}`)
    try {
      parseYaml(after)
    } catch (err) {
      findings.push(`(${row.row}) stopped parsing: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  return { rows, findings }
}

type GuardLeg = { status: number; error: string | null; written: boolean | 'other bytes'; valid: boolean }

// 2026-10-19 (444.1-11, D-19, D-20, D-21): each body is valid under parseTestFile, so a refusal is the guard's and not validate()'s.
async function guardLegs(name: string, body: (firstId: string) => string): Promise<{ POST: GuardLeg; PUT: GuardLeg }> {
  const ws = await workspace(name)
  const savedId = generateTestId()
  const saved = idTest(savedId, 'Guard')
  const savedPath = join(ws.dir, 'tests/guard.yaml')
  const createdPath = join(ws.dir, 'tests/new.yaml')
  await writeFile(savedPath, saved)
  const origin = await startDashboard(ws)
  const valid = (content: string): boolean => {
    const product = parseTestFile(content, '<editor>')
    return product.errors.length === 0 && product.tests.length > 0
  }
  const posted = body(generateTestId())
  const created = await send(`${origin}/api/tests`, 'POST', { path: 'tests/new.yaml', content: posted })
  const createdNow = existsSync(createdPath) ? await readFile(createdPath, 'utf-8') : null
  const put = body(savedId)
  const updated = await send(`${origin}/api/tests/${encodeURIComponent(savedId)}`, 'PUT', { content: put })
  const savedNow = await readFile(savedPath, 'utf-8')
  return {
    POST: {
      status: created.status,
      error: created.body?.error ?? null,
      written: createdNow === null ? false : createdNow === posted ? true : 'other bytes',
      valid: valid(posted),
    },
    PUT: {
      status: updated.status,
      error: updated.body?.error ?? null,
      written: savedNow === saved ? false : savedNow === put ? true : 'other bytes',
      valid: valid(put),
    },
  }
}

const SHOWN = '[secret:API_TOKEN]'

describe('C444-LIST-WRITE-SAFE', () => {
  it('the Tests and Suites page reads sent together leave every id-less file whole under one id line, and every listed id opens', async () => {
    const lost: string[] = []
    const mismatched: string[] = []
    const unopened: string[] = []

    for (let round = 0; round < 5; round++) {
      const ws = await workspace(`round-${String(round)}`)
      const files: Array<{ kind: Kind; path: string; body: string }> = []
      for (let index = 0; index < 20; index++) {
        files.push({ kind: 'test', path: `tests/t${pad(index)}.yaml`, body: smallTest(index) })
        files.push({ kind: 'suite', path: `suites/s${pad(index)}.suite.yaml`, body: smallSuite(index) })
      }
      for (const file of files) await writeFile(join(ws.dir, file.path), file.body)
      const origin = await startDashboard(ws)

      const [testSummaries, testList, suiteSummaries, suiteList] = await Promise.all([
        read(`${origin}/api/analytics/test-summaries`),
        read(`${origin}/api/tests`),
        read(`${origin}/api/analytics/suite-summaries`),
        read(`${origin}/api/suites`),
      ])
      const replies = {
        test: { list: rowsOf(testList, 'files'), summaries: rowsOf(testSummaries, 'tests') },
        suite: { list: rowsOf(suiteList, 'files'), summaries: rowsOf(suiteSummaries, 'suites') },
      }
      const named = [
        ['GET /api/analytics/test-summaries', testSummaries, replies.test.summaries, 'test'],
        ['GET /api/tests', testList, replies.test.list, 'test'],
        ['GET /api/analytics/suite-summaries', suiteSummaries, replies.suite.summaries, 'suite'],
        ['GET /api/suites', suiteList, replies.suite.list, 'suite'],
      ] as const
      for (const [label, reply, rows, kind] of named) {
        expect(reply.status, `round ${String(round)}: ${label}`).toBe(200)
        expect(
          rows.map((row) => row.path).sort(),
          `round ${String(round)}: ${label} names all 20 files of its kind`,
        ).toEqual(files.filter((file) => file.kind === kind).map((file) => file.path).sort())
      }

      for (const file of files) {
        const disk = await readFile(join(ws.dir, file.path), 'utf-8')
        if (oneIdOver(disk, file.body, file.kind) === null) {
          lost.push(`round ${String(round)}: ${file.path} (${describeFile(disk, file.kind)})`)
        }
        const onDisk = splitIdLine(disk, file.kind).id
        const field = idField(file.kind)
        const listed = replies[file.kind].list.find((row) => row.path === file.path)?.[field] ?? null
        const summarized = replies[file.kind].summaries.find((row) => row.path === file.path)?.[field] ?? null
        if (listed !== onDisk || summarized !== onDisk) {
          mismatched.push(
            `round ${String(round)}: ${file.path} disk ${String(onDisk)} list ${String(listed)} summary ${String(summarized)}`,
          )
        }
        for (const id of new Set([listed, summarized])) {
          if (id === null) {
            unopened.push(`round ${String(round)}: ${file.path} listed with no id`)
            continue
          }
          const route = file.kind === 'test' ? 'tests' : 'suites'
          const opened = await read(`${origin}/api/${route}/${encodeURIComponent(id)}`)
          if (opened.status !== 200 || opened.body?.path !== file.path) {
            unopened.push(`round ${String(round)}: ${file.path} ${id} answered ${String(opened.status)}`)
          }
        }
      }
    }

    expect(
      { lost, mismatched, unopened },
      'every id-less file keeps its body under one id line, the answers name the id on disk, and every listed id opens',
    ).toEqual({ lost: [], mismatched: [], unopened: [] })
  })

  it('two list calls at once on one manager name the same id for each file, and the file holds one id line', async () => {
    // (a) the test manager, with a file that is only whitespace
    const a = await workspace('a')
    const testBodies = new Map<string, string>()
    for (let index = 0; index < 10; index++) testBodies.set(`tests/t${pad(index)}.yaml`, smallTest(index))
    testBodies.set('tests/blank.yaml', '  \n\t\n')
    for (const [path, body] of testBodies) await writeFile(join(a.dir, path), body)
    const tests = new TestFileManager(a.paths)
    const [firstTests, secondTests] = await Promise.all([tests.list(), tests.list()])
    expect(
      Object.fromEntries(secondTests.map((file) => [file.path, file.testId])),
      '(a) both test listings name the same id for each path',
    ).toEqual(Object.fromEntries(firstTests.map((file) => [file.path, file.testId])))
    expect(secondTests.map((file) => file.path), '(a) in the same order').toEqual(firstTests.map((file) => file.path))
    expect(firstTests.map((file) => file.path).sort(), '(a) every test file is listed').toEqual([...testBodies.keys()].sort())
    const modified = firstTests.map((file) => file.modified)
    expect(modified, '(a) newest modified first, as one list() gives').toEqual([...modified].sort().reverse())
    for (const file of firstTests) {
      if (file.path === 'tests/blank.yaml') continue
      expect(file.testId, `(a) ${file.path} is listed with an id`).not.toBeNull()
      const disk = await readFile(join(a.dir, file.path), 'utf-8')
      expect(oneIdOver(disk, testBodies.get(file.path)!, 'test'), `(a) ${file.path}: ${describeFile(disk, 'test')}`).toBe(
        file.testId,
      )
    }
    for (const [label, listing] of [['first', firstTests], ['second', secondTests]] as const) {
      expect(
        listing.find((file) => file.path === 'tests/blank.yaml')?.testId,
        `(a, IN-20) the ${label} listing names no id for tests/blank.yaml, which holds only whitespace`,
      ).toBeNull()
    }
    expect(
      await readFile(join(a.dir, 'tests/blank.yaml'), 'utf-8'),
      '(a, IN-20) the whitespace survives byte for byte, with no id line',
    ).toBe('  \n\t\n')

    // (b) the suite manager
    const b = await workspace('b')
    const suiteBodies = new Map<string, string>()
    for (let index = 0; index < 10; index++) suiteBodies.set(`suites/s${pad(index)}.suite.yaml`, smallSuite(index))
    for (const [path, body] of suiteBodies) await writeFile(join(b.dir, path), body)
    const suites = new SuiteFileManager(b.paths, new TestFileManager(b.paths))
    const [firstSuites, secondSuites] = await Promise.all([suites.list(), suites.list()])
    expect(
      Object.fromEntries(secondSuites.map((file) => [file.path, file.suiteId])),
      '(b) both suite listings name the same id for each path',
    ).toEqual(Object.fromEntries(firstSuites.map((file) => [file.path, file.suiteId])))
    expect(secondSuites.map((file) => file.path), '(b) in the same order').toEqual(firstSuites.map((file) => file.path))
    expect(firstSuites.map((file) => file.path).sort(), '(b) every suite file is listed').toEqual(
      [...suiteBodies.keys()].sort(),
    )
    for (const file of firstSuites) {
      expect(file.suiteId, `(b) ${file.path} is listed with an id`).not.toBeNull()
      const disk = await readFile(join(b.dir, file.path), 'utf-8')
      expect(oneIdOver(disk, suiteBodies.get(file.path)!, 'suite'), `(b) ${file.path}: ${describeFile(disk, 'suite')}`).toBe(
        file.suiteId,
      )
    }

    // (c) a suite resolving its tests beside the test list, on the managers server.ts builds
    const c = await workspace('c')
    const cBodies = new Map<string, string>()
    for (let index = 0; index < 10; index++) cBodies.set(`tests/t${pad(index)}.yaml`, smallTest(index))
    for (const [path, body] of cBodies) await writeFile(join(c.dir, path), body)
    const cTests = new TestFileManager(c.paths)
    const cSuites = new SuiteFileManager(c.paths, cTests)
    const suiteContent = [
      'name: Every test',
      'target: web',
      'tests:',
      ...[...cBodies.keys()].flatMap((path) => [`  - test: ${path}`, `    id: ${generateTestId()}`]),
      '',
    ].join('\n')
    const [validation, cListing] = await Promise.all([cSuites.validate(suiteContent), cTests.list()])
    expect(validation, '(c) the suite naming every test validates').toEqual({ valid: true, errors: [] })
    for (const [path, body] of cBodies) {
      const disk = await readFile(join(c.dir, path), 'utf-8')
      const listed = cListing.find((file) => file.path === path)?.testId ?? null
      expect(listed, `(c) ${path} is listed with an id`).not.toBeNull()
      expect(oneIdOver(disk, body, 'test'), `(c) ${path}: ${describeFile(disk, 'test')}`).toBe(listed)
    }

    // (d) two list calls end to end: the second writes nothing
    const d = await workspace('d')
    const dBodies = new Map<string, string>()
    for (let index = 0; index < 10; index++) dBodies.set(`tests/t${pad(index)}.yaml`, smallTest(index))
    for (const [path, body] of dBodies) await writeFile(join(d.dir, path), body)
    const before = new Map<string, { ino: bigint; mtimeNs: bigint }>()
    for (const path of dBodies.keys()) {
      const s = await stat(join(d.dir, path), { bigint: true })
      before.set(path, { ino: s.ino, mtimeNs: s.mtimeNs })
    }
    const dTests = new TestFileManager(d.paths)
    const snapshot = new Map<string, { ino: bigint; mtimeNs: bigint; bytes: string }>()
    const [dFirst, dSecond] = await dTests.list().then(async (first) => {
      for (const path of dBodies.keys()) {
        const s = statSync(join(d.dir, path), { bigint: true })
        snapshot.set(path, { ino: s.ino, mtimeNs: s.mtimeNs, bytes: readFileSync(join(d.dir, path), 'utf-8') })
      }
      return [first, await dTests.list()] as const
    })
    expect(
      Object.fromEntries(dSecond.map((file) => [file.path, file.testId])),
      '(d) the second list names the ids the first wrote',
    ).toEqual(Object.fromEntries(dFirst.map((file) => [file.path, file.testId])))
    for (const [path, body] of dBodies) {
      const s = await stat(join(d.dir, path), { bigint: true })
      const bytes = await readFile(join(d.dir, path), 'utf-8')
      const was = snapshot.get(path)!
      expect({ ino: s.ino, bytes }, `(d) ${path} is as the first list left it`).toEqual({ ino: was.ino, bytes: was.bytes })
      expect(oneIdOver(bytes, body, 'test'), `(d) ${path} holds one id line over its body`).toBe(
        dFirst.find((file) => file.path === path)?.testId,
      )
      expect(was.ino, `(d) the mint replaced ${path}`).not.toBe(before.get(path)!.ino)
      expect(was.mtimeNs >= before.get(path)!.mtimeNs, `(d) ${path}'s mtime did not go back`).toBe(true)
    }

    // (e) a workspace with no test or suite files
    const e = await workspace('e')
    const eTests = new TestFileManager(e.paths)
    const eSuites = new SuiteFileManager(e.paths, eTests)
    const listing = async (): Promise<string[]> => (await readdir(e.dir, { recursive: true })).sort()
    const eBefore = await listing()
    expect(await Promise.all([eTests.list(), eTests.list(), eSuites.list(), eSuites.list()]), '(e) at once').toEqual([
      [],
      [],
      [],
      [],
    ])
    const oneAfterAnother = [await eTests.list(), await eTests.list(), await eSuites.list(), await eSuites.list()]
    expect(oneAfterAnother, '(e) one after another').toEqual([[], [], [], []])
    expect(await listing(), '(e) nothing is written').toEqual(eBefore)
  })

  it('a reader during an id write never sees an empty or partial file', async () => {
    posixOnly()
    const ws = await workspace('reader')
    const files: Array<{ kind: Kind; path: string; body: string }> = []
    for (let index = 0; index < 4; index++) {
      files.push({ kind: 'test', path: `tests/big${String(index)}.yaml`, body: bigTest(`Big test ${String(index)}`, 3_000_000) })
      files.push({
        kind: 'suite',
        path: `suites/big${String(index)}.suite.yaml`,
        body: bigSuite(`Big suite ${String(index)}`, 3_000_000),
      })
    }
    for (const file of files) await writeFile(join(ws.dir, file.path), file.body)
    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)

    let settled = false
    const partial: string[] = []
    let partialCount = 0
    const readsInFlight = new Map<string, number>()
    const readsDuringIdWrite = new Map<string, number>()
    const readErrors: string[] = []
    const check = (file: (typeof files)[number], text: string | null, by: string): void => {
      if (text === null || (text !== file.body && oneIdOver(text, file.body, file.kind) === null)) {
        partialCount++
        if (partial.length < 40) partial.push(`${by} ${file.path}: ${describeFile(text, file.kind)}`)
      }
    }
    const fileAt = (absolutePath: string) => files.find((file) => absolutePath.endsWith(`/reader/${file.path}`))
    fileWrites.observer = {
      matches: (absolutePath) => fileAt(absolutePath) !== undefined,
      seen: (absolutePath, text) => {
        const file = fileAt(absolutePath)!
        readsDuringIdWrite.set(file.path, (readsDuringIdWrite.get(file.path) ?? 0) + 1)
        check(file, text, 'write-observer')
      },
      failed: (absolutePath, error) => {
        readErrors.push(`${absolutePath}: ${String(error)}`)
      },
    }
    const lists = Promise.all([tests.list(), suites.list()]).finally(() => {
      settled = true
    })
    // One raw reader walks every file for the whole list window, so a write outside replaceFileAtomic
    // is checked too, while only one read at a time competes with the lists for libuv's pool.
    const reader = (async () => {
      while (!settled && !fileWrites.aborted) {
        for (const file of files) {
          const text = await readFile(join(ws.dir, file.path), 'utf-8')
          if (!settled) readsInFlight.set(file.path, (readsInFlight.get(file.path) ?? 0) + 1)
          check(file, text, 'raw reader')
        }
      }
    })()
    const outcomes = await Promise.allSettled([lists, reader])
    await Promise.all([...fileWrites.reads])

    expect(
      [
        ...outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [String(outcome.reason)] : [])),
        ...readErrors,
      ],
      'neither list call nor any reader rejected',
    ).toEqual([])
    expect({ partialCount, partial }, 'no read was neither the whole body nor one id line over it').toEqual({
      partialCount: 0,
      partial: [],
    })
    for (const file of files) {
      expect(readsInFlight.get(file.path) ?? 0, `${file.path} was read by the raw reader while the lists ran`).toBeGreaterThan(0)
    }
    for (const kind of ['test', 'suite'] as const) {
      const during = files.filter((file) => file.kind === kind).map((file) => readsDuringIdWrite.get(file.path) ?? 0)
      expect(
        during.filter((count) => count === 0).length,
        `every ${kind} file's id write went through replaceFileAtomic and was read while it ran (per file: ${during.join(', ')})`,
      ).toBe(0)
    }
    for (const file of files) {
      const disk = await readFile(join(ws.dir, file.path), 'utf-8')
      expect(oneIdOver(disk, file.body, file.kind), `${file.path}: ${describeFile(disk, file.kind)}`).not.toBeNull()
    }
    expect(await tmpFilesUnder(ws.dir), 'no temp file is left').toEqual([])
  })

  it('an id write goes through a symlink to its target and keeps the file mode, and a file it may not write keeps its bytes and gets no id', async () => {
    posixOnly()
    const ws = await workspace('link-mode')
    await mkdir(join(ws.dir, 'real'))
    await writeFile(join(ws.dir, 'umask-probe'), 'probe\n', { mode: 0o666 })
    const probeMode = (await stat(join(ws.dir, 'umask-probe'))).mode & 0o777
    if (probeMode === 0o666) throw new Error('the mode leg needs a umask that changes 0o666; never skip')
    const bodies = {
      test: {
        locked: bigTest('Locked', 2_000),
        private: bigTest('Private', 2_000),
        shared: bigTest('Shared', 2_000),
        linked: bigTest('Linked', 2_000),
      },
      suite: {
        locked: bigSuite('Locked', 2_000),
        private: bigSuite('Private', 2_000),
        shared: bigSuite('Shared', 2_000),
        linked: bigSuite('Linked', 2_000),
      },
    }
    const where = {
      test: {
        locked: 'tests/locked.yaml',
        private: 'tests/private.yaml',
        shared: 'tests/shared.yaml',
        linked: 'tests/linked.yaml',
        real: 'real/linked.yaml',
      },
      suite: {
        locked: 'suites/locked.suite.yaml',
        private: 'suites/private.suite.yaml',
        shared: 'suites/shared.suite.yaml',
        linked: 'suites/linked.suite.yaml',
        real: 'real/linked.suite.yaml',
      },
    }
    const kinds: Kind[] = ['test', 'suite']
    const writable = new Map<Kind, boolean>()
    for (const kind of kinds) {
      await writeFile(join(ws.dir, where[kind].locked), bodies[kind].locked)
      await chmod(join(ws.dir, where[kind].locked), 0o444)
      await writeFile(join(ws.dir, where[kind].private), bodies[kind].private)
      await chmod(join(ws.dir, where[kind].private), 0o640)
      await writeFile(join(ws.dir, where[kind].shared), bodies[kind].shared)
      await chmod(join(ws.dir, where[kind].shared), 0o666)
      await writeFile(join(ws.dir, where[kind].real), bodies[kind].linked)
      await symlink(`../${where[kind].real}`, join(ws.dir, where[kind].linked))
      writable.set(
        kind,
        await access(join(ws.dir, where[kind].locked), constants.W_OK).then(
          () => true,
          () => false,
        ),
      )
    }

    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)
    const [testListing, suiteListing] = await Promise.all([tests.list(), suites.list()])
    const listedId = (kind: Kind, path: string): string | null => {
      const rows: Array<{ path: string; testId?: string | null; suiteId?: string | null }> =
        kind === 'test' ? testListing : suiteListing
      const row = rows.find((candidate) => candidate.path === path)
      expect(row, `${path} is listed`).toBeDefined()
      return (kind === 'test' ? row!.testId : row!.suiteId) ?? null
    }

    // (1) the read-only files
    for (const kind of kinds) {
      const path = where[kind].locked
      const disk = await readFile(join(ws.dir, path), 'utf-8')
      const mode = (await stat(join(ws.dir, path))).mode & 0o777
      if (writable.get(kind)) {
        throw new Error(`${path} is writable by this process, so the read-only leg cannot run; run the cell unprivileged; never skip`)
      }
      expect(disk, `(1) ${path}, which this process may not write, keeps its bytes`).toBe(bodies[kind].locked)
      expect(mode, `(1) ${path} keeps mode 0o444`).toBe(0o444)
      expect(listedId(kind, path), `(1) ${path}, which this process may not write, is listed with no id`).toBeNull()
    }

    // (2) the symlinks
    for (const kind of kinds) {
      const link = join(ws.dir, where[kind].linked)
      expect((await lstat(link)).isSymbolicLink(), `(2) ${where[kind].linked} is still a symlink`).toBe(true)
      expect(await readlink(link), `(2) ${where[kind].linked} keeps its link text`).toBe(`../${where[kind].real}`)
      const disk = await readFile(join(ws.dir, where[kind].real), 'utf-8')
      const id = listedId(kind, where[kind].linked)
      expect(id, `(2) ${where[kind].linked} is listed with an id`).not.toBeNull()
      expect(oneIdOver(disk, bodies[kind].linked, kind), `(2) ${where[kind].real}: ${describeFile(disk, kind)}`).toBe(id)
    }
    expect((await readdir(join(ws.dir, 'real'))).sort(), '(2) real/ holds only the two link targets').toEqual([
      'linked.suite.yaml',
      'linked.yaml',
    ])

    // (3) the 0o640 files
    for (const kind of kinds) {
      const path = where[kind].private
      expect((await stat(join(ws.dir, path))).mode & 0o777, `(3) ${path} keeps mode 0o640`).toBe(0o640)
      const disk = await readFile(join(ws.dir, path), 'utf-8')
      const id = listedId(kind, path)
      expect(id, `(3) ${path} is listed with an id`).not.toBeNull()
      expect(oneIdOver(disk, bodies[kind].private, kind), `(3) ${path}: ${describeFile(disk, kind)}`).toBe(id)
    }

    // (3) the 0o666 files, whose mode the umask would change
    for (const kind of kinds) {
      const path = where[kind].shared
      expect(
        (await stat(join(ws.dir, path))).mode & 0o777,
        `(3) ${path} keeps mode 0o666 (a file created with 0o666 here reads 0o${probeMode.toString(8)})`,
      ).toBe(0o666)
      const disk = await readFile(join(ws.dir, path), 'utf-8')
      const id = listedId(kind, path)
      expect(id, `(3) ${path} is listed with an id`).not.toBeNull()
      expect(oneIdOver(disk, bodies[kind].shared, kind), `(3) ${path}: ${describeFile(disk, kind)}`).toBe(id)
    }

    // (4) no temp file
    expect(await tmpFilesUnder(ws.dir), '(4) no temp file is left').toEqual([])
  })

  it('a save sent with the list reads keeps exactly the saved body under one id line, a delete stays deleted, and no reader sees a partial file', async () => {
    posixOnly()
    const KEPT = 'tests/kept.yaml'
    const BARE = 'tests/bare.yaml'
    const FRESH = 'tests/fresh.yaml'
    const endStates: Array<Record<string, string>> = []
    const keptMisnamed: string[] = []
    const lastMisnamed: string[] = []
    const partial: string[] = []
    let partialCount = 0

    // (h) the editor's saves over HTTP, sent with the page's list reads
    for (let round = 0; round < 5; round++) {
      const ws = await workspace(`save-${String(round)}`)
      const keptId = generateTestId()
      const keptOld = `test-id: ${keptId}\n${bigTest('Kept old', SAVE_BYTES)}`
      const bareOld = bigTest('Bare old', SAVE_BYTES)
      await writeFile(join(ws.dir, KEPT), keptOld)
      await writeFile(join(ws.dir, BARE), bareOld)
      const origin = await startDashboard(ws)

      const savedBody = (id: string, name: string) => `test-id: ${id}\n${bigTest(name, SAVE_BYTES)}`
      const bareId = generateTestId()
      const freshId = generateTestId()
      const saved: Record<string, { id: string; body: string }> = {
        [KEPT]: { id: keptId, body: savedBody(keptId, 'Kept saved') },
        [BARE]: { id: bareId, body: savedBody(bareId, 'Bare saved') },
        [FRESH]: { id: freshId, body: savedBody(freshId, 'Fresh saved') },
      }
      const allowed: Record<string, (text: string | null) => boolean> = {
        [KEPT]: (text) => text === keptOld || text === saved[KEPT].body,
        [BARE]: (text) => text === bareOld || (text !== null && oneIdOver(text, bareOld, 'test') !== null) || text === saved[BARE].body,
        [FRESH]: (text) => text === null || text === saved[FRESH].body,
      }

      let saving = true
      const roundPartial: string[] = []
      const readErrors: string[] = []
      const observedReads = new Map<string, number>()
      const check = (path: string, text: string | null, by: string): void => {
        if (!allowed[path](text)) {
          partialCount++
          if (roundPartial.length < 12) roundPartial.push(`round ${String(round)}: ${by} ${path} ${describeFile(text, 'test')}`)
        }
      }
      const pathAt = (absolutePath: string) =>
        [KEPT, BARE, FRESH].find((path) => absolutePath.endsWith(`/save-${String(round)}/${path}`))
      fileWrites.observer = {
        matches: (absolutePath) => pathAt(absolutePath) !== undefined,
        seen: (absolutePath, text) => {
          const path = pathAt(absolutePath)!
          observedReads.set(path, (observedReads.get(path) ?? 0) + 1)
          check(path, text, 'write-observer')
        },
        failed: (absolutePath, error) => {
          readErrors.push(`round ${String(round)}: ${absolutePath}: ${String(error)}`)
        },
      }
      // The raw readers see a partial file whatever API wrote it; the observer only sees
      // replaceFileAtomic windows.
      const readers = [KEPT, BARE, FRESH].map(async (path) => {
        while (saving && !fileWrites.aborted) {
          let text: string | null
          try {
            text = await readFile(join(ws.dir, path), 'utf-8')
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
            text = null
          }
          check(path, text, 'raw reader')
        }
      })
      const listReads = (async () => {
        const replies: Array<[string, Answer]> = []
        while (saving && !fileWrites.aborted) {
          const [list, summaries] = await Promise.all([read(`${origin}/api/tests`), read(`${origin}/api/analytics/test-summaries`)])
          replies.push(['GET /api/tests', list], ['GET /api/analytics/test-summaries', summaries])
        }
        return replies
      })()
      const sent = Promise.all([
        send(`${origin}/api/tests/${encodeURIComponent(keptId)}`, 'PUT', { content: saved[KEPT].body }),
        send(`${origin}/api/tests`, 'POST', { path: BARE, content: saved[BARE].body }),
        send(`${origin}/api/tests`, 'POST', { path: FRESH, content: saved[FRESH].body }),
      ]).finally(() => {
        saving = false
      })
      const [savesOutcome, listOutcome, ...readerOutcomes] = await Promise.allSettled([sent, listReads, ...readers])
      await Promise.all([...fileWrites.reads])
      fileWrites.observer = undefined
      expect(
        [
          ...[savesOutcome, listOutcome, ...readerOutcomes].flatMap((outcome) =>
            outcome.status === 'rejected' ? [String(outcome.reason)] : [],
          ),
          ...readErrors,
        ],
        `round ${String(round)}: no save, list read, raw reader or write-observer read rejected`,
      ).toEqual([])
      for (const path of [KEPT, BARE, FRESH]) {
        expect(
          observedReads.get(path) ?? 0,
          `round ${String(round)}: ${path}'s save went through replaceFileAtomic and was read during that write`,
        ).toBeGreaterThan(0)
      }
      const saves = savesOutcome.status === 'fulfilled' ? savesOutcome.value : []
      const replies = listOutcome.status === 'fulfilled' ? listOutcome.value : []
      partial.push(...roundPartial)

      expect(
        saves.map((reply) => reply.status),
        `round ${String(round)}: the saves answered ${JSON.stringify(saves.map((reply) => reply.body))}`,
      ).toEqual([200, 201, 201])

      for (const [label, reply] of replies) {
        const rows = rowsOf(reply, label === 'GET /api/tests' ? 'files' : 'tests')
        const kept = rows.find((row) => row.path === KEPT)
        if (reply.status !== 200 || kept?.testId !== keptId) {
          keptMisnamed.push(`round ${String(round)}: ${label} (${String(reply.status)}) named ${String(kept?.testId)}`)
        }
      }
      const last = await read(`${origin}/api/tests`)
      const lastRows = rowsOf(last, 'files')
      const state: Record<string, string> = {}
      for (const path of [KEPT, BARE, FRESH]) {
        const disk = existsSync(join(ws.dir, path)) ? await readFile(join(ws.dir, path), 'utf-8') : null
        state[path] = disk === saved[path].body ? 'saved' : describeFile(disk, 'test')
        const named = lastRows.find((row) => row.path === path)?.testId
        if (named !== saved[path].id) lastMisnamed.push(`round ${String(round)}: ${path} named ${String(named)}`)
      }
      endStates.push(state)
    }

    expect(endStates, '(h) each file holds exactly its saved body after every round').toEqual(
      Array.from({ length: 5 }, () => ({ [KEPT]: 'saved', [BARE]: 'saved', [FRESH]: 'saved' })),
    )
    expect(keptMisnamed, "(h) every list answer during the race named kept's id").toEqual([])
    expect(lastMisnamed, "(h) the last answer names each file's saved id").toEqual([])
    expect({ partialCount, partial }, '(h) no raw read saw a partial file').toEqual({ partialCount: 0, partial: [] })

    for (const kind of ['test', 'suite'] as const) {
      const ws = await workspace(`managers-${kind}`)
      const bare = kind === 'test' ? BARE : 'suites/bare.suite.yaml'
      const gone = kind === 'test' ? 'tests/gone.yaml' : 'suites/gone.suite.yaml'
      const make = kind === 'test' ? bigTest : bigSuite
      const tests = new TestFileManager(ws.paths)
      const suites = new SuiteFileManager(ws.paths, tests)
      const manager = kind === 'test' ? tests : suites

      // (m1) an id-less save beside two list() calls
      await writeFile(join(ws.dir, bare), make('Bare old', SAVE_BYTES))
      const newBody = make('Bare new', SAVE_BYTES)
      await Promise.all([manager.write(bare, newBody), manager.list(), manager.list()])
      const lastListing: Array<{ path: string; testId?: string | null; suiteId?: string | null }> = await manager.list()
      const disk = await readFile(join(ws.dir, bare), 'utf-8')
      const id = oneIdOver(disk, newBody, kind)
      expect(id, `(m1) ${bare} holds one id line over the new body: ${describeFile(disk, kind)}`).not.toBeNull()
      const row = lastListing.find((candidate) => candidate.path === bare)
      expect(kind === 'test' ? row?.testId : row?.suiteId, `(m1) the last ${kind} list names ${bare}'s id`).toBe(id)
      expect(await tmpFilesUnder(ws.dir), `(m1) no temp file is left in the ${kind} workspace`).toEqual([])

      // (m2) a delete sent while a mint of the same file is held inside that file's lock
      await writeFile(join(ws.dir, gone), make('Gone', 2_000))
      fileWrites.lockAsks.length = 0
      const hold = holdReplace(gone)
      const listing = manager.list()
      await hold.reached
      const deletion = manager.delete(gone)
      await waitUntil(
        () => asksFor(gone) >= 2 || !existsSync(join(ws.dir, gone)),
        `(m2) the delete asks for ${gone}'s lock or ${gone} is removed`,
        5_000,
      )
      hold.release()
      const settled = await Promise.allSettled([listing, deletion])
      expect(
        settled.flatMap((outcome) => (outcome.status === 'rejected' ? [String(outcome.reason)] : [])),
        `(m2) the listing and the delete of ${gone} both settle`,
      ).toEqual([])
      expect(existsSync(join(ws.dir, gone)), `(m2) ${gone} stays deleted`).toBe(false)
      expect(await tmpFilesUnder(ws.dir), `(m2) no temp file is left in the ${kind} workspace`).toEqual([])
      const fresh: Array<{ path: string }> = await manager.list()
      expect(fresh.map((file) => file.path), `(m2) a list after the delete does not list ${gone}`).not.toContain(gone)
      const heldId = hold.content === null ? null : splitIdLine(hold.content, kind).id
      expect(heldId, `(m2) the held mint of ${gone} wrote an id line`).not.toBeNull()
      const found = kind === 'test' ? await tests.findByTestId(heldId!) : await suites.findBySuiteId(heldId!)
      expect(found, `(m2) no answer after the delete names ${gone}'s held id`).toBeNull()
    }
  })

  it('with another list read in flight, a test or suite the editor just saved opens by its id, and a suite naming a test saved a moment earlier saves', async () => {
    const unexpected: string[] = []
    const inFlight = new Map<string, number>()
    const COUNTS = [30, 200]
    const FLOWS = ['T', 'V', 'S'] as const

    for (const count of COUNTS) {
      const tws = await workspace(`tracer-tests-${String(count)}`)
      for (let index = 0; index < count; index++) {
        await writeFile(join(tws.dir, `tests/t${pad(index)}.yaml`), idTest(generateTestId(), `T${String(index)}`))
      }
      const sws = await workspace(`tracer-suites-${String(count)}`)
      const onlyId = generateTestId()
      await writeFile(join(sws.dir, 'tests/only.yaml'), idTest(onlyId, 'Only'))
      for (let index = 0; index < count; index++) {
        await writeFile(
          join(sws.dir, `suites/s${pad(index)}.suite.yaml`),
          idSuite(generateSuiteId(), `S${String(index)}`, 'tests/only.yaml', onlyId),
        )
      }
      const testsOrigin = await startDashboard(tws)
      const suitesOrigin = await startDashboard(sws)

      for (let round = 0; round < 5; round++) {
        const flag = (flow: string, other: { settled: () => boolean }): string => {
          const live = !other.settled()
          if (live) inFlight.set(`${flow} ${String(count)}`, (inFlight.get(`${flow} ${String(count)}`) ?? 0) + 1)
          return `${flow} at ${String(count)} files, round ${String(round)}, other listing ${live ? 'in flight' : 'settled'}`
        }
        const expectAnswer = (label: string, step: string, reply: Answer, status: number, path?: string): void => {
          if (reply.status !== status || (path !== undefined && reply.body?.path !== path)) {
            unexpected.push(`${label}: ${step} answered ${String(reply.status)} ${JSON.stringify(reply.body)}`)
          }
        }

        // T: a test created, then opened by its id
        {
          const other = otherTab(`${testsOrigin}/api/tests`)
          const id = generateTestId()
          const path = `tests/new-t${pad(round)}.yaml`
          const created = await send(`${testsOrigin}/api/tests`, 'POST', { path, content: idTest(id, `New T ${String(round)}`) })
          const label = flag('T', other)
          const opened = await read(`${testsOrigin}/api/tests/${encodeURIComponent(id)}`)
          expectAnswer(label, 'POST /api/tests', created, 201)
          expectAnswer(label, 'GET /api/tests/:id', opened, 200, path)
          expectAnswer(label, "the other tab's GET /api/tests", await other.answer, 200)
        }

        // V: a suite saved naming a test created a moment earlier, then opened by its id
        {
          const other = otherTab(`${testsOrigin}/api/tests`)
          const testId = generateTestId()
          const testPath = `tests/new-v${pad(round)}.yaml`
          const suiteId = generateSuiteId()
          const suitePath = `suites/new-v${pad(round)}.suite.yaml`
          const created = await send(`${testsOrigin}/api/tests`, 'POST', {
            path: testPath,
            content: idTest(testId, `New V ${String(round)}`),
          })
          const label = flag('V', other)
          const saved = await send(`${testsOrigin}/api/suites`, 'POST', {
            path: suitePath,
            content: idSuite(suiteId, `Suite V ${String(round)}`, testPath, testId),
          })
          const opened = await read(`${testsOrigin}/api/suites/${encodeURIComponent(suiteId)}`)
          expectAnswer(label, 'POST /api/tests', created, 201)
          expectAnswer(label, 'POST /api/suites', saved, 201)
          expectAnswer(label, 'GET /api/suites/:id', opened, 200, suitePath)
          expectAnswer(label, "the other tab's GET /api/tests", await other.answer, 200)
        }

        // S: a suite created, then opened by its id
        {
          const other = otherTab(`${suitesOrigin}/api/suites`)
          const suiteId = generateSuiteId()
          const suitePath = `suites/new-s${pad(round)}.suite.yaml`
          const saved = await send(`${suitesOrigin}/api/suites`, 'POST', {
            path: suitePath,
            content: idSuite(suiteId, `Suite S ${String(round)}`, 'tests/only.yaml', onlyId),
          })
          const label = flag('S', other)
          const opened = await read(`${suitesOrigin}/api/suites/${encodeURIComponent(suiteId)}`)
          expectAnswer(label, 'POST /api/suites', saved, 201)
          expectAnswer(label, 'GET /api/suites/:id', opened, 200, suitePath)
          expectAnswer(label, "the other tab's GET /api/suites", await other.answer, 200)
        }
      }
    }

    expect(unexpected, 'every request after a finished save answered as that save left the workspace').toEqual([])
    for (const flow of FLOWS) {
      for (const count of COUNTS) {
        expect(
          inFlight.get(`${flow} ${String(count)}`) ?? 0,
          `flow ${flow} at ${String(count)} files had the other listing in flight in at least one round`,
        ).toBeGreaterThan(0)
      }
    }
  })

  it('with a listing still in flight, the next list, find and validate calls on both managers see every save and delete that has finished', async () => {
    const findings: string[] = []

    // (t) the test manager, with a suite manager over it as server.ts builds them
    {
      const ws = await workspace('managers-held-t')
      await writeFile(join(ws.dir, 'tests/a-gone.yaml'), idTest(generateTestId(), 'Gone'))
      for (let index = 0; index < 50; index++) {
        await writeFile(join(ws.dir, `tests/t${pad(index)}.yaml`), idTest(generateTestId(), `T${String(index)}`))
      }
      const heldBody = smallTest(900)
      await writeFile(join(ws.dir, 'tests/zzz-hold.yaml'), heldBody)
      const tests = new TestFileManager(ws.paths)
      const suites = new SuiteFileManager(ws.paths, tests)

      const hold = holdReplace('tests/zzz-hold.yaml')
      const held = tests.list()
      await hold.reached
      const newId = generateTestId()
      await tests.write('tests/new.yaml', idTest(newId, 'New'))
      await tests.delete('tests/a-gone.yaml')
      const asked = asksFor('tests/zzz-hold.yaml')
      const find = tests.findByTestId(newId)
      const later = tests.list()
      const validation = suites.validate(idSuite(generateSuiteId(), 'Names new', 'tests/new.yaml', newId))
      await waitUntil(() => asksFor('tests/zzz-hold.yaml') >= asked + 3, '(t) the three later calls ask for the held file', 5_000).catch(
        (err: Error) => findings.push(err.message),
      )
      hold.release()
      const [heldList, found, laterList, valid] = await Promise.all([held, find, later, validation])

      if (found?.path !== 'tests/new.yaml') findings.push(`(t) findByTestId of the saved test answered ${JSON.stringify(found?.path ?? null)}`)
      const laterPaths = laterList.map((file) => file.path)
      if (!laterPaths.includes('tests/new.yaml')) findings.push('(t) the later list() does not list the saved tests/new.yaml')
      if (laterPaths.includes('tests/a-gone.yaml')) findings.push('(t) the later list() still lists the deleted tests/a-gone.yaml')
      if (JSON.stringify(valid) !== JSON.stringify({ valid: true, errors: [] })) {
        findings.push(`(t) validate() of a suite naming tests/new.yaml answered ${JSON.stringify(valid)}`)
      }
      const heldId = hold.content === null ? null : splitIdLine(hold.content, 'test').id
      if (heldId === null) findings.push('(t) the held mint wrote no id line')
      for (const [label, listing] of [['held', heldList], ['later', laterList]] as const) {
        const named = listing.find((file) => file.path === 'tests/zzz-hold.yaml')?.testId ?? null
        if (named !== heldId) findings.push(`(t) the ${label} list names ${String(named)} for tests/zzz-hold.yaml, the mint wrote ${String(heldId)}`)
      }
      const disk = await readFile(join(ws.dir, 'tests/zzz-hold.yaml'), 'utf-8')
      if (heldId === null || oneIdOver(disk, heldBody, 'test') !== heldId) {
        findings.push(`(t) tests/zzz-hold.yaml: ${describeFile(disk, 'test')}, the mint wrote ${String(heldId)}`)
      }
    }

    // (s) the suite manager
    {
      const ws = await workspace('managers-held-s')
      const onlyId = generateTestId()
      await writeFile(join(ws.dir, 'tests/only.yaml'), idTest(onlyId, 'Only'))
      await writeFile(join(ws.dir, 'suites/a-gone.suite.yaml'), idSuite(generateSuiteId(), 'Gone', 'tests/only.yaml', onlyId))
      for (let index = 0; index < 50; index++) {
        await writeFile(
          join(ws.dir, `suites/s${pad(index)}.suite.yaml`),
          idSuite(generateSuiteId(), `S${String(index)}`, 'tests/only.yaml', onlyId),
        )
      }
      const heldBody = `name: Held\ntarget: web\ntests:\n  - test: tests/only.yaml\n    id: ${onlyId}\n`
      await writeFile(join(ws.dir, 'suites/zzz-hold.suite.yaml'), heldBody)
      const suites = new SuiteFileManager(ws.paths, new TestFileManager(ws.paths))

      const hold = holdReplace('suites/zzz-hold.suite.yaml')
      const held = suites.list()
      await hold.reached
      const newId = generateSuiteId()
      await suites.write('suites/new.suite.yaml', idSuite(newId, 'New', 'tests/only.yaml', onlyId))
      await suites.delete('suites/a-gone.suite.yaml')
      const asked = asksFor('suites/zzz-hold.suite.yaml')
      const find = suites.findBySuiteId(newId)
      const later = suites.list()
      await waitUntil(() => asksFor('suites/zzz-hold.suite.yaml') >= asked + 2, '(s) the two later calls ask for the held file', 5_000).catch(
        (err: Error) => findings.push(err.message),
      )
      hold.release()
      const [heldList, found, laterList] = await Promise.all([held, find, later])

      if (found?.path !== 'suites/new.suite.yaml') {
        findings.push(`(s) findBySuiteId of the saved suite answered ${JSON.stringify(found?.path ?? null)}`)
      }
      const laterPaths = laterList.map((file) => file.path)
      if (!laterPaths.includes('suites/new.suite.yaml')) findings.push('(s) the later list() does not list the saved suites/new.suite.yaml')
      if (laterPaths.includes('suites/a-gone.suite.yaml')) findings.push('(s) the later list() still lists the deleted suites/a-gone.suite.yaml')
      const heldId = hold.content === null ? null : splitIdLine(hold.content, 'suite').id
      if (heldId === null) findings.push('(s) the held mint wrote no id line')
      for (const [label, listing] of [['held', heldList], ['later', laterList]] as const) {
        const named = listing.find((file) => file.path === 'suites/zzz-hold.suite.yaml')?.suiteId ?? null
        if (named !== heldId) {
          findings.push(`(s) the ${label} list names ${String(named)} for suites/zzz-hold.suite.yaml, the mint wrote ${String(heldId)}`)
        }
      }
      const disk = await readFile(join(ws.dir, 'suites/zzz-hold.suite.yaml'), 'utf-8')
      if (heldId === null || oneIdOver(disk, heldBody, 'suite') !== heldId) {
        findings.push(`(s) suites/zzz-hold.suite.yaml: ${describeFile(disk, 'suite')}, the mint wrote ${String(heldId)}`)
      }
    }

    expect(findings, 'every call started after a finished save or delete sees it, and the held file keeps one id').toEqual([])
  })

  it('an empty name lists the file name and an empty target lists no target', async () => {
    const ws = await workspace('empty-name')
    await writeFile(join(ws.dir, 'tests/blank-name.yaml'), `test-id: ${generateTestId()}\nname: ""\ntarget: ''\nsteps:\n  - Click a\n`)
    const namedId = generateTestId()
    await writeFile(join(ws.dir, 'tests/named.yaml'), idTest(namedId, 'Named'))
    await writeFile(
      join(ws.dir, 'suites/blank-name.suite.yaml'),
      `suite-id: ${generateSuiteId()}\nname: ""\ntarget: web\ntests:\n  - test: tests/named.yaml\n    id: ${namedId}\n`,
    )
    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)
    const testRows = await tests.list()
    const suiteRows = await suites.list()
    const shown = (path: string): { name: string; targetName: string | null } | undefined => {
      const row = testRows.find((file) => file.path === path)
      return row === undefined ? undefined : { name: row.name, targetName: row.targetName }
    }

    expect(
      {
        blank: shown('tests/blank-name.yaml'),
        named: shown('tests/named.yaml'),
        suite: suiteRows.find((file) => file.path === 'suites/blank-name.suite.yaml')?.name,
      },
      'an empty name falls back to the file name and an empty target to none; a set name and target are kept',
    ).toEqual({
      blank: { name: 'blank-name.yaml', targetName: null },
      named: { name: 'Named', targetName: 'web' },
      suite: 'blank-name.suite.yaml',
    })
  })

  it('a zero-byte or whitespace-only file is listed with no id and nothing is written to it', async () => {
    posixOnly()
    const ws = await workspace('empty-file')
    const findings: string[] = []
    const kinds = [
      { kind: 'test' as const, empty: ['tests/empty.yaml', 'tests/blank.yaml'], plain: 'tests/plain.yaml', body: smallTest(1) },
      {
        kind: 'suite' as const,
        empty: ['suites/empty.suite.yaml', 'suites/blank.suite.yaml'],
        plain: 'suites/plain.suite.yaml',
        body: smallSuite(1),
      },
    ]
    const emptyBytes = ['', ' \n\n  \n']
    const before = new Map<string, { bytes: string; ino: bigint; mtimeNs: bigint }>()
    for (const entry of kinds) {
      for (const [index, path] of entry.empty.entries()) {
        await writeFile(join(ws.dir, path), emptyBytes[index])
        const s = await stat(join(ws.dir, path), { bigint: true })
        before.set(path, { bytes: emptyBytes[index], ino: s.ino, mtimeNs: s.mtimeNs })
      }
      await writeFile(join(ws.dir, entry.plain), entry.body)
    }
    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)

    for (const entry of kinds) {
      const manager = entry.kind === 'test' ? tests : suites
      const listings: Array<Array<{ path: string; testId?: string | null; suiteId?: string | null }>> = []
      for (let call = 0; call < 2; call++) {
        listings.push(await manager.list())
        for (const path of entry.empty) {
          const row = listings[call].find((file) => file.path === path)
          const id = entry.kind === 'test' ? row?.testId : row?.suiteId
          if (row === undefined) findings.push(`list ${String(call + 1)} does not list ${path}`)
          else if (id !== null) findings.push(`list ${String(call + 1)} names ${String(id)} for ${path}`)
          const s = await stat(join(ws.dir, path), { bigint: true })
          const now = { bytes: await readFile(join(ws.dir, path), 'utf-8'), ino: s.ino, mtimeNs: s.mtimeNs }
          const was = before.get(path)!
          if (now.bytes !== was.bytes || now.ino !== was.ino || now.mtimeNs !== was.mtimeNs) {
            findings.push(`after list ${String(call + 1)} ${path} reads ${JSON.stringify(now.bytes)} (ino or mtime ${now.ino === was.ino && now.mtimeNs === was.mtimeNs ? 'unchanged' : 'changed'})`)
          }
        }
      }
      const disk = await readFile(join(ws.dir, entry.plain), 'utf-8')
      const id = oneIdOver(disk, entry.body, entry.kind)
      if (id === null) findings.push(`${entry.plain}: ${describeFile(disk, entry.kind)}`)
      for (const [call, listing] of listings.entries()) {
        const row = listing.find((file) => file.path === entry.plain)
        const named = entry.kind === 'test' ? row?.testId : row?.suiteId
        if (id === null || named !== id) findings.push(`list ${String(call + 1)} names ${String(named)} for ${entry.plain}, the file holds ${String(id)}`)
      }
    }
    const temps = await tmpFilesUnder(ws.dir)
    if (temps.length > 0) findings.push(`temp files left: ${temps.join(', ')}`)

    expect(findings, 'an empty or whitespace-only file keeps its bytes, inode and mtime and is listed with no id').toEqual([])
  })

  it('a test or suite file whose name is 250 bytes long is minted and saved whole, with no temp file left', async () => {
    posixOnly()
    const ws = await workspace('long-name')
    const findings: string[] = []
    const kinds = [
      {
        kind: 'test' as const,
        first: `tests/${'l'.repeat(245)}.yaml`,
        second: `tests/m${'l'.repeat(244)}.yaml`,
        body: smallTest(1),
        saved: (): { id: string; body: string } => {
          const id = generateTestId()
          return { id, body: `test-id: ${id}\n${smallTest(2)}` }
        },
      },
      {
        kind: 'suite' as const,
        first: `suites/${'l'.repeat(239)}.suite.yaml`,
        second: `suites/m${'l'.repeat(238)}.suite.yaml`,
        body: smallSuite(1),
        saved: (): { id: string; body: string } => {
          const id = generateSuiteId()
          return { id, body: `suite-id: ${id}\n${smallSuite(2)}` }
        },
      },
    ]
    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)

    for (const entry of kinds) {
      for (const path of [entry.first, entry.second]) {
        const name = path.slice(path.indexOf('/') + 1)
        if (Buffer.byteLength(name) !== 250) throw new Error(`the fixture name ${name} is ${String(Buffer.byteLength(name))} bytes, not 250`)
      }
      const manager = entry.kind === 'test' ? tests : suites
      const idOf = (rows: Array<{ path: string; testId?: string | null; suiteId?: string | null }>, path: string) => {
        const row = rows.find((file) => file.path === path)
        return (entry.kind === 'test' ? row?.testId : row?.suiteId) ?? null
      }

      // (1) an id-less file with a 250-byte name is minted
      await writeFile(join(ws.dir, entry.first), entry.body)
      const listed = idOf(await manager.list(), entry.first)
      const disk = await readFile(join(ws.dir, entry.first), 'utf-8')
      if (listed === null) findings.push(`(1) the ${entry.kind} list names no id for its 250-byte file: ${describeFile(disk, entry.kind)}`)
      else if (oneIdOver(disk, entry.body, entry.kind) !== listed) findings.push(`(1) ${describeFile(disk, entry.kind)}, listed ${listed}`)

      // (2) write() saves a new id-bearing file under a 250-byte name
      const saved = entry.saved()
      try {
        await manager.write(entry.second, saved.body)
      } catch (err) {
        findings.push(`(2) write() of the ${entry.kind} file rejected: ${(err as NodeJS.ErrnoException).code ?? String(err)}`)
      }
      const written = existsSync(join(ws.dir, entry.second)) ? await readFile(join(ws.dir, entry.second), 'utf-8') : null
      if (written !== saved.body) findings.push(`(2) the saved ${entry.kind} file reads ${describeFile(written, entry.kind)}`)
      const named = idOf(await manager.list(), entry.second)
      if (named !== saved.id) findings.push(`(2) the ${entry.kind} list after the save names ${String(named)}, the save holds ${saved.id}`)
    }

    // (3) no temp file
    const temps = await tmpFilesUnder(ws.dir)
    if (temps.length > 0) findings.push(`(3) temp files left: ${temps.map((temp) => `${String(temp.length)}-byte path`).join(', ')}`)

    expect(findings, 'a 250-byte file name is minted and saved whole, with no temp file left').toEqual([])
  })

  it('an id-less test or suite that opens with a --- marker gets its id inside that document, so it still parses as one document and validates, and the listed id is the one on disk and opens', async () => {
    const ws = await workspace('doc-marker')
    const findings: string[] = []
    const namedId = generateTestId()
    await writeFile(join(ws.dir, 'tests/named.yaml'), idTest(namedId, 'Named'))
    const docs = {
      test: { path: 'tests/doc.yaml', body: '---\nname: Doc test\ntarget: web\nsteps:\n  - Click a\n' },
      suite: {
        path: 'suites/doc.suite.yaml',
        body: `---\nname: Doc suite\ntarget: web\ntests:\n  - test: tests/named.yaml\n    id: ${namedId}\n`,
      },
    }
    for (const kind of ['test', 'suite'] as const) await writeFile(join(ws.dir, docs[kind].path), docs[kind].body)
    const origin = await startDashboard(ws)
    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)

    for (const kind of ['test', 'suite'] as const) {
      const { path, body } = docs[kind]
      const route = kind === 'test' ? 'tests' : 'suites'
      const key = kind === 'test' ? 'test-id' : 'suite-id'
      const listings: Array<string | null> = []
      for (let call = 0; call < 2; call++) {
        const reply = await read(`${origin}/api/${route}`)
        if (reply.status !== 200) findings.push(`(${kind}) GET /api/${route} call ${String(call + 1)} answered ${String(reply.status)}`)
        listings.push(rowsOf(reply, 'files').find((row) => row.path === path)?.[idField(kind)] ?? null)
      }
      const listed = listings[0]
      if (listed === null) findings.push(`(${kind}) the first GET /api/${route} names no id for ${path}`)
      if (listings[1] !== listed) {
        findings.push(`(${kind}) the second GET /api/${route} names ${String(listings[1])} for ${path}, the first ${String(listed)}`)
      }

      const disk = await readFile(join(ws.dir, path), 'utf-8')
      const expected = listed === null ? null : `---\n${key}: ${listed}\n${body.slice('---\n'.length)}`
      if (disk !== expected) findings.push(`(${kind}) ${path} reads ${JSON.stringify(disk.slice(0, 72))}, not its body with the listed id line after the marker`)
      const documents = parseAllDocuments(disk).length
      if (documents !== 1) findings.push(`(${kind}) ${path} holds ${String(documents)} YAML documents`)

      if (kind === 'test') {
        const parsed = parseTestFile(disk, path)
        if (parsed.errors.length > 0 || parsed.tests.length !== 1 || parsed.tests[0]['test-id'] !== listed) {
          findings.push(
            `(test) parseTestFile read ${String(parsed.tests.length)} tests and ${String(parsed.errors.length)} errors${parsed.errors.length > 0 ? `, first: ${parsed.errors[0].message.split('\n')[0]}` : ''}`,
          )
        }
      } else {
        try {
          const suite = (await parseSuiteFile(join(ws.dir, path))) as Record<string, unknown>
          if (suite['suite-id'] !== listed) findings.push(`(suite) parseSuiteFile read the id ${String(suite['suite-id'])}, the list ${String(listed)}`)
        } catch (err) {
          findings.push(`(suite) parseSuiteFile refused ${path}: ${(err as Error).message.split('\n')[0]}`)
        }
      }
      const validation = kind === 'test' ? await tests.validate(disk) : await suites.validate(disk)
      if (!validation.valid) {
        findings.push(`(${kind}) validate() refused ${path}: ${validation.errors.map((error) => error.message.split('\n')[0]).join('; ')}`)
      }

      if (listed !== null) {
        const found = kind === 'test' ? await tests.findByTestId(listed) : await suites.findBySuiteId(listed)
        if (found?.path !== path) findings.push(`(${kind}) find by the listed id answered ${JSON.stringify(found?.path ?? null)}`)
        const opened = await read(`${origin}/api/${route}/${encodeURIComponent(listed)}`)
        if (opened.status !== 200 || opened.body?.path !== path) {
          findings.push(`(${kind}) GET /api/${route}/:id of the listed id answered ${String(opened.status)}`)
        }
      }
    }

    expect(findings, 'a ---led file stays one document with its id inside it, and the listed id is on disk and opens').toEqual([])
  })

  it('a key is read from its own line: a bare or blank name lists the file name, a bare target lists no target, and a bare id key counts as no id and is filled in place', async () => {
    const ws = await workspace('own-line')
    const findings: string[] = []
    const lines = (...parts: string[]): string => `${parts.join('\n')}\n`
    const namedId = generateTestId()
    await writeFile(join(ws.dir, 'tests/named.yaml'), idTest(namedId, 'Named'))
    const suiteTail = ['target: web', 'tests:', '  - test: tests/named.yaml', `    id: ${namedId}`]
    const steps = ['steps:', '  - Click a']
    await writeFile(join(ws.dir, 'tests/bare-name.yaml'), lines(`test-id: ${generateTestId()}`, 'name:', 'target: web', ...steps))
    await writeFile(join(ws.dir, 'tests/blank-name.yaml'), lines(`test-id: ${generateTestId()}`, 'name: "  "', 'target: web', ...steps))
    await writeFile(join(ws.dir, 'tests/bare-target.yaml'), lines(`test-id: ${generateTestId()}`, 'name: Bare target', 'target:', ...steps))
    await writeFile(join(ws.dir, 'suites/bare-name.suite.yaml'), lines(`suite-id: ${generateSuiteId()}`, 'name:', ...suiteTail))
    await writeFile(join(ws.dir, 'suites/blank-name.suite.yaml'), lines(`suite-id: ${generateSuiteId()}`, 'name: "  "', ...suiteTail))
    const bare = {
      test: { path: 'tests/bare-id.yaml', body: lines('test-id:', 'name: Bare id', 'target: web', ...steps) },
      suite: { path: 'suites/bare-id.suite.yaml', body: lines('suite-id:', 'name: Bare id suite', ...suiteTail) },
    }
    for (const kind of ['test', 'suite'] as const) await writeFile(join(ws.dir, bare[kind].path), bare[kind].body)
    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)
    const testRows = await tests.list()
    const suiteRows = await suites.list()
    const testShown = (path: string): { name: string; targetName: string | null } | undefined => {
      const row = testRows.find((file) => file.path === path)
      return row === undefined ? undefined : { name: row.name, targetName: row.targetName }
    }
    const names = {
      bareName: testShown('tests/bare-name.yaml'),
      blankName: testShown('tests/blank-name.yaml'),
      bareTarget: testShown('tests/bare-target.yaml'),
      suiteBareName: suiteRows.find((file) => file.path === 'suites/bare-name.suite.yaml')?.name,
      suiteBlankName: suiteRows.find((file) => file.path === 'suites/blank-name.suite.yaml')?.name,
    }

    for (const kind of ['test', 'suite'] as const) {
      const { path, body } = bare[kind]
      const key = kind === 'test' ? 'test-id' : 'suite-id'
      const idOf = (rows: Array<{ path: string; testId?: string | null; suiteId?: string | null }>): string | null => {
        const row = rows.find((file) => file.path === path)
        return (kind === 'test' ? row?.testId : row?.suiteId) ?? null
      }
      const listed = idOf(kind === 'test' ? testRows : suiteRows)
      const again = idOf(kind === 'test' ? await tests.list() : await suites.list())
      const disk = await readFile(join(ws.dir, path), 'utf-8')
      const expected = listed === null ? null : `${key}: ${listed}\n${body.slice(`${key}:\n`.length)}`
      if (listed === null) findings.push(`(${kind}) the first list names no id for ${path}`)
      if (disk !== expected) {
        findings.push(`(${kind}) ${path} reads ${JSON.stringify(disk.slice(0, 72))} with ${String(splitIdLine(disk, kind).idLines)} id lines, listed ${JSON.stringify(listed)}`)
      }
      if (again !== listed) findings.push(`(${kind}) the second list names ${JSON.stringify(again)} for ${path}, the first ${JSON.stringify(listed)}`)
      const validation = kind === 'test' ? await tests.validate(disk) : await suites.validate(disk)
      if (!validation.valid) {
        findings.push(`(${kind}) validate() refused ${path}: ${validation.errors.map((error) => error.message.split('\n')[0]).join('; ')}`)
      }
      if (listed !== null) {
        const found = kind === 'test' ? await tests.findByTestId(listed) : await suites.findBySuiteId(listed)
        if (found?.path !== path) findings.push(`(${kind}) find by the listed id answered ${JSON.stringify(found?.path ?? null)}`)
      }
    }

    expect(
      { names, findings },
      "a bare or blank name falls back to the file name, a bare target to none, and a bare id key is filled in place with one id",
    ).toEqual({
      names: {
        bareName: { name: 'bare-name.yaml', targetName: 'web' },
        blankName: { name: 'blank-name.yaml', targetName: 'web' },
        bareTarget: { name: 'Bare target', targetName: null },
        suiteBareName: 'bare-name.suite.yaml',
        suiteBlankName: 'blank-name.suite.yaml',
      },
      findings: [],
    })
  })

  it('every test file in the layout corpus is read from its parsed YAML, and listing it leaves its old mapping with one id that opens, in its own line endings, or leaves it byte-identical with no id; none stops parsing', async () => {
    expect(await checkLayoutCorpus('test'), 'each test layout is minted whole, kept, or left byte-identical with no id').toEqual({ rows: 22, findings: [] })
  })

  it('every suite file in the layout corpus is read from its parsed YAML, and listing it leaves its old mapping with one id that opens, in its own line endings, or leaves it byte-identical with no id; none stops parsing', async () => {
    expect(await checkLayoutCorpus('suite'), 'each suite layout is minted whole, kept, or left byte-identical with no id').toEqual({ rows: 22, findings: [] })
  })

  it('a test create or save whose target holds a shown marker in a mapping value or on an indented target line is refused and nothing is written', async () => {
    const ws = await workspace('marker-guard')
    const marker = '[secret:X]-web'
    const savedId = generateTestId()
    const saved = idTest(savedId, 'Guard')
    await writeFile(join(ws.dir, 'tests/guard.yaml'), saved)
    const origin = await startDashboard(ws)
    const bodies = {
      mapping: `name: Guard\ntarget: {name: '${marker}'}\nsteps:\n  - Click a\n`,
      indented: `name: Guard\nsteps:\n  - click:\n      target: '${marker}'\n`,
    }
    const answers: Record<string, unknown> = {}
    for (const [shape, content] of Object.entries(bodies)) {
      const created = await send(`${origin}/api/tests`, 'POST', { path: `tests/new-${shape}.yaml`, content })
      answers[`POST ${shape}`] = { status: created.status, error: created.body?.error ?? null, written: existsSync(join(ws.dir, `tests/new-${shape}.yaml`)) }
      const put = await send(`${origin}/api/tests/${encodeURIComponent(savedId)}`, 'PUT', { content: `test-id: ${savedId}\n${content}` })
      answers[`PUT ${shape}`] = { status: put.status, error: put.body?.error ?? null, written: (await readFile(join(ws.dir, 'tests/guard.yaml'), 'utf-8')) !== saved }
    }
    const refused = { status: 422, error: 'marker_written_back', written: false }
    const invalid = { status: 400, error: 'invalid_test_file', written: false }
    expect(answers, 'a shown marker in a mapping target or on an indented target line is refused on create and save').toEqual({
      'POST mapping': refused,
      'PUT mapping': refused,
      'POST indented': invalid,
      'PUT indented': invalid,
    })
  })

  // 2026-10-19 (444.1-11, D-18): a Latin-1 byte is not valid UTF-8; a decode that replaced it would rewrite it as EF BF BD.
  it('an id-less test or suite file that is not valid UTF-8 is listed with no id and left byte-identical', async () => {
    const ws = await workspace('not-utf8')
    const findings: string[] = []
    const latin1 = (head: string, tail: string): Buffer => Buffer.concat([Buffer.from(head), Buffer.from([0xe9]), Buffer.from(tail)])
    const kinds = [
      {
        kind: 'test' as const,
        path: 'tests/latin1.yaml',
        bytes: latin1('name: Caf', ' order\ntarget: web\nsteps:\n  - Click a\n'),
        plain: 'tests/plain.yaml',
        body: smallTest(1),
      },
      {
        kind: 'suite' as const,
        path: 'suites/latin1.suite.yaml',
        bytes: latin1('name: Caf', ' suite\ntests: []\n'),
        plain: 'suites/plain.suite.yaml',
        body: smallSuite(1),
      },
    ]
    for (const entry of kinds) {
      await writeFile(join(ws.dir, entry.path), entry.bytes)
      await writeFile(join(ws.dir, entry.plain), entry.body)
    }
    const tests = new TestFileManager(ws.paths)
    const suites = new SuiteFileManager(ws.paths, tests)

    for (const entry of kinds) {
      for (let call = 0; call < 2; call++) {
        const listing: Array<{ path: string; testId?: string | null; suiteId?: string | null }> =
          entry.kind === 'test' ? await tests.list() : await suites.list()
        const row = listing.find((file) => file.path === entry.path)
        const id = entry.kind === 'test' ? row?.testId : row?.suiteId
        if (row === undefined) findings.push(`list ${String(call + 1)} does not list ${entry.path}`)
        else if (id !== null) findings.push(`list ${String(call + 1)} names ${String(id)} for ${entry.path}`)
        const now = await readFile(join(ws.dir, entry.path))
        if (!now.equals(entry.bytes)) {
          findings.push(`after list ${String(call + 1)} ${entry.path} holds ${String(now.length)} bytes: ${now.toString('hex').slice(0, 80)}, not ${entry.bytes.toString('hex').slice(0, 80)}`)
        }
        const plain = listing.find((file) => file.path === entry.plain)
        const plainId = entry.kind === 'test' ? plain?.testId : plain?.suiteId
        const plainDisk = await readFile(join(ws.dir, entry.plain), 'utf-8')
        if (plainId == null || oneIdOver(plainDisk, entry.body, entry.kind) !== plainId) {
          findings.push(`list ${String(call + 1)} names ${String(plainId)} for ${entry.plain}, which reads ${describeFile(plainDisk, entry.kind)}`)
        }
      }
    }

    expect(findings, 'a file that is not valid UTF-8 keeps every byte and lists no id, while a valid id-less file beside it is minted').toEqual([])
  })

  it('a test create or save whose second YAML document holds a shown marker target is refused and nothing is written', async () => {
    const legs = await guardLegs('marker-two-docs', (firstId) =>
      `test-id: ${firstId}\nname: Guard first\ntarget: web\nsteps:\n  - Click a\n---\ntest-id: ${generateTestId()}\nname: Guard second\ntarget:\n  "${SHOWN}"\nsteps:\n  - Click b\n`,
    )
    const refused = { status: 422, error: 'marker_written_back', written: false, valid: true }
    expect(legs, 'a valid two-document body whose second target is a shown marker is refused on create and save').toEqual({ POST: refused, PUT: refused })
  })

  it('a valid test whose block-scalar step line starts with target and holds a marker is saved', async () => {
    const legs = await guardLegs('marker-block-step', (firstId) =>
      `test-id: ${firstId}\nname: Guard block\ntarget: web\nsteps:\n  - |\n    target: ${SHOWN} is shown\n`,
    )
    expect(legs, 'a step text that starts with target: is not a target, so the valid body is created and saved').toEqual({
      POST: { status: 201, error: null, written: true, valid: true },
      PUT: { status: 200, error: null, written: true, valid: true },
    })
  })

  it('a valid test whose target holds a shown marker on the next line is refused and nothing is written', async () => {
    const legs = await guardLegs('marker-next-line', (firstId) =>
      `test-id: ${firstId}\nname: Guard next\ntarget:\n  "${SHOWN}"\nsteps:\n  - Click a\n`,
    )
    const refused = { status: 422, error: 'marker_written_back', written: false, valid: true }
    expect(legs, 'a valid body whose target value sits on the line after target: is refused on create and save').toEqual({ POST: refused, PUT: refused })
  })
})
