import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { type IncomingHttpHeaders, IncomingMessage, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'

import { createRouter } from '../server/routes.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { TestFileManager } from '../tests/test-file-manager.js'

// A duplicate `name` key: content the Save door must refuse with the validator's errors.
const WALK_INVALID_CONTENT = [
  'name: Invalid 433 probe',
  'target: example-web',
  'name: Duplicate name',
  'steps: [Open the page]',
  '',
].join('\n')

const VALID_TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'

function validContent(name: string): string {
  return [`test-id: ${VALID_TEST_ID}`, `name: ${name}`, 'target: web', 'steps:', '  - Open the page', ''].join('\n')
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
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-433-save-'))
  tempDirs.push(dir)
  const workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['**/*.yaml'],
        suiteMatch: ['**/*.suite.yaml'],
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
  const router = createRouter({ db: { getRuns: () => [], close() {} } as any, workspacePaths, testFileManager, suiteFileManager })
  return { dir, router, testFileManager }
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

describe('test saves refuse invalid content', () => {
  it('POST refuses a repeated key and writes nothing', async () => {
    const { dir, router, testFileManager } = await composeWorkspace()

    const res = await invoke(router, '/api/tests', 'POST', { path: 'tests/invalid-433.yaml', content: WALK_INVALID_CONTENT })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; errors: Array<{ line?: number; column?: number }> }
    expect(data.error).toBe('invalid_test_file')
    expect(data.errors[0].line).toBe(3)
    expect(data.errors).toEqual((await testFileManager.validate(WALK_INVALID_CONTENT)).errors)
    expect(await exists(join(dir, 'tests', 'invalid-433.yaml'))).toBe(false)
  })

  it('PUT refuses invalid content and leaves the file unchanged', async () => {
    const { dir, router, testFileManager } = await composeWorkspace()
    const created = await invoke(router, '/api/tests', 'POST', { path: 'tests/login.yaml', content: validContent('Login') })
    expect(created.status).toBe(201)
    const filePath = join(dir, 'tests', 'login.yaml')
    const before = await sha256(filePath)

    const res = await invoke(router, `/api/tests/${VALID_TEST_ID}`, 'PUT', { content: WALK_INVALID_CONTENT })

    expect(res.status).toBe(400)
    const data = JSON.parse(res.body) as { error: string; errors: Array<{ line?: number }> }
    expect(data.error).toBe('invalid_test_file')
    expect(data.errors[0].line).toBe(3)
    expect(data.errors).toEqual((await testFileManager.validate(WALK_INVALID_CONTENT)).errors)
    expect(await sha256(filePath)).toBe(before)
  })

  it('valid content still saves', async () => {
    const { dir, router } = await composeWorkspace()
    const filePath = join(dir, 'tests', 'login.yaml')

    const created = await invoke(router, '/api/tests', 'POST', { path: 'tests/login.yaml', content: validContent('Login') })
    expect(created.status).toBe(201)
    expect(await readFile(filePath, 'utf-8')).toBe(validContent('Login'))

    const updated = await invoke(router, `/api/tests/${VALID_TEST_ID}`, 'PUT', { content: validContent('Login renamed') })
    expect(updated.status).toBe(200)
    expect(await readFile(filePath, 'utf-8')).toBe(validContent('Login renamed'))
  })
})
