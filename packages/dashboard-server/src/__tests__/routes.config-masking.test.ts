import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConfigManager } from '../config/index.js'
import { createRouter } from '../server/routes.js'

const AUTH_SENTINEL = 'sk-live-AUTH-DO-NOT-LEAK'

vi.mock('@vostride/agent-qa-core', async () => {
  const actual =
    await vi.importActual<typeof import('@vostride/agent-qa-core')>('@vostride/agent-qa-core')
  return {
    ...actual,
    getAgentQaVersion: vi.fn(() => '0.1.13'),
    readAuth: vi.fn(() =>
      Promise.resolve({
        gpt: { type: 'api-key', provider: 'anthropic-compatible', key: 'sk-live-AUTH-DO-NOT-LEAK' },
      }),
    ),
    writeAuth: vi.fn(() => Promise.resolve()),
    removeAuth: vi.fn(() => Promise.resolve()),
  }
})

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: string
}

interface FileLine {
  n: number
  text: string
}

const HOST = '127.0.0.1:4317'

let router: ReturnType<typeof createRouter>
const tempDirs: string[] = []

function createMockDatabase() {
  return {
    getRuns() {
      return []
    },
    close() {},
  }
}

function createMockRequest(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = options.method ?? 'GET'
  req.url = url
  req.headers = { host: '127.0.0.1:3470', ...options.headers }

  process.nextTick(() => {
    if (options.body) {
      req.push(Buffer.from(options.body))
    }
    req.push(null)
  })

  return req
}

async function invokeRoute(
  url: string,
  options: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {},
): Promise<MockResponse> {
  return await new Promise((resolve, reject) => {
    const req = createMockRequest(url, options)
    const headers = new Map<string, string>()
    let status = 200
    let body = ''

    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(statusCode: number, head?: Record<string, string | number>) {
        status = statusCode
        if (head) {
          for (const [key, value] of Object.entries(head)) {
            headers.set(key.toLowerCase(), String(value))
          }
        }
        return this
      },
      setHeader(name: string, value: string) {
        headers.set(name.toLowerCase(), value)
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase())
      },
      write(chunk: string | Buffer) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        return true
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk
        }
        resolve({ status, headers: Object.fromEntries(headers), body })
      },
      destroy() {
        resolve({ status, headers: Object.fromEntries(headers), body })
      },
    } as unknown as ServerResponse

    try {
      router(req, res)
    } catch (error) {
      reject(error)
    }
  })
}

const SENTINELS = {
  header: 'sk-live-HEADER-DO-NOT-LEAK',
  access: 'sk-live-ACCESS-DO-NOT-LEAK',
  udid: 'UDID-DO-NOT-LEAK-0001',
  attribute: 'ATTR-DO-NOT-LEAK-main',
  secretsFile: 'secrets-DO-NOT-LEAK.local',
  certificate: 'CERT-DO-NOT-LEAK-line',
}

const secretConfig = [
  '# owner notes: the access key rotates monthly',
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  `  secretsFile: ${SENTINELS.secretsFile}`,
  'services:',
  '  mcp:',
  '    enabled: true',
  '    port: 3471',
  'registry:',
  '  llms:',
  '    - name: gpt',
  '      provider: anthropic-compatible',
  '      model: claude-proxy',
  '      baseURL: https://llm.example.test/v1',
  '      providerHeaders:',
  `        x-org-route: ${SENTINELS.header}`,
  `        x-org-access: ${SENTINELS.access} # rotated by the owner`,
  '  devices:',
  '    phone:',
  '      platform: ios',
  '      match:',
  `        udid: ${SENTINELS.udid}`,
  'analytics:',
  '  passRateScope:',
  '    attributes:',
  `      branch: ${SENTINELS.attribute}`,
  '      certificate: |',
  `        ${SENTINELS.certificate}-one`,
  `        ${SENTINELS.certificate}-two`,
  'plugins:',
  '  auth:',
  '    - package: "@example/agent-qa-auth"',
  'use:',
  '  llm: gpt',
  '  mobile:',
  '    appState: preserve',
  '',
].join('\n')

function declaredMask(declared: Record<string, string>): (text: string) => string {
  return (text) => Object.entries(declared)
    .reduce((shown, [name, value]) => shown.split(value).join(`[secret:${name}]`), text)
}

