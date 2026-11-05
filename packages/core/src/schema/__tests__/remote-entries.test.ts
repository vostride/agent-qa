import { describe, expect, it } from 'vitest'
import { AgentQaConfigSchema } from '../config-schema.js'

const workspace = {
  testMatch: ['tests/**/*.yaml'],
  suiteMatch: ['suites/**/*.suite.yaml'],
  hooksFile: 'hooks.yaml',
  envFile: '.env',
  secretsFile: '.env.secrets.local',
}

function configWith(remotes: unknown[], extra: Record<string, unknown> = {}) {
  return { workspace, registry: { remotes }, ...extra }
}

function parse(remote: Record<string, unknown>) {
  return AgentQaConfigSchema.safeParse(configWith([remote]))
}

function messages(remote: Record<string, unknown>): string[] {
  const result = parse(remote)
  return result.success ? [] : result.error.issues.map(issue => issue.message)
}

function expectAccepted(remote: Record<string, unknown>) {
  const result = parse(remote)
  expect(result.success ? [] : result.error.issues.map(issue => issue.message)).toEqual([])
}

function expectRefused(remote: Record<string, unknown>, message: string) {
  expect(messages(remote)).toContain(message)
}

const grid = { name: 'grid', protocol: 'playwright', url: 'wss://grid.example.com/playwright' }
const debuggerRemote = { name: 'debugger', protocol: 'cdp', url: 'https://cdp.example.com' }
const farm = { name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }

