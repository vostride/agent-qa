// The composer dereferences nothing and the door reads no `Authorization`; token blocks fail.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'

import { composeRunServicePorts, createRunServiceReadiness } from '../commands/dashboard.js'

/** The value that must never appear in any message this suite can reach. */
const PLANTED = 'zz-planted-run-credential-8b3e17'
const PLANTED_VAR = 'AGENT_QA_PLANTED_RUN_CRED'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function door() {
  return {
    resolveHost: () => undefined,
    observeSessions: () => () => {},
  }
}

describe('the run-service bearer resolver is deleted, not bypassed', () => {
  it('the resolver module is gone and no CLI source imports it', () => {
    expect(existsSync(join(SRC, 'composition', 'run-service-token-resolution.ts'))).toBe(false)
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(path) }
        else if (entry.name.endsWith('.ts') && readFileSync(path, 'utf8').includes("run-service-token-resolution.js'")) {
          offenders.push(path)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })

  it('the composer takes no declarations, refuses nothing, binds no store', () => {
    const composition = composeRunServicePorts({ door: door() })
    try {
      expect(Object.keys(composition.ports).sort()).toEqual(['attach', 'invokeRunStart', 'mintLiveUrl', 'readiness'])
      expect('secretStore' in composition).toBe(false)
      expect('tokenCount' in composition).toBe(false)
      expect(JSON.stringify(Object.keys(composition))).not.toContain(PLANTED_VAR)
    } finally {
      composition.dispose()
    }
  })

  it('readiness reports no credential configured, whatever the environment holds', () => {
    const previous = process.env[PLANTED_VAR]
    process.env[PLANTED_VAR] = PLANTED
    try {
      const readiness = createRunServiceReadiness({ resolveHost: () => undefined })()
      expect(Object.keys(readiness).sort()).toEqual(['contractVersion', 'hostComposed', 'service'])
      expect(readiness).toMatchObject({ service: 'up', hostComposed: false })
      expect(JSON.stringify(readiness)).not.toContain(PLANTED)
    } finally {
      if (previous === undefined) delete process.env[PLANTED_VAR]
      else process.env[PLANTED_VAR] = previous
    }
  })
})

// Refusing a token value is refusing the whole key.
describe('services.dashboard declares no run-service token', () => {
  const base = {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      testPathIgnore: [],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    use: { mobile: { appState: 'preserve' } },
  }

  it('a declared entry, with or without an inline value, is refused by name', () => {
    for (const entry of [
      { name: 'ci', tokenEnvVar: PLANTED_VAR, trustScope: { org: 'acme' } },
      { name: 'ci', tokenEnvVar: PLANTED_VAR, trustScope: {}, token: PLANTED },
    ]) {
      const refused = AgentQaConfigSchema.safeParse({
        ...base,
        services: { dashboard: { runServiceTokens: [entry] } },
      })
      expect(refused.success).toBe(false)
      if (refused.success) continue
      expect(refused.error.issues.map(issue => issue.code)).toEqual(['unrecognized_keys'])
      expect(refused.error.issues[0]!.path).toEqual(['services', 'dashboard'])
      expect(JSON.stringify(refused.error.issues)).not.toContain(PLANTED)
    }
  })

  it('a dashboard block without the key parses and materialises no token list', () => {
    const parsed = AgentQaConfigSchema.parse({ ...base, services: { dashboard: { port: 3470 } } })
    expect(parsed.services?.dashboard).toEqual({ port: 3470 })
  })
})