async function useConfigWorkspace(
  initialConfig = secretConfig,
  mask: (text: string) => string = (text) => text,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-config-masking-'))
  tempDirs.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  await writeFile(configPath, initialConfig, 'utf-8')
  router = createRouter({
    db: createMockDatabase() as any,
    configManager: new ConfigManager(configPath, mask),
    configPath,
  })
  return configPath
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

async function getConfig() {
  const response = await invokeRoute('/api/config', { headers: { host: HOST } })
  return { response, body: JSON.parse(response.body) as Record<string, any> }
}

async function getRevision(): Promise<string> {
  const response = await invokeRoute('/api/config/revision', { headers: { host: HOST } })
  expect(response.status).toBe(200)
  return (JSON.parse(response.body) as { revision: string }).revision
}

function lineHolding(lines: FileLine[], fragment: string): FileLine {
  const line = lines.find((candidate) => candidate.text.includes(fragment))
  expect(line, `a line holding ${fragment}`).toBeDefined()
  return line!
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('GET /api/config through the declared mask', () => {
  it('GET-CARRIES-NO-SECRET: every declared value reads as its marker, an undeclared one as written, and no auth.json value is sent', async () => {
    await useConfigWorkspace(secretConfig, declaredMask({ ACCESS_KEY: SENTINELS.access, ROUTE_KEY: SENTINELS.header }))

    const { response, body } = await getConfig()

    expect(response.status).toBe(200)
    for (const sentinel of [SENTINELS.access, SENTINELS.header, AUTH_SENTINEL]) {
      expect(response.body).not.toContain(sentinel)
    }
    const { config } = body
    expect(config.registry.llms[0].providerHeaders['x-org-route']).toBe('[secret:ROUTE_KEY]')
    expect(config.registry.llms[0].providerHeaders['x-org-access']).toBe('[secret:ACCESS_KEY]')
    expect(config.analytics.passRateScope.attributes.certificate)
      .toBe(`${SENTINELS.certificate}-one\n${SENTINELS.certificate}-two\n`)
    expect(config.registry.devices.phone.match.udid).toBe(SENTINELS.udid)
    expect(config.analytics.passRateScope.attributes.branch).toBe(SENTINELS.attribute)
    expect(config.workspace.secretsFile).toBe(SENTINELS.secretsFile)
    expect(config.registry.llms[0].baseURL).toBe('https://llm.example.test/v1')
    const lines = body.file.lines as FileLine[]
    expect(lineHolding(lines, 'x-org-access:').text).toBe('        x-org-access: [secret:ACCESS_KEY] # rotated by the owner')
    expect(lineHolding(lines, 'x-org-route:').text).toBe('        x-org-route: [secret:ROUTE_KEY]')
  })

  // 432-22 (D-12): re-spelled. The two env-var-name leaves were the MCP and run-service token
  // variables, deleted with their lists; the surviving claim is that a non-secret leaf reads in clear
  // in both the payload and the file view, and no line is tagged as an env-var name any more.
  it('ENV-VAR-NAME-IN-CLEAR: a plain MCP leaf reads in clear in the payload and the file view, and no line is an env-var name', async () => {
    await useConfigWorkspace()

    const { body } = await getConfig()

    expect(body.config.services.mcp.port).toBe(3471)
    const line = lineHolding(body.file.lines, 'port: 3471')
    expect(line).toEqual({ n: line.n, text: '    port: 3471' })
    expect((body.file.lines as { class?: string }[]).filter(entry => entry.class === 'env-var-name')).toEqual([])
  })

  it('GET-HAS-REVISION-AND-FILE: config and provider stay, revision and the file view are added', async () => {
    const configPath = await useConfigWorkspace()

    const { response, body } = await getConfig()

    expect(response.status).toBe(200)
    expect(body.provider).toBe('anthropic-compatible')
    expect(body.config.use.llm).toBe('gpt')
    const onDisk = await readFile(configPath, 'utf-8')
    expect(body.revision).toBe(sha256(onDisk))
    expect(onDisk).toContain('# owner notes: the access key rotates monthly')
    expect(body.file.path).toBe(configPath)
    const lines = body.file.lines as FileLine[]
    expect(lines.map((line) => line.n)).toEqual(lines.map((_, i) => i + 1))
    expect(lines.map((line) => line.text)).toEqual(onDisk.trimEnd().split('\n'))
    expect(lines[0]).toEqual({ n: 1, text: '# owner notes: the access key rotates monthly' })
    expect(lineHolding(lines, 'package:').text).toBe('    - package: "@example/agent-qa-auth"')
    expect(body).not.toHaveProperty('fileIssues')
  })

  it('FILE-VIEW-LINES-UNCLASSED: every line is the file line through the mask, with no class or path tag', async () => {
    await useConfigWorkspace(secretConfig, declaredMask({ CERT: SENTINELS.certificate }))

    const { body } = await getConfig()
    const lines = body.file.lines as FileLine[]

    expect(lines).toHaveLength(secretConfig.trimEnd().split('\n').length)
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['n', 'text'])
    const certificate = lineHolding(lines, 'certificate:')
    expect(lines[certificate.n]!.text).toBe('        [secret:CERT]-one')
    expect(lines[certificate.n + 1]!.text).toBe('        [secret:CERT]-two')
    expect(lineHolding(lines, 'udid:').text).toBe(`        udid: ${SENTINELS.udid}`)
  })

  it('REVISION-CHANGES-ON-OUTSIDE-EDIT: the revision read follows the bytes and matches a PATCH answer', async () => {
    const configPath = await useConfigWorkspace()

    const first = await getRevision()
    expect(first).toBe((await getConfig()).body.revision)

    const outside = secretConfig.replace('appState: preserve', 'appState: reset')
    await writeFile(configPath, outside, 'utf-8')
    const second = await getRevision()
    expect(second).not.toBe(first)
    expect(second).toBe(sha256(outside))

    const patch = await invokeRoute('/api/config', {
      method: 'PATCH',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({
        changes: [
          { op: 'set', path: ['use', 'llm'], value: 'gpt' },
          { op: 'set', path: ['use', 'mobile', 'appState'], value: 'preserve' },
        ],
      }),
    })
    expect(patch.status).toBe(200)
    const written = (JSON.parse(patch.body) as { revision: string }).revision
    expect(await getRevision()).toBe(written)

    await rm(configPath)
    expect(await getRevision()).toBe('absent')
  })

  it('GET-FILE-INVALID-NAMED: a file that does not parse is named with 409 and the revision still answers', async () => {
    const configPath = await useConfigWorkspace()
    const broken = `a: 1\nb: [1, ${SENTINELS.access}\nc: 3\n`
    await writeFile(configPath, broken, 'utf-8')

    const { response, body } = await getConfig()

    expect(response.status).toBe(409)
    expect(body.error).toBe('file_invalid')
    expect(typeof body.message).toBe('string')
    expect(body.message).not.toBe('')
    expect(response.body).not.toContain(SENTINELS.access)
    expect(Object.keys(body).sort()).toEqual(['error', 'message'])
    expect(await getRevision()).toBe(sha256(broken))

    await writeFile(configPath, secretConfig, 'utf-8')
    expect((await getConfig()).response.status).toBe(200)
  })

  it('GET-FILE-ISSUES: a file that parses but fails whole-config validation answers 200 naming each issue', async () => {
    await useConfigWorkspace(
      secretConfig.replace('  llm: gpt', '  llm: missing-model'),
      declaredMask(Object.fromEntries(Object.entries(SENTINELS).map(([name, value]) => [name.toUpperCase(), value]))),
    )

    const { response, body } = await getConfig()

    expect(response.status).toBe(200)
    expect(body.config.use.llm).toBe('missing-model')
    const issues = body.fileIssues as Array<{ path: Array<string | number>; message: string }>
    expect(Array.isArray(issues)).toBe(true)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((issue) => issue.message.includes('missing-model'))).toBe(true)
    for (const issue of issues) {
      expect(Array.isArray(issue.path)).toBe(true)
      expect(typeof issue.message).toBe('string')
    }
    expect(response.body).not.toContain('DO-NOT-LEAK')
  })
})

