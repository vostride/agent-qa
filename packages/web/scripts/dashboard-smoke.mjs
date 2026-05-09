#!/usr/bin/env node

import process from 'node:process'
import { chromium } from 'playwright-core'

const TEST_ID = 't_phase-188-smoke'
const SUITE_ID = 's_phase-188-smoke'
const TEST_FILE = 'phase-188-smoke.yaml'
const SUITE_FILE = 'phase-188-smoke.suite.yaml'
const TEST_CONTENT = `test-id: ${TEST_ID}
name: Phase 188 Smoke Test
target: my-app
steps:
  - Navigate to the login page
`
const SUITE_CONTENT = `suite-id: ${SUITE_ID}
name: Phase 188 Smoke Suite
target: my-app
tests:
  - test: ${TEST_FILE}
    id: ${TEST_ID}
`

function printHelp() {
  process.stdout.write(`Usage: pnpm smoke:dashboard -- --mode <dev|prod> --base-url <url> --api-base <url> [options]

Required:
  --mode <dev|prod>       Label for the runtime being checked
  --base-url <url>        Base URL for the dashboard UI
  --api-base <url>        Base URL for the dashboard API

Optional:
  --run-id <id>           Use an existing run id instead of discovering one
  --test-id <id>          Use an existing test id instead of discovering/seeding one
  --suite-id <id>         Use an existing suite id instead of discovering/seeding one
  --route <path>          Limit checks to a specific route; repeatable
  --timeout-ms <ms>       Navigation timeout per route (default: 30000)
  --poll-timeout-ms <ms>  Poll timeout for seeded runs (default: 30000)
  --help                  Show this help text
`)
}

function parseArgs(argv) {
  const args = {
    mode: undefined,
    baseUrl: undefined,
    apiBase: undefined,
    runId: undefined,
    testId: undefined,
    suiteId: undefined,
    routes: [],
    timeoutMs: 30_000,
    pollTimeoutMs: 30_000,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      continue
    }
    if (token === '--help' || token === '-h') {
      args.help = true
      continue
    }

    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`)
    }

    const next = argv[index + 1]
    if (next == null) {
      throw new Error(`Missing value for ${token}`)
    }

    switch (token) {
      case '--mode':
        args.mode = next
        break
      case '--base-url':
        args.baseUrl = next
        break
      case '--api-base':
        args.apiBase = next
        break
      case '--run-id':
        args.runId = next
        break
      case '--test-id':
        args.testId = next
        break
      case '--suite-id':
        args.suiteId = next
        break
      case '--route':
        args.routes.push(next)
        break
      case '--timeout-ms':
        args.timeoutMs = Number.parseInt(next, 10)
        break
      case '--poll-timeout-ms':
        args.pollTimeoutMs = Number.parseInt(next, 10)
        break
      default:
        throw new Error(`Unknown argument: ${token}`)
    }

    index += 1
  }

  return args
}

function assertRequiredArgs(args) {
  if (!args.mode || (args.mode !== 'dev' && args.mode !== 'prod')) {
    throw new Error('--mode must be one of: dev, prod')
  }
  if (!args.baseUrl) throw new Error('--base-url is required')
  if (!args.apiBase) throw new Error('--api-base is required')
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer')
  }
  if (!Number.isFinite(args.pollTimeoutMs) || args.pollTimeoutMs <= 0) {
    throw new Error('--poll-timeout-ms must be a positive integer')
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value)
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`
  }
  return url.toString()
}

function buildUiUrl(baseUrl, route) {
  return new URL(route.replace(/^\//, ''), baseUrl).toString()
}

function expectedPathForRoute(route) {
  switch (route) {
    case '/analytics':
    case '/trends':
      return '/insights'
    case '/settings':
      return '/config'
    default:
      return route
  }
}

async function requestJson(apiBase, path, init) {
  const response = await fetch(new URL(path, apiBase), init)
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    const message =
      data && typeof data.error === 'string'
        ? data.error
        : `Request failed: ${response.status} ${response.statusText}`
    throw new Error(`${message} (${path})`)
  }
  return data
}

async function ensureSmokeTest(apiBase, explicitTestId) {
  if (explicitTestId) return explicitTestId

  const tests = await requestJson(apiBase, '/api/tests')
  const existing = tests.files.find((file) => file.testId === TEST_ID)
  if (existing) return TEST_ID

  await requestJson(apiBase, '/api/tests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: TEST_FILE, content: TEST_CONTENT }),
  })

  return TEST_ID
}

