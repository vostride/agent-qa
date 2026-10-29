import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'
import { SuiteFileManager } from '../tests/suite-file-manager.js'
import { TestFileManager } from '../tests/test-file-manager.js'

const TEST_ID = 't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle'
const OTHER_TEST_ID = 't_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper'

interface MockResponse {
  status: number
  body: string
}

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function createMockRequest(url: string, headers: IncomingHttpHeaders, body: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = 'POST'
  req.url = url
  req.headers = { host: '127.0.0.1:3470', ...headers }
  process.nextTick(() => {
    req.push(Buffer.from(body))
    req.push(null)
  })
  return req
}

function invoke(router: ReturnType<typeof createRouter>, body: Record<string, unknown>): Promise<MockResponse> {
  return new Promise((resolve) => {
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
    } as unknown as ServerResponse
    // The live-editor doors run the same-site guard, which refuses an absent Host.
    const req = createMockRequest(
      '/api/live-editor/sessions',
      { 'content-type': 'application/json', host: '127.0.0.1:3470' },
      JSON.stringify(body),
    )
    router(req, res)
  })
}

async function workspaceWith(
  testPlanner: string,
  timeouts: { projectNavigation?: string; testNavigation?: string } = {},
): Promise<{
  router: ReturnType<typeof createRouter>
  createSession: ReturnType<typeof vi.fn>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-436-live-limits-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(
    configPath,
    [
      'workspace:',
      '  testMatch:',
      '    - tests/**/*.yaml',
      '  suiteMatch:',
      '    - suites/**/*.suite.yaml',
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'services: {}',
      'registry: {}',
      'use:',
      '  planner:',
      '    maxActions: 20',
      '    maxPlanningTurns: 15',
      ...(timeouts.projectNavigation === undefined
        ? []
        : ['  timeout:', `    navigation: ${timeouts.projectNavigation}`]),
      '',
    ].join('\n'),
    'utf-8',
  )
  await Promise.all([
    writeFile(join(dir, 'hooks.yaml'), 'hooks: []\n', 'utf-8'),
    writeFile(join(dir, '.env'), '', 'utf-8'),
    writeFile(join(dir, '.env.secrets.local'), '', 'utf-8'),
  ])
  await mkdir(join(dir, 'tests'), { recursive: true })
  await writeFile(
    join(dir, 'tests', 'bulk.yaml'),
    [
      `test-id: ${TEST_ID}`,
      'name: Bulk archive',
      'target: web',
      'use:',
      '  planner:',
      testPlanner,
      ...(timeouts.testNavigation === undefined
        ? []
        : ['  timeout:', `    navigation: ${timeouts.testNavigation}`]),
      'steps:',
      '  - archive all',
      '',
    ].join('\n'),
    'utf-8',
  )
  await writeFile(
    join(dir, 'tests', 'plain.yaml'),
    [`test-id: ${OTHER_TEST_ID}`, 'name: Plain', 'target: web', 'steps:', '  - open inbox', ''].join('\n'),
    'utf-8',
  )
  const workspacePaths = resolveWorkspacePaths({
    config: {
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
    },
    configPath,
  })
  const testFileManager = new TestFileManager(workspacePaths)
  const createSession = vi.fn(async () => ({ sessionId: 'live-1', sessionNumber: 3 }))
  const router = createRouter({
    db: { getRuns: () => [], close() {} } as any,
    configManager: new ConfigManager(configPath, (text) => text),
    configPath,
    workspacePaths,
    testFileManager,
    suiteFileManager: new SuiteFileManager(workspacePaths, testFileManager),
    llmConfig: {
      provider: 'anthropic-compatible',
      model: 'claude-sonnet-4-20250514',
      baseURL: 'https://anthropic-proxy.example/messages',
    } as any,
    sessionManager: {
      createSession,
      listSessions: vi.fn(() => []),
      terminateSession: vi.fn(),
    } as any,
  })
  return { router, createSession }
}

