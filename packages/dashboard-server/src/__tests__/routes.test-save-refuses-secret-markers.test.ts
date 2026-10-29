import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { type IncomingHttpHeaders, IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { MARKER_WRITTEN_BACK_SENTENCE } from '@vostride/agent-qa-schema'

import { createRouter } from '../server/routes.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { TestFileManager } from '../tests/test-file-manager.js'

// The target list answers masked names, so a picked target can hold one.
const MASKED_TARGET = '[secret:X]-web'
const WORDS = 'amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const TEST_ID = `t_${WORDS}`
const SUITE_ID = `s_${WORDS}`

const REFUSAL = {
  error: 'marker_written_back',
  message: MARKER_WRITTEN_BACK_SENTENCE,
  issues: [{ path: ['target'], message: MARKER_WRITTEN_BACK_SENTENCE }],
}

function testContent(target: string): string {
  return [`test-id: ${TEST_ID}`, 'name: Checkout', `target: '${target}'`, 'steps:', '  - Open the page', ''].join('\n')
}

function suiteContent(target: string): string {
  return [
    `suite-id: ${SUITE_ID}`,
    'name: Checkout suite',
    `target: '${target}'`,
    'tests:',
    '  - test: tests/checkout.yaml',
    `    id: ${TEST_ID}`,
    '',
  ].join('\n')
}

interface MockResponse {
  status: number
  body: string
}

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function composeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-441-gap2-save-'))
  tempDirs.push(dir)
  const workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'runtime/hooks/custom-hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
    },
    configPath: join(dir, 'agent-qa.config.yaml'),
  })
  const testFileManager = new TestFileManager(workspacePaths)
  const suiteFileManager = new SuiteFileManager(workspacePaths, testFileManager)
  const router = createRouter({
    db: { getRuns: () => [], close() {} } as any,
    workspacePaths,
    testFileManager,
    suiteFileManager,
  })
  return { dir, router }
}

async function invoke(
  router: ReturnType<typeof createRouter>,
  url: string,
  method: string,
  body: unknown,
): Promise<MockResponse> {
  return await new Promise((resolve, reject) => {
    const req = new IncomingMessage(new Socket())
    req.method = method
    req.url = url
    req.headers = { host: '127.0.0.1:3470', 'content-type': 'application/json' } as IncomingHttpHeaders
    process.nextTick(() => {
      req.push(Buffer.from(JSON.stringify(body)))
      req.push(null)
    })

    let status = 200
    let text = ''
    const res = {
      writeHead(code: number) {
        status = code
        return this
      },
      setHeader() {},
      getHeader() {
        return undefined
      },
      write(chunk: string | Buffer) {
        text += chunk.toString()
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) text += chunk.toString()
        resolve({ status, body: text })
      },
      on() {
        return this
      },
      once() {
        return this
      },
      emit() {
        return false
      },
      removeListener() {
        return this
      },
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

describe('test and suite saves whose target holds a shown marker', () => {
  it('a test save whose target holds a shown marker is refused and nothing is written', async () => {
    const { dir, router } = await composeWorkspace()

    const createdWithMarker = await invoke(router, '/api/tests', 'POST', {
      path: 'tests/masked.yaml',
      content: testContent(MASKED_TARGET),
    })
    expect(createdWithMarker.status).toBe(422)
    expect(JSON.parse(createdWithMarker.body)).toEqual(REFUSAL)
    expect(await exists(join(dir, 'tests', 'masked.yaml'))).toBe(false)

    const created = await invoke(router, '/api/tests', 'POST', {
      path: 'tests/checkout.yaml',
      content: testContent('web'),
    })
    expect(created.status).toBe(201)
    const filePath = join(dir, 'tests', 'checkout.yaml')
    const before = await sha256(filePath)

    const updated = await invoke(router, `/api/tests/${TEST_ID}`, 'PUT', { content: testContent(MASKED_TARGET) })
    expect(updated.status).toBe(422)
    expect(JSON.parse(updated.body)).toEqual(REFUSAL)
    expect(await sha256(filePath)).toBe(before)
  })

  it('a suite save whose target holds a shown marker is refused and nothing is written', async () => {
    const { dir, router } = await composeWorkspace()
    const test = await invoke(router, '/api/tests', 'POST', {
      path: 'tests/checkout.yaml',
      content: testContent('web'),
    })
    expect(test.status).toBe(201)

    const createdWithMarker = await invoke(router, '/api/suites', 'POST', {
      path: 'suites/masked.suite.yaml',
      content: suiteContent(MASKED_TARGET),
    })
    expect(createdWithMarker.status).toBe(422)
    expect(JSON.parse(createdWithMarker.body)).toEqual(REFUSAL)
    expect(await exists(join(dir, 'suites', 'masked.suite.yaml'))).toBe(false)

    const created = await invoke(router, '/api/suites', 'POST', {
      path: 'suites/checkout.suite.yaml',
      content: suiteContent('web'),
    })
    expect(created.status).toBe(201)
    const filePath = join(dir, 'suites', 'checkout.suite.yaml')
    const before = await sha256(filePath)

    const updated = await invoke(router, `/api/suites/${SUITE_ID}`, 'PUT', { content: suiteContent(MASKED_TARGET) })
    expect(updated.status).toBe(422)
    expect(JSON.parse(updated.body)).toEqual(REFUSAL)
    expect(await sha256(filePath)).toBe(before)
  })

  it('a test with a clean target is still created', async () => {
    const { dir, router } = await composeWorkspace()

    const created = await invoke(router, '/api/tests', 'POST', {
      path: 'tests/checkout.yaml',
      content: testContent('web'),
    })

    expect(created.status).toBe(201)
    expect(await readFile(join(dir, 'tests', 'checkout.yaml'), 'utf-8')).toBe(testContent('web'))
  })
})
