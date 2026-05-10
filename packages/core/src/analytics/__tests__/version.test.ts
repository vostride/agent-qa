import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAgentQaVersion } from '../../version.js'
import { resolveAnalyticsStandardProperties } from '../service.js'

describe('agent-qa analytics version context', () => {
  let tempDir: string
  let identityPath: string
  const packageVersion = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8')) as { version: string }).version

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-qa-version-'))
    identityPath = join(tempDir, 'analytics.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns a reusable agent-qa package version', () => {
    expect(getAgentQaVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(getAgentQaVersion()).toBe(packageVersion)
  })

  it('builds local user analytics standard properties', async () => {
    await expect(resolveAnalyticsStandardProperties({
      surface: 'cli',
      env: {},
      identityPath,
    })).resolves.toMatchObject({
      agent_qa_version: getAgentQaVersion(),
      surface: 'cli',
      runtime_context: 'user',
    })
  })

  it('builds CI analytics standard properties without a local user id', async () => {
    await expect(resolveAnalyticsStandardProperties({
      surface: 'core',
      env: { CI: 'true' },
      identityPath,
    })).resolves.toEqual({
      agent_qa_version: getAgentQaVersion(),
      surface: 'core',
      runtime_context: 'ci',
    })
  })

  it('builds normalized agent analytics standard properties without raw env data', async () => {
    const properties = await resolveAnalyticsStandardProperties({
      surface: 'mcp',
      env: { AGENT: 'goose' },
      identityPath,
    })

    expect(properties).toEqual({
      agent_qa_version: getAgentQaVersion(),
      surface: 'mcp',
      runtime_context: 'agent',
      agent_product: 'goose',
    })
    expect(JSON.stringify(properties)).not.toContain('AGENT')
  })
})