// The create door refuses the limits the CLI refuses, before any session.
describe('live door', () => {
  it('a saved test file with an invalid limit is refused with 400 and no session', async () => {
    const { router, createSession } = await workspaceWith('    maxActions: 0')
    const res = await invoke(router, { platform: 'web', entity: { type: 'test', id: TEST_ID } })
    expect(res.status).toBe(400)
    const { error } = JSON.parse(res.body) as { error: string }
    expect(error).toContain(`test file ${TEST_ID} sets use.planner.maxActions to 0: `)
    expect(error).toContain('The CLI refuses this file too.')
    expect(createSession).not.toHaveBeenCalled()
  })

  it('a valid file opens the session with the resolved limits and the per-test closure', async () => {
    const { router, createSession } = await workspaceWith('    maxActions: 80')
    const res = await invoke(router, { platform: 'web', entity: { type: 'test', id: TEST_ID } })
    expect(res.status).toBe(201)
    expect(createSession).toHaveBeenCalledTimes(1)
    const config = (createSession.mock.calls[0] as unknown[])[0] as {
      plannerLimits: unknown
      plannerLimitsForTest: (testId: string) => Promise<unknown>
    }
    expect(config.plannerLimits).toEqual({ maxActions: 80, maxPlanningTurns: 15 })
    expect(typeof config.plannerLimitsForTest).toBe('function')
    expect(await config.plannerLimitsForTest(TEST_ID)).toEqual({ maxActions: 80, maxPlanningTurns: 15 })
    expect(await config.plannerLimitsForTest(OTHER_TEST_ID)).toEqual({ maxActions: 20, maxPlanningTurns: 15 })
  })
})

describe('live door navigation timeout', () => {
  it("the project's use.timeout.navigation reaches the session in milliseconds", async () => {
    const { router, createSession } = await workspaceWith('    maxActions: 80', {
      projectNavigation: '30s',
    })
    const res = await invoke(router, { platform: 'web', entity: { type: 'test', id: OTHER_TEST_ID } })
    expect(res.status).toBe(201)
    const config = (createSession.mock.calls[0] as unknown[])[0] as { navigationTimeoutMs?: number }
    expect(config.navigationTimeoutMs).toBe(30_000)
  })

  it("the edited test's use.timeout.navigation wins over the project's", async () => {
    const { router, createSession } = await workspaceWith('    maxActions: 80', {
      projectNavigation: '30s',
      testNavigation: '5s',
    })
    const res = await invoke(router, { platform: 'web', entity: { type: 'test', id: TEST_ID } })
    expect(res.status).toBe(201)
    const config = (createSession.mock.calls[0] as unknown[])[0] as { navigationTimeoutMs?: number }
    expect(config.navigationTimeoutMs).toBe(5_000)
  })

  it('no configured navigation timeout leaves it unset', async () => {
    const { router, createSession } = await workspaceWith('    maxActions: 80')
    const res = await invoke(router, { platform: 'web', entity: { type: 'test', id: TEST_ID } })
    expect(res.status).toBe(201)
    const config = (createSession.mock.calls[0] as unknown[])[0] as { navigationTimeoutMs?: number }
    expect(config.navigationTimeoutMs).toBeUndefined()
  })

  it('an invalid use.timeout.navigation is refused with 400 and no session', async () => {
    const { router, createSession } = await workspaceWith('    maxActions: 80', {
      testNavigation: 'soon',
    })
    const res = await invoke(router, { platform: 'web', entity: { type: 'test', id: TEST_ID } })
    expect(res.status).toBe(400)
    const { error } = JSON.parse(res.body) as { error: string }
    expect(error).toContain(`test file ${TEST_ID} sets use.timeout.navigation to "soon": `)
    expect(error).toContain('The CLI refuses this file too.')
    expect(createSession).not.toHaveBeenCalled()
  })
})