const COMMENT_SENTINELS = {
  head: 'HEAD-COMMENT-DO-NOT-SERVE',
  sequence: 'SEQ-COMMENT-DO-NOT-SERVE',
  tail: 'TAIL-COMMENT-DO-NOT-SERVE',
}

const commentedSecrets = ['sk-OLD-SECRET-123456', 'sk-PREV-777', 'sk-LIVE-999']

const commentedConfig = [
  `# ${COMMENT_SENTINELS.head}`,
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  `    # ${COMMENT_SENTINELS.sequence}`,
  '    - more/**/*.yaml',
  'registry:',
  '  llms:',
  '    - name: gpt',
  '      provider: anthropic-compatible',
  '      model: claude-proxy',
  '      baseURL: https://llm.example.test/v1',
  '      providerHeaders:',
  '        # x-api-key: sk-OLD-SECRET-123456',
  '        x-team: "sk-LIVE-999" # was sk-PREV-777',
  'use:',
  '  llm: gpt',
  `# ${COMMENT_SENTINELS.tail}`,
  '',
].join('\n')

describe('GET /api/config serves comments through the declared mask', () => {
  it('COMMENTED-SECRET-MASKED: a comment is served as written, and a declared value in it reads as its marker', async () => {
    const [oldSecret, prevSecret, liveSecret] = commentedSecrets
    const configPath = await useConfigWorkspace(
      commentedConfig,
      declaredMask({ OLD_KEY: oldSecret!, LIVE_KEY: liveSecret! }),
    )

    const { response, body } = await getConfig()

    expect(response.status).toBe(200)
    const served = JSON.stringify(body)
    expect(served).not.toContain(oldSecret)
    expect(served).not.toContain(liveSecret)
    const lines = body.file.lines as FileLine[]
    expect(lines.map((line) => line.n)).toEqual(lines.map((_, i) => i + 1))
    expect(lineHolding(lines, COMMENT_SENTINELS.head).text).toBe(`# ${COMMENT_SENTINELS.head}`)
    expect(lineHolding(lines, 'x-api-key:').text).toBe('        # x-api-key: [secret:OLD_KEY]')
    expect(lineHolding(lines, 'x-team:').text).toBe(`        x-team: "[secret:LIVE_KEY]" # was ${prevSecret}`)
    expect(body.config.registry.llms[0].providerHeaders['x-team']).toBe('[secret:LIVE_KEY]')
    expect(body.config.workspace.testMatch).toEqual(['tests/**/*.yaml', 'more/**/*.yaml'])
    const onDisk = await readFile(configPath, 'utf-8')
    expect(onDisk).toBe(commentedConfig)
    expect(body.revision).toBe(sha256(onDisk))
  })
})

