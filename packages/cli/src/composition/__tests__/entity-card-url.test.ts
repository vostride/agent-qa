// D-10 end to end, through the REAL config path.
//
// The agent-side suite proves the producer's rules against `MaskedResolvedConfig` values it
// constructs. That is necessary and not sufficient: a hand-built DTO can carry a shape the
// real masker is structurally incapable of producing, and a card URL proven only against one
// would be the input-domain vacuity this phase keeps finding. Nothing in `packages/agent` can
// reach the masker — it lives here, in the composition root — so the join is proven HERE, and
// this is the only place in the workspace where it can be.
//
// What "real" means in this file, stated so it can be checked rather than trusted: an actual
// YAML file on disk, resolved by `resolveConfig` through the shipped `AgentQaConfigSchema`
// (which is `.strict()`, so an undeclared `services.dashboard` key would fail the read
// outright), masked by `buildMaskedResolvedConfig` with the declared-secret mask,
// and handed to the real `entities.get` op through `createFunctionRegistry` and
// `invokeFunction`. The only stubs are the ports this claim is not about.

import { createFunctionRegistry, invokeFunction } from '@vostride/agent-qa-agent'
import type { FunctionDeps } from '@vostride/agent-qa-agent'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import type {
  EntityCard,
  EntityDescriptor,
  FunctionCaller,
} from '@vostride/agent-qa-schema'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { createConfigReader } from '../local-agent-host.js'

const DECLARED_VALUE = 'Hunter-42-zz'
const declaredRedactor = new SecretRedactor(SecretStore.fromEnvContent(`PW_441=${DECLARED_VALUE}\n`))

// no `grantedScopes` or `safeMode` on the caller; the registry reads
// neither.
const CALLER: FunctionCaller = {
  surface: 'cli',
  origin: 'agent',
}

const DESCRIPTOR: EntityDescriptor = {
  kind: 'MEM',
  shortId: 'MEM-004',
  uri: 'agentqa://memory/MEM-004',
  machineId: 'shop.cart.fact.0001',
  title: 'Cart totals VAT',
  statusSource: 'active',
}

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write a real config file whose `services.dashboard` block carries the D-10 keys. */
function writeConfig(dashboard: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-card-url-'))
  roots.push(dir)
  const configPath = join(dir, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['tests/**/*.suite.yaml'],
        hooksFile: 'agent-qa.hooks.ts',
        envFile: '.env',
        secretsFile: '.env.secrets',
      },
      use: { mobile: { appState: 'reset' } },
      services: { dashboard },
    }),
    'utf8',
  )
  return configPath
}

function depsFor(configPath: string): FunctionDeps {
  return {
    runs: {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      readEvents: () => Promise.resolve([]),
      readStepEvidence: () => Promise.resolve({ kind: 'run-not-recorded' } as const),
    },
    knowledge: {
      listBundles: () => Promise.resolve([]),
      inspectRecords: () => Promise.resolve([]),
      diffSince: () => Promise.resolve([]),
      showRecord: ({ recordId }) => Promise.resolve({
        kind: 'not-found' as const,
        schemaVersion: 2 as const,
        recordId,
      }),
    },
    entities: {
      resolve: () => Promise.resolve({ kind: 'none' as const, reason: 'no-match' as const }),
      get: (ref) => Promise.resolve(ref === DESCRIPTOR.shortId ? DESCRIPTOR : undefined),
    },
    // THE point of this file: the real reader, over a real file, through the declared mask.
    config: createConfigReader(configPath, (text) => declaredRedactor.redactString(text)),
  }
}

async function cardFor(dashboard: Record<string, unknown>): Promise<EntityCard> {
  const registry = createFunctionRegistry({
    deps: depsFor(writeConfig(dashboard)),
    // no `resolveExecutionContext` registry option; the registry reads
    // no context.
  })
  const result = await invokeFunction(
    registry,
    'entities.get',
    { ref: DESCRIPTOR.shortId },
    CALLER,
  )
  return result as EntityCard
}

describe('the card url is derived through the real masked-config path', () => {
  it('renders the pinned route from a base the masker publishes verbatim', async () => {
    const card = await cardFor({
      baseUrl: 'https://qa.example.com',
      workspace: 'acme',
    })
    expect(card.url).toBe('https://qa.example.com/t/acme/memory/MEM-004/cart-totals-vat')
  })

  it('omits the url when the config declares no dashboard base — the v52 default', async () => {
    const card = await cardFor({ port: 4400 })
    // Key presence, not value: a card that carried `url: undefined` would pass a value check.
    expect('url' in card).toBe(false)
  })

  it('omits the url when the declared mask changed the base, rather than linking to the marker',
    async () => {
      // A masked entry is not the operator's value, so the producer omits the link rather than
      // pointing every card at a URL that carries `[secret:<name>]`.
      const card = await cardFor({
        baseUrl: `https://qa.example.com/${DECLARED_VALUE}`,
        workspace: 'acme',
      })
      expect('url' in card).toBe(false)
    })

  it('omits the url when only one half is configured', async () => {
    expect('url' in await cardFor({ baseUrl: 'https://qa.example.com' })).toBe(false)
    expect('url' in await cardFor({ workspace: 'acme' })).toBe(false)
  })
})

describe('the card url base path', () => {
  it('a card url keeps the base path prefix as written', async () => {
    const card = await cardFor({
      baseUrl: 'https://qa.example.com/qa',
      workspace: 'acme',
    })
    expect(card.url).toBe('https://qa.example.com/qa/t/acme/memory/MEM-004/cart-totals-vat')
  })
})
