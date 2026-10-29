// The run service's credential mechanics, RETIRED
// 2026-10-01.
//
// RE-SPELLED from the resolver's own cells.
// `run-service-token-resolution.ts` — `resolveRunServiceTokens`, `matchServiceBearer`,
// `runServiceTokenSecretStore` and `RunServiceTokenEnvVarUnsetError` — is deleted with the
// run-service tokens, and the router's `verifyBearer` port with it. Each retired cell is replaced by
// the claim that now holds in its place:
//
//   * the startup refusal for an unset declaration -> the composer dereferences nothing, so it
//     composes with a declaration on disk and an empty environment alike;
//   * the two-arm verdict with no permissive third -> the door reads no `Authorization` header, and
//     what it refuses first is a cross-site request (`run-service-auth-hardening.test.ts`);
//   * the masker seeded by declared name -> the composer binds no store at all;
//   * `/ok`'s `authConfigured` from a resolved count -> always `false`, and since 432-22 absent.
//
// the refs-only config cells that followed are re-spelled too.
// `services.dashboard.runServiceTokens` is deleted, so a declared block is refused by the strict
// parser with the normal unrecognized-key error.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'

import { composeRunServicePorts, createRunServiceReadiness } from '../commands/dashboard.js'

/** The value that must never appear in any message this suite can reach. */
const PLANTED = 'zz-402-01-planted-run-credential-8b3e17'
const PLANTED_VAR = 'AGENT_QA_402_RUN_CRED'

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

  // RE-SPELLED from 'start-time resolution refuses an unset declaration by NAME' and 'the masker is
  // seeded by DECLARED name': nothing is declared to the composer, so nothing can refuse, and it
  // holds no store. 441-48: a door has no masking binder for it to call.
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

  // RE-SPELLED from 'the verdict has TWO arms and no permissive third': there is no verdict.
  // Readiness carries no credential fact at all — no credential can be configured.
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

// re-spelled from 'the config block accepts a declaration and refuses an inline value'. The
// declaration and its default are gone; refusing a value is now refusing the whole key.
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