describe('GET /api/config is same-site only with no cross-origin grant', () => {
  it('GET-CONFIG-SAME-SITE-NO-GRANT: a cross-site or rebinding caller is refused before the read, and no answer grants a cross-origin read', async () => {
    const configPath = await useConfigWorkspace(commentedConfig)
    const readMasked = vi.spyOn(ConfigManager.prototype, 'readMasked')

    const crossSite = await invokeRoute('/api/config', {
      headers: { host: HOST, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)
    expect(JSON.parse(crossSite.body)).toEqual({ error: 'cross_site_refused' })
    expect(crossSite.headers).not.toHaveProperty('access-control-allow-origin')

    const rebinding = await invokeRoute('/api/config', { headers: { host: 'evil.example' } })
    expect(rebinding.status).toBe(403)
    expect(JSON.parse(rebinding.body)).toEqual({ error: 'cross_site_refused' })
    expect(rebinding.headers).not.toHaveProperty('access-control-allow-origin')
    expect(readMasked).not.toHaveBeenCalled()

    const sameOrigin = {
      host: HOST,
      origin: `http://${HOST}`,
      'sec-fetch-site': 'same-origin',
    }
    const own = await invokeRoute('/api/config', { headers: sameOrigin })
    expect(own.status).toBe(200)
    expect(own.headers).not.toHaveProperty('access-control-allow-origin')
    expect(JSON.parse(own.body).file.path).toBe(configPath)

    await writeFile(configPath, 'a: [1, 2\n', 'utf-8')
    const invalid = await invokeRoute('/api/config', { headers: sameOrigin })
    expect(invalid.status).toBe(409)
    expect(JSON.parse(invalid.body).error).toBe('file_invalid')
    expect(invalid.headers).not.toHaveProperty('access-control-allow-origin')

    router = createRouter({ db: createMockDatabase() as any })
    const unavailable = await invokeRoute('/api/config', { headers: sameOrigin })
    expect(unavailable.status).toBe(501)
    expect(unavailable.headers).not.toHaveProperty('access-control-allow-origin')
    readMasked.mockRestore()
  })
})