describe('registry.remotes entries', () => {
  it('accepts a playwright entry and a cdp entry', () => {
    const result = AgentQaConfigSchema.safeParse(
      configWith([
        {
          ...grid,
          headers: { Authorization: 'Bearer {{secret:GRID_TOKEN}}' },
          connectTimeout: '45s',
        },
        { ...debuggerRemote, context: 'reuse', query: { token: '{{secret:CDP_TOKEN}}' } },
      ]),
    )
    expect(result.success ? [] : result.error.issues.map(issue => issue.message)).toEqual([])
  })

  it('reports a refusal at the entry path with the entry name in the message', () => {
    const result = parse({ ...grid, headers: { 'x-token': 'abc' } })
    expect(result.success).toBe(false)
    const issue = result.success ? undefined : result.error.issues[0]
    expect(issue?.path).toEqual(['registry', 'remotes', 0, 'headers', 'x-token'])
    expect(issue?.message).toMatch(/^Remote grid: /)
  })

  it('refuses a url that does not parse', () => {
    expectRefused({ ...grid, url: 'grid.example.com' }, 'Remote grid: the url is not a valid url.')
  })

  it('refuses a playwright url that is not ws:// or wss://', () => {
    expectRefused(
      { ...grid, url: 'http://grid.example.com/playwright' },
      'Remote grid: a playwright url starts with ws:// or wss://.',
    )
    expectRefused(
      { ...grid, url: 'https://grid.example.com/playwright' },
      'Remote grid: a playwright url starts with ws:// or wss://.',
    )
  })

  it('accepts an appium entry with an https url and referenced credentials', () => {
    expectAccepted(farm)
    expectAccepted({
      ...farm,
      basicAuth: { user: 'qa', password: '{{secret:FARM_KEY}}' },
      connectTimeout: '45s',
    })
  })

  it('accepts capabilities on an appium entry, with credentials as references', () => {
    const result = parse({
      ...farm,
      capabilities: {
        'appium:newCommandTimeout': 120,
        'farm:options': { project: 'shop', accessKey: '{{secret:FARM_KEY}}' },
      },
    })
    expect(result.success ? [] : result.error.issues.map(issue => issue.message)).toEqual([])
    expect(result.success && result.data.registry?.remotes[0]?.capabilities).toEqual({
      'appium:newCommandTimeout': 120,
      'farm:options': { project: 'shop', accessKey: '{{secret:FARM_KEY}}' },
    })
  })

  it('refuses capabilities on a playwright remote', () => {
    expectRefused(
      { ...grid, capabilities: { 'grid:options': { project: 'shop' } } },
      'Remote grid: capabilities apply to appium remotes only.',
    )
  })

  it('refuses an appium url that is not http:// or https://', () => {
    for (const url of ['ws://farm.example.com/wd/hub', 'wss://farm.example.com/wd/hub']) {
      expectRefused({ ...farm, url }, 'Remote farm: an appium url starts with http:// or https://.')
    }
  })

  it('accepts ws, wss, http and https on a cdp remote and refuses any other scheme', () => {
    const urls = [
      'ws://127.0.0.1:9222',
      'wss://cdp.example.com',
      'http://localhost:9222',
      'https://cdp.example.com',
    ]
    for (const url of urls) {
      expectAccepted({ ...debuggerRemote, url })
    }
    expectRefused(
      { ...debuggerRemote, url: 'ftp://cdp.example.com' },
      'Remote debugger: a cdp url starts with ws://, wss://, http:// or https://.',
    )
  })

  it('refuses a token in the url scheme, host or port', () => {
    const sentence =
      "Remote grid: write the url's scheme, host and port out; references belong in its path, query or headers."
    expectRefused({ ...grid, url: 'wss://{{secret:GRID_HOST}}/playwright' }, sentence)
    expectRefused({ ...grid, url: 'wss://grid.example.com:{{secret:PORT}}/playwright' }, sentence)
    expectRefused({ ...grid, url: '{{secret:SCHEME}}://grid.example.com' }, sentence)
  })

  it('refuses a user name or password in the url', () => {
    const sentence =
      'Remote grid: the url carries a user name or password. Move them to basicAuth with {{secret:NAME}} references.'
    expectRefused({ ...grid, url: 'wss://user:pass@grid.example.com/playwright' }, sentence)
    expectRefused({ ...grid, url: 'wss://user@grid.example.com/playwright' }, sentence)
  })

  it('refuses a literal value under a credential-named header', () => {
    expectRefused(
      { ...grid, headers: { Authorization: 'Bearer abc' } },
      'Remote grid: headers "Authorization" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
  })

  it('needs a reference for token, apiKey and Cookie names, whatever their case', () => {
    expectRefused(
      { ...grid, query: { token: 'abc' } },
      'Remote grid: query "token" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectRefused(
      { ...grid, query: { apiKey: 'abc' } },
      'Remote grid: query "apiKey" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectRefused(
      { ...grid, headers: { Cookie: 'session=abc' } },
      'Remote grid: headers "Cookie" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectAccepted({
      ...grid,
      query: { token: '{{secret:GRID_TOKEN}}', apiKey: '{{secret:GRID_KEY}}' },
      headers: { Cookie: 'session={{secret:GRID_COOKIE}}' },
    })
  })

  it('needs a reference for a credential-named parameter written in the url itself', () => {
    expectRefused(
      { ...grid, url: 'wss://grid.example.com/?token=literal-abc123' },
      'Remote grid: url query "token" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectRefused(
      { ...grid, url: 'wss://grid.example.com/playwright?browser=chromium&api%4Bey=abc#top' },
      'Remote grid: url query "apiKey" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectRefused(
      { ...grid, url: 'wss://grid.example.com/?token' },
      'Remote grid: url query "token" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectAccepted({
      ...grid,
      url: 'wss://grid.example.com/?token={{secret:GRID_TOKEN}}&browser=chromium',
    })
  })

  it('counts a credential-named url parameter as a credential on a cleartext channel', () => {
    expectRefused(
      { ...grid, url: 'ws://grid.example.com/?token=abc' },
      'Remote grid: credentials go over ws:// only to this machine. Use wss:// for grid.example.com.',
    )
    expectAccepted({ ...grid, url: 'ws://127.0.0.1:3000/?token={{secret:GRID_TOKEN}}' })
  })

  it('refuses a nested query credential literal and accepts the same key as a reference', () => {
    expectRefused(
      { ...grid, query: { caps: { grid: { accessKey: 'abc' } } } },
      'Remote grid: query "caps.grid.accessKey" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectAccepted({ ...grid, query: { caps: { grid: { accessKey: '{{secret:GRID_KEY}}' } } } })
  })

  it('refuses a literal jwt in a cdp url at the entry url and accepts it as a reference', () => {
    const result = parse({
      ...debuggerRemote,
      url: 'wss://cdp.example.com/browser/cdp?jwt=literal-1a2b',
    })
    expect(result.success).toBe(false)
    const issues = result.success
      ? []
      : result.error.issues.map(issue => ({ path: issue.path, message: issue.message }))
    expect(issues).toEqual([
      {
        path: ['registry', 'remotes', 0, 'url'],
        message:
          'Remote debugger: url query "jwt" names a credential, so its value must be a {{secret:NAME}} reference.',
      },
    ])
    expectAccepted({
      ...debuggerRemote,
      url: 'wss://cdp.example.com/browser/cdp?jwt={{secret:CDP_JWT}}',
    })
  })

  it('refuses a literal credential inside a JSON query value at the path of the same value written as a map', () => {
    const result = parse({
      ...grid,
      query: { capabilities: '{"grid:options":{"accessKey":"literal-9f3e"}}' },
    })
    expect(result.success).toBe(false)
    const issues = result.success
      ? []
      : result.error.issues.map(issue => ({ path: issue.path, message: issue.message }))
    expect(issues).toEqual([
      {
        path: ['registry', 'remotes', 0, 'query', 'capabilities', 'grid:options', 'accessKey'],
        message:
          'Remote grid: query "capabilities.grid:options.accessKey" names a credential, so its value must be a {{secret:NAME}} reference.',
      },
    ])
    expectAccepted({
      ...grid,
      query: { capabilities: '{"grid:options":{"accessKey":"{{secret:GRID_KEY}}"}}' },
    })
  })

  it('accepts true, false or null under a credential-named query key and refuses a string or number beside it', () => {
    const refusal =
      'Remote grid: query "caps.secret" names a credential, so its value must be a {{secret:NAME}} reference.'
    expectAccepted({ ...grid, query: { caps: { secret: { on: true, off: false, unset: null } } } })
    expectRefused({ ...grid, query: { caps: { secret: { value: 42, on: true } } } }, refusal)
    expectRefused({ ...grid, query: { caps: { secret: { on: true, note: 'literal' } } } }, refusal)
  })

  it('accepts a non-credential query value as a literal', () => {
    expectAccepted({ ...grid, query: { caps: { browser: 'chromium', build: 'nightly' } } })
  })

  it('refuses a literal basicAuth password and accepts a referenced one', () => {
    expectRefused(
      { ...debuggerRemote, basicAuth: { user: 'qa', password: 'hunter2' } },
      'Remote debugger: basicAuth "password" names a credential, so its value must be a {{secret:NAME}} reference.',
    )
    expectAccepted({
      ...debuggerRemote,
      basicAuth: { user: 'qa', password: '{{secret:CDP_PASSWORD}}' },
    })
  })

  it('sends a credential over ws:// only to this machine', () => {
    const referenced = { query: { token: '{{secret:GRID_TOKEN}}' } }
    expectAccepted({ ...grid, ...referenced, url: 'ws://127.0.0.1:3000/playwright' })
    expectAccepted({ ...grid, ...referenced, url: 'ws://localhost:3000/playwright' })
    expectRefused(
      { ...grid, ...referenced, url: 'ws://grid.example.com/playwright' },
      'Remote grid: credentials go over ws:// only to this machine. Use wss:// for grid.example.com.',
    )
  })

  it('sends a credential over http:// only to this machine', () => {
    const withAuth = { basicAuth: { user: 'qa', password: '{{secret:CDP_PASSWORD}}' } }
    expectAccepted({ ...debuggerRemote, ...withAuth, url: 'http://[::1]:9222' })
    expectRefused(
      { ...debuggerRemote, ...withAuth, url: 'http://cdp.example.com:9222' },
      'Remote debugger: credentials go over http:// only to this machine. Use https:// for cdp.example.com.',
    )
  })

  it('treats a reference in the url path as a credential on a cleartext channel', () => {
    expectRefused(
      { ...grid, url: 'ws://grid.example.com/{{secret:GRID_PATH}}/playwright' },
      'Remote grid: credentials go over ws:// only to this machine. Use wss:// for grid.example.com.',
    )
  })

  it('accepts a cleartext url to another host when the entry carries no credential', () => {
    expectAccepted({ ...grid, url: 'ws://grid.example.com/playwright' })
  })

  it('refuses context on a playwright or appium remote and accepts it on a cdp remote', () => {
    expectRefused({ ...grid, context: 'new' }, 'Remote grid: context applies to cdp remotes only.')
    expectRefused({ ...farm, context: 'new' }, 'Remote farm: context applies to cdp remotes only.')
    expectAccepted({ ...debuggerRemote, context: 'new' })
  })

  it('refuses basicAuth together with an Authorization header in any case', () => {
    expectRefused(
      {
        ...debuggerRemote,
        basicAuth: { user: 'qa', password: '{{secret:CDP_PASSWORD}}' },
        headers: { authorization: 'Bearer {{secret:CDP_TOKEN}}' },
      },
      'Remote debugger: set basicAuth or an Authorization header, not both.',
    )
  })

  it('refuses {{playwright:version}} inside basicAuth', () => {
    expectRefused(
      {
        ...debuggerRemote,
        basicAuth: { user: 'qa-{{playwright:version}}', password: '{{secret:P}}' },
      },
      'Remote debugger: {{playwright:version}} belongs in the url, query or header values.',
    )
  })

  it('accepts {{playwright:version}} in the url path, a query value and a header value', () => {
    expectAccepted({
      ...grid,
      url: 'wss://grid.example.com/playwright/{{playwright:version}}',
      query: { caps: { client: '{{playwright:version}}' }, version: '{{playwright:version}}' },
      headers: { 'x-client-version': '{{playwright:version}}' },
    })
  })

  it('refuses a token in a header name, a query key or a nested query key', () => {
    expectRefused(
      { ...grid, headers: { 'x-{{playwright:version}}': 'yes' } },
      'Remote grid: headers key "x-{{playwright:version}}" carries a {{…}} token; tokens belong in values only.',
    )
    expectRefused(
      { ...grid, query: { '{{playwright:version}}': 'yes' } },
      'Remote grid: query key "{{playwright:version}}" carries a {{…}} token; tokens belong in values only.',
    )
    expectRefused(
      { ...grid, query: { caps: { '{{playwright:version}}': 'yes' } } },
      'Remote grid: query key "caps.{{playwright:version}}" carries a {{…}} token; tokens belong in values only.',
    )
    expectRefused(
      { ...grid, query: { '{{secret:NAME}}': 'yes' } },
      'Remote grid: query key "{{secret:NAME}}" carries a {{…}} token; tokens belong in values only.',
    )
  })

  it('refuses a maxSession key as unrecognized', () => {
    const result = parse({ ...grid, maxSession: '30m' })
    expect(result.success).toBe(false)
    const codes = result.success ? [] : result.error.issues.map(issue => issue.code)
    expect(codes).toContain('unrecognized_keys')
  })
})