async function ensureSmokeSuite(apiBase, explicitSuiteId) {
  if (explicitSuiteId) return explicitSuiteId

  const suites = await requestJson(apiBase, '/api/suites')
  const existing = suites.files.find((file) => file.suiteId === SUITE_ID)
  if (existing) return SUITE_ID

  await requestJson(apiBase, '/api/suites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: SUITE_FILE, content: SUITE_CONTENT }),
  })

  return SUITE_ID
}

async function resolveRunId(apiBase, explicitRunId, pollTimeoutMs) {
  if (explicitRunId) return explicitRunId

  const runs = await requestJson(apiBase, '/api/runs?limit=1')
  if (Array.isArray(runs.runs) && runs.runs.length > 0) {
    return runs.runs[0].id
  }

  const triggered = await requestJson(apiBase, '/api/runs/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: TEST_FILE, local: true }),
  })

  const runId = triggered.runId
  const deadline = Date.now() + pollTimeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      await requestJson(apiBase, `/api/runs/${encodeURIComponent(runId)}`)
      return runId
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }

  throw new Error(
    `Timed out waiting for seeded run ${runId} to become readable${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  )
}

function buildRoutes({ runId, testId, suiteId }) {
  return [
    '/runs',
    `/runs/${runId}`,
    `/runs/${runId}/live`,
    '/tests',
    '/tests/new',
    `/test/${testId}`,
    `/test/${testId}/edit`,
    '/suites',
    '/suites/new',
    `/suite/${suiteId}`,
    `/suite/${suiteId}/edit`,
    '/config',
    '/insights',
    '/analytics',
    '/trends',
    '/settings',
  ]
}

async function smokeRoute({ browser, theme, route, baseUrl, timeoutMs }) {
  const context = await browser.newContext()
  await context.addInitScript((selectedTheme) => {
    window.localStorage.setItem('vite-ui-theme', selectedTheme)
  }, theme)
  const page = await context.newPage()
  const consoleErrors = []
  const pageErrors = []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })

  const url = buildUiUrl(baseUrl, route)
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    if (!response || !response.ok()) {
      throw new Error(`Navigation failed for ${route}: ${response?.status() ?? 'no-response'}`)
    }

    await page.waitForFunction(
      () => {
        const mount = document.querySelector('#app') ?? document.querySelector('#root')
        return Boolean(mount && mount.childElementCount > 0)
      },
      { timeout: Math.min(timeoutMs, 15_000) },
    )
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
    await page.waitForTimeout(300)

    if (pageErrors.length > 0) {
      throw new Error(`pageerror on ${route}: ${pageErrors.join(' | ')}`)
    }
    if (consoleErrors.length > 0) {
      throw new Error(`console.error on ${route}: ${consoleErrors.join(' | ')}`)
    }

    const finalUrl = new URL(page.url())
    const expectedPath = expectedPathForRoute(route)
    if (finalUrl.pathname !== expectedPath) {
      throw new Error(`Route ${route} landed on ${finalUrl.pathname}; expected ${expectedPath}`)
    }

    return {
      theme,
      route,
      url,
      finalUrl: finalUrl.toString(),
      finalPath: finalUrl.pathname,
    }
  } finally {
    await context.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  assertRequiredArgs(args)

  const baseUrl = normalizeBaseUrl(args.baseUrl)
  const apiBase = normalizeBaseUrl(args.apiBase)
  const testId = await ensureSmokeTest(apiBase, args.testId)
  const suiteId = await ensureSmokeSuite(apiBase, args.suiteId)
  const runId = await resolveRunId(apiBase, args.runId, args.pollTimeoutMs)

  const allRoutes = buildRoutes({ runId, testId, suiteId })
  const routes = args.routes.length > 0 ? args.routes : allRoutes
  const invalidRoute = routes.find((route) => !allRoutes.includes(route) && !route.startsWith('/'))
  if (invalidRoute) {
    throw new Error(`Routes must be absolute dashboard paths. Invalid route: ${invalidRoute}`)
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const checks = []
    for (const theme of ['light', 'dark']) {
      for (const route of routes) {
        checks.push(await smokeRoute({
          browser,
          theme,
          route,
          baseUrl,
          timeoutMs: args.timeoutMs,
        }))
      }
    }

    const result = {
      mode: args.mode,
      baseUrl,
      apiBase,
      runId,
      testId,
      suiteId,
      routes,
      checks,
    }

    process.stdout.write(`runId: ${runId}\n`)
    process.stdout.write(`testId: ${testId}\n`)
    process.stdout.write(`suiteId: ${suiteId}\n`)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  process.stderr.write(`dashboard-smoke failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
