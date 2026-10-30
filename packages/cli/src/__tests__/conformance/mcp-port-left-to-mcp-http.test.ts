// `agent-qa mcp --http` alone owns port 3471.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { LIVE_LINK_ABSENT_LINE } from '@vostride/agent-qa-mcp'

import { mcpMountPlanFor } from '../../commands/dashboard.js'
import {
  SUPPORTED_INIT_PLATFORMS,
  buildScaffoldConfig,
} from '../../commands/scaffold-content.js'
import {
  ANCHORED_BUILDS,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  trackTempRoot,
} from './spawned-chat.js'

const FACTS = {
  llmEntries: [],
  usesSubscriptionAuth: false,
  cacheDir: '.agent-qa/cache',
  authStatesDir: '.agent-qa/auth-states',
}
const INIT_BUDGET_MS = 120_000

function assertFreshBuild(): void {
  const freshness = buildFreshness(ANCHORED_BUILDS)
  expect({ missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`).toEqual({ missing: [], stale: [] })
}

beforeAll(() => {
  if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
})

afterAll(() => {
  cleanupTempRoots()
})

describe('the MCP port is left to mcp --http', () => {
  it('a fresh scaffold declares no services.mcp for any init platform', () => {
    expect(SUPPORTED_INIT_PLATFORMS.length, 'init platforms to check').toBeGreaterThan(0)
    for (const platform of SUPPORTED_INIT_PLATFORMS) {
      const config = buildScaffoldConfig(platform, FACTS) as { services: Record<string, unknown> }
      expect(config.services, `${platform} services`).not.toHaveProperty('mcp')
      expect(config.services.dashboard, `${platform} dashboard`)
        .toEqual({ port: 3100, artifactsDir: '.agent-qa/artifacts' })
    }
  })

  it('a real init writes a config whose dashboard mount plan binds no MCP port', () => {
    assertFreshBuild()
    const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-port-owner-')))
    const dir = join(root, 'workspace')
    const result = spawnSync(process.execPath, [CLI_ENTRY, 'init', '--platform', 'web', '--dir', dir], {
      cwd: root,
      env: hermeticEnv(root),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: INIT_BUDGET_MS - 10_000,
    })
    const seen = `exit ${String(result.status)}\n${result.stdout}\n${result.stderr}`
    expect(result.status, seen).toBe(0)
    const configPath = join(dir, 'agent-qa.config.yaml')
    expect(existsSync(configPath), seen).toBe(true)
    const parsed = parse(readFileSync(configPath, 'utf8')) as { services?: Record<string, unknown> }
    expect(parsed.services, 'the written config has services').toBeDefined()
    expect(parsed.services, 'the written config declares services.mcp').not.toHaveProperty('mcp')
    expect(mcpMountPlanFor(parsed).mount, 'the dashboard mount plan for a fresh config').toBe(false)
  }, INIT_BUDGET_MS)

  it('a workspace that declares services.mcp still co-hosts on its port', () => {
    expect(mcpMountPlanFor({ services: { mcp: { enabled: true, port: 3471 } } }))
      .toEqual({ mount: true, port: 3471 })
    expect(mcpMountPlanFor({ services: { mcp: { enabled: false, port: 3471 } } }).mount).toBe(false)
  })

  it('the standalone no-dashboard line names only services.dashboard.baseUrl', () => {
    expect(LIVE_LINK_ABSENT_LINE).toBe('no dashboard configured — set services.dashboard.baseUrl')
    expect(LIVE_LINK_ABSENT_LINE).toContain('services.dashboard.baseUrl')
    expect(LIVE_LINK_ABSENT_LINE).not.toContain('http')
    expect(LIVE_LINK_ABSENT_LINE).not.toMatch(/agent-qa dashboard|\brun\b/u)
  })
})