describe('remote names, the default pick and target urls', () => {
  function issues(config: Record<string, unknown>) {
    const result = AgentQaConfigSchema.safeParse(config)
    return result.success
      ? []
      : result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
  }

  const secured = {
    ...grid,
    headers: { Authorization: 'Bearer {{secret:GRID_TOKEN}}' },
  }

  it('accepts unique remotes, a listed default pick and target urls with other secrets', () => {
    const config = {
      workspace,
      registry: {
        remotes: [secured, debuggerRemote],
        targets: {
          shop: { platform: 'web', url: 'https://shop.example.com/?key={{secret:SHOP_KEY}}' },
        },
      },
      use: { browser: { name: 'chromium', headless: true, remote: 'grid' } },
    }
    expect(issues(config)).toEqual([])
  })

  it('accepts local as the default pick', () => {
    const config = configWith([secured], {
      use: { browser: { name: 'chromium', headless: true, remote: 'local' } },
    })
    expect(issues(config)).toEqual([])
  })

  it('refuses a duplicate remote name', () => {
    expect(issues(configWith([grid, { ...debuggerRemote, name: 'grid' }]))).toContainEqual({
      path: 'registry.remotes',
      message: 'Duplicate remote name: "grid"',
    })
  })

  it('refuses a remote named local', () => {
    expect(issues(configWith([debuggerRemote, { ...grid, name: 'local' }]))).toContainEqual({
      path: 'registry.remotes.1.name',
      message: 'Remote name "local" is reserved: local means this machine. Rename the remote.',
    })
  })

  it('refuses a default pick that names no listed remote', () => {
    const config = configWith([grid, debuggerRemote], {
      use: { browser: { name: 'chromium', headless: true, remote: 'gird' } },
    })
    expect(issues(config)).toContainEqual({
      path: 'use.browser.remote',
      message:
        'Unknown remote "gird" in agent-qa.config.yaml. registry.remotes lists: grid, debugger.',
    })
  })

  it('refuses a default pick that names an appium remote', () => {
    const config = configWith([grid, farm], {
      use: { browser: { name: 'chromium', headless: true, remote: 'farm' } },
    })
    expect(issues(config)).toContainEqual({
      path: 'use.browser.remote',
      message:
        'Remote farm is an appium remote; use.browser.remote picks a playwright or cdp remote.',
    })
  })

  it('refuses a default pick when no remote is listed', () => {
    const config = configWith([], {
      use: { browser: { name: 'chromium', headless: true, remote: 'grid' } },
    })
    expect(issues(config)).toContainEqual({
      path: 'use.browser.remote',
      message: 'Unknown remote "grid" in agent-qa.config.yaml. registry.remotes lists no remotes.',
    })
  })

  it("refuses a target url that uses a remote's secret", () => {
    const config = {
      workspace,
      registry: {
        remotes: [{ ...debuggerRemote, query: { caps: { accessKey: '{{secret:CDP_KEY}}' } } }],
        targets: {
          shop: { platform: 'web', url: 'https://shop.example.com/?key={{secret:CDP_KEY}}' },
        },
      },
    }
    expect(issues(config)).toContainEqual({
      path: 'registry.targets.shop.url',
      message:
        "registry.targets.shop.url uses CDP_KEY, a remote's credential that only connects to it. Use another secret here.",
    })
  })
})
