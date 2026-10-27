// The `config.get` view, asserted on the builder itself (Phase 384; 2026-10-15, 441-20 D-29).
//
// Every value is rendered as written and passed through the host's declared-secret mask, and
// nothing else: no path map, no URL reduction, no placeholder. The schema-derived visibility
// oracle is still tested here until its own plan removes it; the schema's path map and its cells
// were deleted in 441-40 (D-29).

// The oracle is built from the real config schema on purpose — test files are excluded
// from the arch specifier scan, so this proves the walk against the shipped tree without
// relaxing the firewall the production code obeys.
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { MaskFn } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildConfigVisibilityOracle, CONSTRAINED_LEAF_TYPES } from '../config-visibility.js'
import { buildMaskedResolvedConfig } from '../masked-config.js'

const DECLARED_VALUE = 'Hunter-42-zz'
const DECLARED_MARKER = '[secret:PW_441]'
const declaredRedactor = new SecretRedactor(SecretStore.fromEnvContent(`PW_441=${DECLARED_VALUE}\n`))
const declaredMask: MaskFn = (text) => declaredRedactor.redactString(text)
const identity: MaskFn = (text) => text

/** A scoped package name: an '@'-carrying value. */
const SCOPED_PACKAGE_NAME = '@acme/auth-plugin-SHOW-ME-9111'

/** Ordinary values whose characters a value-inspecting rule used to mistake for URL parts. */
const GLOB_WILDCARD_VALUE = 'tests/**/case-?.yaml'
const IGNORE_GLOB_VALUE = 'tests/legacy#old/**'
const CSS_SELECTOR_VALUE = '#cookie-banner'
const OVER_MASK_PACKAGE_VALUE = '@acme/plugin-foo-SHOW-ME-9210'

const visibility = buildConfigVisibilityOracle(AgentQaConfigSchema)

describe('buildConfigVisibilityOracle (the schema-derived rule)', () => {
  it('reads the config schema through its OUTPUT side, so ordinary keys stay visible', () => {
    // The positive control for the whole oracle, and it is not decoration. The config
    // schema's root is a retired-key pre-scan piped into the strict object, and the
    // pre-scan's input side is `z.any()`. A walker that unwrapped the pipe the wrong way
    // would report EVERY path free-form — every leak assertion below would then pass for
    // the wrong reason. This case fails loudly in exactly that situation.
    for (const key of [
      'workspace.testMatch',
      'workspace.testMatch.0',
      'workspace.hooksFile',
      'knowledge.dir',
      'knowledge.commitArtifacts',
      'services.dashboard.port',
      'services.logging.level',
      'use.browser.headless',
      'registry.llms.0.model',
      'registry.llms.0.baseURL',
    ]) {
      expect(visibility.classify(key), key).toBe('constrained')
    }
  })

  it('classifies every operator-named record with a free-form value as free-form', () => {
    // None of these is listed in the masker. The walk finds them because a `z.record` with an
    // open string key and an unknown/primitive value is what "the operator names this" looks
    // like in the schema.
    for (const key of [
      // z.record(z.string(), z.unknown()) — the device match block
      'registry.devices.pixel.match',
      'registry.devices.pixel.match.anything-at-all',
      // z.record(z.string(), z.string()) — operator-named key, primitive value
      'registry.llms.0.providerHeaders',
      'registry.llms.0.providerHeaders.x-key',
      // An analytics attribute predicate is `string | { regex }`, and the bare-string arm means
      // the schema constrains the shape of the value and nothing about its content — the same
      // relation providerHeaders has. The rule finds it without being told.
      'analytics.passRateScope.attributes.tier',
    ]) {
      expect(visibility.classify(key), key).toBe('free-form')
    }
  })

  it('descends INTO records whose values the schema structures', () => {
    // `targets` and `devices` are operator-named records too, but their values are strict
    // objects, so the walk goes through the operator's key into constrained leaves rather
    // than masking the subtree wholesale. Only the inner free-form node is opaque.
    for (const key of [
      'registry.devices.pixel.platform',
      'registry.targets.web.url',
      'registry.targets.web.platform',
    ]) {
      expect(visibility.classify(key), key).toBe('constrained')
    }
  })

  it('resolves a path through a union of declaration shapes', () => {
    // A plugin declaration is `{ package } | { path }`. Either arm is a real declaration,
    // so a path constrained under SOME option is constrained.
    for (const key of [
      'plugins.auth.0.package',
      'plugins.auth.0.path',
      'plugins.providers.0.package',
      'plugins.providers.0.path',
    ]) {
      expect(visibility.classify(key), key).toBe('constrained')
    }
  })

  it('reports a path the schema does not describe as undeclared', () => {
    for (const key of [
      'deploy.creds.region',
      'services.dashboard.origin',
      'registry.llms.0.apiKey',
      'a.password',
    ]) {
      expect(visibility.classify(key), key).toBe('undeclared')
    }
  })

  it('is LIVE against the schema it is handed, not a snapshot of today\'s free-form set', () => {
    // The staleness guard. A synthetic variant of the REAL config schema — same piped,
    // strict root — carrying a FOURTH free-form record at a path that does not exist today.
    // The oracle masks it with no edit to the masker, so the day the schema grows another
    // operator-named record, this rule already covers it. If the walk ever degrades into an
    // enumeration, this is the case that reddens.
    const inner = AgentQaConfigSchema.def.out as unknown as z.ZodObject
    const grownSchema = z.any().superRefine(() => {}).pipe(
      inner.extend({
        deployment: z.object({
          // A free-form record the masker has never heard of, at a fresh path.
          capabilities: z.record(z.string(), z.unknown()),
          // …beside a constrained sibling, so the assertion cannot pass by masking the
          // whole new subtree.
          region: z.string(),
        }).strict(),
      }),
    )
    const grown = buildConfigVisibilityOracle(grownSchema)

    expect(grown.classify('deployment.capabilities')).toBe('free-form')
    expect(grown.classify('deployment.capabilities.browserstackKey')).toBe('free-form')
    expect(grown.classify('deployment.region')).toBe('constrained')
    // The pre-existing tree is unaffected, so this is a genuine addition rather than a
    // schema that masks everything.
    expect(grown.classify('workspace.testMatch')).toBe('constrained')
    expect(grown.classify('registry.devices.pixel.match.jwt')).toBe('free-form')
    // And the real schema does NOT have that path — the guard is measuring a difference.
    expect(visibility.classify('deployment.capabilities')).toBe('undeclared')
  })
})

/**
 * Extend the REAL config schema through its own piped root, exactly as the staleness guard
 * above does, so every case below is measured against the shipped tree rather than a
 * hand-mirrored lookalike.
 */
function growRealSchema(extension: Record<string, z.ZodType>): z.ZodType {
  const inner = AgentQaConfigSchema.def.out as unknown as z.ZodObject
  return z.any().superRefine(() => {}).pipe(inner.extend(extension))
}

describe('the walker fails CLOSED (CR-02)', () => {
  // The four node kinds the round-3 verifier reproduced as PUBLISHED. None of them appears
  // in today's schema, so none was a live disclosure — but the failure DIRECTION was
  // disclosure, and the module's header claimed the opposite. Each case carries a
  // constrained sibling so it cannot pass by masking the whole new subtree.

  it('masks a record whose value type is an intersection', () => {
    const grown = buildConfigVisibilityOracle(growRealSchema({
      deployment: z.object({
        caps: z.record(
          z.string(),
          z.intersection(
            z.object({ browserKey: z.string() }).strict(),
            z.object({ region: z.string() }).strict(),
          ),
        ),
        region: z.string(),
      }).strict(),
    }))

    expect(grown.classify('deployment.caps')).not.toBe('constrained')
    expect(grown.classify('deployment.caps.browserstack')).not.toBe('constrained')
    expect(grown.isOpaque('deployment.caps.browserstack')).toBe(true)
    // The sibling control, in the same grown schema.
    expect(grown.classify('deployment.region')).toBe('constrained')
  })

  it('masks a z.custom() node at a fixed key', () => {
    const grown = buildConfigVisibilityOracle(growRealSchema({
      deployment: z.object({
        attestation: z.custom(() => true),
        region: z.string(),
      }).strict(),
    }))

    expect(grown.classify('deployment.attestation')).not.toBe('constrained')
    expect(grown.isOpaque('deployment.attestation')).toBe(true)
    expect(grown.classify('deployment.region')).toBe('constrained')
  })

  it('masks records of z.map and z.tuple, which admitsFreeFormValue calls containers', () => {
    // The internal contradiction the review found: `admitsFreeFormValue` lists map/set/tuple
    // among the containers "the walk descends into", and `classifyFrom` has no branch to
    // descend with — so the walk landed on them and called them constrained.
    const grown = buildConfigVisibilityOracle(growRealSchema({
      deployment: z.object({
        mapped: z.record(z.string(), z.map(z.string(), z.string())),
        tupled: z.record(z.string(), z.tuple([z.string(), z.string()])),
        listed: z.record(z.string(), z.set(z.string())),
        region: z.string(),
      }).strict(),
    }))

    for (const key of [
      'deployment.mapped',
      'deployment.mapped.anything',
      'deployment.tupled',
      'deployment.tupled.anything',
      'deployment.listed',
      'deployment.listed.anything',
    ]) {
      expect(grown.classify(key), key).not.toBe('constrained')
      expect(grown.isOpaque(key), key).toBe(true)
    }
    expect(grown.classify('deployment.region')).toBe('constrained')
  })

  it('masks a union carrying a free-form arm, whatever its other arms declare', () => {
    // The two union rules in one module used to point opposite ways: `admitsFreeFormValue`
    // called a union free-form if ANY arm was, while `classifyFrom` called it constrained if
    // ANY arm was. An arm the operator can fill freely means the VALUE may be anything, so
    // free-form has to dominate.
    const grown = buildConfigVisibilityOracle(growRealSchema({
      deployment: z.object({
        vault: z.union([z.unknown(), z.object({ region: z.string() }).strict()]),
        region: z.string(),
      }).strict(),
    }))

    expect(grown.classify('deployment.vault')).not.toBe('constrained')
    expect(grown.classify('deployment.vault.region')).not.toBe('constrained')
    expect(grown.isOpaque('deployment.vault')).toBe(true)
    expect(grown.classify('deployment.region')).toBe('constrained')
    // …and a union with NO free-form arm keeps today's behaviour: the plugin declaration
    // union is `{ package } | { path }`, and either arm is a real declaration.
    expect(visibility.classify('plugins.auth.0.package')).toBe('constrained')
    expect(visibility.classify('plugins.auth.0.path')).toBe('constrained')
  })
})

/**
 * The node kinds the walker decides by NAME, in one place.
 *
 * `CONSTRAINED_LEAF_TYPES` is imported from the module, so the allowlist and its guard
 * cannot drift apart. The remainder is local because it names the branches of a function
 * rather than a shipped constant — and it is kept honest by this table asserting that the
 * five kinds the round-3 verifier found published were ACTUALLY probed and are masked, so
 * the corpus provably reaches past the vocabulary it is checking.
 */
const WALKER_NAMED_VOCABULARY: ReadonlySet<string> = new Set([
  ...CONSTRAINED_LEAF_TYPES,
  // Decided by their own `classifyFrom` branches rather than by the landing allowlist.
  'unknown',
  'any',
  'union',
  'record',
  // Consumed by `unwrap` before any verdict is reached, so they never survive to a landing.
  'optional',
  'nullable',
  'nonoptional',
  'default',
  'prefault',
  'catch',
  'readonly',
  'lazy',
  'pipe',
])

/**
 * Argument shapes to try against each export, so the corpus does not need a list of factory
 * NAMES. Anything that does not yield a structural `def.type` under any of them is not a
 * schema constructor and is discarded.
 */
const PROBE_ARGUMENTS: readonly (readonly unknown[])[] = [
  [],
  [z.string()],
  [z.string(), z.string()],
  [[z.string(), z.string()]],
  ['probe-literal'],
  [() => z.string()],
]

/** One representative schema per zod node kind, derived from zod's own export surface. */
function probeSchemasByNodeKind(): Map<string, z.ZodType> {
  const byKind = new Map<string, z.ZodType>()
  for (const name of Object.keys(z)) {
    const factory = (z as unknown as Record<string, unknown>)[name]
    if (typeof factory !== 'function') continue
    for (const args of PROBE_ARGUMENTS) {
      let produced: unknown
      try {
        produced = (factory as (...callArgs: unknown[]) => unknown)(...args)
      } catch {
        continue
      }
      // Some exports are parse helpers that hand back a promise; never leave one unhandled.
      if (
        typeof produced === 'object' && produced !== null
        && typeof (produced as { then?: unknown }).then === 'function'
      ) {
        void (produced as Promise<unknown>).catch(() => {})
        continue
      }
      const kind = (produced as { def?: { type?: unknown } } | null | undefined)?.def?.type
      if (typeof kind !== 'string') continue
      if (!byKind.has(kind)) byKind.set(kind, produced as z.ZodType)
      break
    }
  }
  return byKind
}

describe('no node kind outside the walker\'s vocabulary earns visibility (CR-02 companion)', () => {
  // The class-closing half, and the reason the allowlist is shippable at all. Its corpus is
  // the LIBRARY's export surface rather than this walker's vocabulary, so a zod upgrade that
  // mints a node kind reddens this table instead of silently widening what config.get
  // publishes. Without it, the allowlist would be the enumeration move one layer down.

  const probes = probeSchemasByNodeKind()

  it('probes zod\'s export surface and reaches past the walker\'s own vocabulary', () => {
    expect(probes.size).toBeGreaterThan(0)
    // Non-vacuity: the corpus must contain the kinds the walker does NOT name, or the
    // implication below would be trivially satisfied by a corpus of allowlisted kinds.
    const unnamed = [...probes.keys()].filter((kind) => !WALKER_NAMED_VOCABULARY.has(kind))
    expect(unnamed.length).toBeGreaterThan(0)
  })

  it('classifies constrained only for kinds the walker names', () => {
    for (const [kind, schema] of probes) {
      const grown = buildConfigVisibilityOracle(growRealSchema({ probeNode: schema }))
      if (grown.classify('probeNode') === 'constrained') {
        expect(WALKER_NAMED_VOCABULARY.has(kind), `${kind} classified constrained`).toBe(true)
      }
    }
  })

  it('masks the five kinds the round-3 report found published', () => {
    for (const kind of ['intersection', 'custom', 'map', 'set', 'tuple']) {
      // Asserted PROBED first: a corpus that silently missed these would pass the
      // implication above without ever exercising it.
      expect(probes.has(kind), `${kind} probed`).toBe(true)
      const grown = buildConfigVisibilityOracle(growRealSchema({ probeNode: probes.get(kind)! }))
      expect(grown.classify('probeNode'), kind).not.toBe('constrained')
      expect(grown.isOpaque('probeNode'), kind).toBe(true)
    }
  })

  it('carries a positive control: the string probe is constrained', () => {
    // Without this, a walker that masked EVERYTHING would satisfy every assertion above.
    expect(probes.has('string')).toBe(true)
    const grown = buildConfigVisibilityOracle(growRealSchema({ probeNode: probes.get('string')! }))
    expect(grown.classify('probeNode')).toBe('constrained')
    // …and the real schema's own controls, in the same file, are asserted constrained by the
    // oracle describe above.
  })
})

describe('buildMaskedResolvedConfig', () => {
  it('leaves an @-carrying value that is not a credential carrier byte-identical', () => {
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: {
        plugins: { auth: [{ package: SCOPED_PACKAGE_NAME }] },
        knowledge: { dir: 'agent-qa-knowledge' },
      },
      layers: [],
      mask: declaredMask,
    })

    expect(config.entries.find((entry) => entry.key === 'plugins.auth.0.package')).toEqual({
      key: 'plugins.auth.0.package',
      value: SCOPED_PACKAGE_NAME,
      source: 'default',
      masked: false,
    })
  })

  it('applies the rule to the RENDERED string of a leaf, not only to string inputs', () => {
    // Every leaf is stringified before the mask reads it, so the input's runtime type decides
    // nothing: a non-string leaf whose rendering holds a declared value is masked too.
    const rendersDeclared = Object.defineProperties({}, {
      toJSON: { value: () => undefined },
      toString: { value: () => `https://leaf.acme.test/p/${DECLARED_VALUE}` },
    })
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: {
        registry: { targets: { web: { platform: 'web', url: rendersDeclared } } },
        workspace: { hooksFile: 4242 },
      },
      layers: [],
      mask: declaredMask,
    })

    const byKey = Object.fromEntries(config.entries.map((entry) => [entry.key, entry]))
    expect(byKey['registry.targets.web.url']).toMatchObject({
      value: `https://leaf.acme.test/p/${DECLARED_MARKER}`,
      masked: true,
    })
    expect(byKey['workspace.hooksFile']).toMatchObject({ value: '4242', masked: false })
    expect(JSON.stringify(config)).not.toContain(DECLARED_VALUE)
  })

  it('leaves non-URL and userinfo-free strings byte-identical', () => {
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: {
        registry: { llms: [{ name: 'judge', baseURL: 'https://llm.acme.test/v1/' }] },
        knowledge: { dir: 'agent-qa-knowledge' },
        workspace: { hooksFile: 'hooks.yaml' },
      },
      layers: [],
      mask: declaredMask,
    })

    for (const [key, value] of [
      ['registry.llms.0.baseURL', 'https://llm.acme.test/v1/'],
      ['knowledge.dir', 'agent-qa-knowledge'],
      ['workspace.hooksFile', 'hooks.yaml'],
    ] as const) {
      expect(config.entries.find((entry) => entry.key === key), key)
        .toMatchObject({ value, masked: false })
    }
  })

  it('returns glob, selector and package values byte-identical with masked: false', () => {
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: {
        workspace: { testMatch: [GLOB_WILDCARD_VALUE], testPathIgnore: [IGNORE_GLOB_VALUE] },
        services: { accessibility: { exclude: [CSS_SELECTOR_VALUE] } },
        plugins: { providers: [{ package: OVER_MASK_PACKAGE_VALUE }] },
      },
      layers: [],
      mask: declaredMask,
    })

    for (const [key, value] of [
      ['workspace.testMatch.0', GLOB_WILDCARD_VALUE],
      ['workspace.testPathIgnore.0', IGNORE_GLOB_VALUE],
      ['services.accessibility.exclude.0', CSS_SELECTOR_VALUE],
      ['plugins.providers.0.package', OVER_MASK_PACKAGE_VALUE],
    ] as const) {
      expect(config.entries.find((entry) => entry.key === key), key)
        .toMatchObject({ value, masked: false })
    }
  })

  it('renders every value as a string so no value type bypasses masking', () => {
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: {
        services: { dashboard: { port: 4000 } },
        use: { browser: { headless: true } },
        workspace: { testMatch: [] },
        knowledge: { contextBudgetTokens: null },
      },
      layers: [],
      mask: identity,
    })

    const byKey = Object.fromEntries(config.entries.map((entry) => [entry.key, entry.value]))
    expect(byKey['services.dashboard.port']).toBe('4000')
    expect(byKey['use.browser.headless']).toBe('true')
    expect(byKey['workspace.testMatch']).toBe('[]')
    expect(byKey['knowledge.contextBudgetTokens']).toBe('null')
    for (const entry of config.entries) {
      expect(typeof entry.value).toBe('string')
    }
  })

  it('descends into arrays so a secret nested in one is still masked', () => {
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: {
        registry: { llms: [{ name: 'judge', apiKey: DECLARED_VALUE }] },
      },
      layers: [],
      mask: declaredMask,
    })

    expect(config.entries).toEqual([
      {
        key: 'registry.llms.0.apiKey',
        value: DECLARED_MARKER,
        source: 'default',
        masked: true,
      },
      { key: 'registry.llms.0.name', value: 'judge', source: 'default', masked: false },
    ])
    expect(JSON.stringify(config)).not.toContain(DECLARED_VALUE)
  })

  it('attributes each key to the highest-precedence layer that carries it', () => {
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: {
        knowledge: { dir: 'agent-qa-knowledge' },
        services: { dashboard: { port: 9999 }, logging: { level: 'debug' } },
      },
      layers: [
        { source: 'config-file', values: { services: { dashboard: { port: 4000 }, logging: { level: 'info' } } } },
        { source: 'env', values: { services: { logging: { level: 'debug' } } } },
        { source: 'cli-flag', values: { services: { dashboard: { port: 9999 } } } },
      ],
      mask: identity,
    })

    const bySource = Object.fromEntries(config.entries.map((entry) => [entry.key, entry.source]))
    expect(bySource['services.dashboard.port']).toBe('cli-flag')
    expect(bySource['services.logging.level']).toBe('env')
    // A key no layer supplied came from a schema default.
    expect(bySource['knowledge.dir']).toBe('default')
  })

  it('emits entries in a deterministic key order', () => {
    const input = {
      configPath: 'agent-qa.config.yaml',
      resolved: { b: { z: 1, a: 2 }, a: { m: 3 } },
      layers: [],
      mask: identity,
    }

    expect(buildMaskedResolvedConfig(input).entries.map((entry) => entry.key))
      .toEqual(['a.m', 'b.a', 'b.z'])
    expect(buildMaskedResolvedConfig(input)).toEqual(buildMaskedResolvedConfig(input))
  })

  it('CONFIG-SHOW-ENV-VAR-NAME-IN-CLEAR', () => {
    const resolved = {
      services: {
        mcp: { enabled: true, port: 3471 },
        dashboard: { port: 3470 },
      },
    }
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved,
      layers: [{ source: 'config-file', values: resolved }],
      mask: declaredMask,
    })
    expect(config.entries).toContainEqual({
      key: 'services.mcp.port', value: '3471', source: 'config-file', masked: false,
    })
    expect(config.entries.every((entry) => !entry.masked)).toBe(true)

    const legacy = { services: { mcp: { tokens: [{ name: 'ci', tokenEnvVar: 'AGENT_QA_MCP_TOKEN' }] } } }
    const shown = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved: legacy,
      layers: [{ source: 'config-file', values: legacy }],
      mask: declaredMask,
    })
    expect(shown.entries).toContainEqual({
      key: 'services.mcp.tokens.0.tokenEnvVar',
      value: 'AGENT_QA_MCP_TOKEN',
      source: 'config-file',
      masked: false,
    })
  })
})

describe('C441-CONFIG', () => {
  it('a declared value is masked and flagged in the config.get view', () => {
    const resolved = {
      use: { buildTag: DECLARED_VALUE },
      registry: { llms: [{ name: 'judge', baseURL: `https://llm.acme.test/v1?k=${DECLARED_VALUE}` }] },
    }
    const config = buildMaskedResolvedConfig({
      configPath: '/workspace/agent-qa.config.yaml',
      resolved,
      layers: [{ source: 'config-file', values: resolved }],
      mask: declaredMask,
    })

    expect(config.schemaVersion).toBe(MASKED_RESOLVED_CONFIG_SCHEMA_VERSION)
    expect(config.configPath).toBe('/workspace/agent-qa.config.yaml')
    expect(config.entries).toContainEqual({
      key: 'use.buildTag', value: DECLARED_MARKER, source: 'config-file', masked: true,
    })
    expect(config.entries).toContainEqual({
      key: 'registry.llms.0.baseURL',
      value: `https://llm.acme.test/v1?k=${DECLARED_MARKER}`,
      source: 'config-file',
      masked: true,
    })
    expect(JSON.stringify(config)).not.toContain(DECLARED_VALUE)
  })

  it('an undeclared credential-shaped value and a URL with userinfo are shown as written and not flagged', () => {
    const credentialShaped = 'sk-live-UNDECLARED-441-4242'
    const userinfoUrl = 'https://ops:hunter2-undeclared-441@llm.acme.test/v1?ticket=t-441#frag'
    const resolved = {
      registry: {
        llms: [{
          name: 'judge',
          baseURL: userinfoUrl,
          providerHeaders: { 'X-Api-Key': credentialShaped },
        }],
        devices: { pixel: { platform: 'android', match: { jwt: credentialShaped } } },
      },
    }
    const config = buildMaskedResolvedConfig({
      configPath: 'agent-qa.config.yaml',
      resolved,
      layers: [{ source: 'config-file', values: resolved }],
      mask: declaredMask,
    })

    for (const [key, value] of [
      ['registry.llms.0.baseURL', userinfoUrl],
      ['registry.llms.0.providerHeaders.X-Api-Key', credentialShaped],
      ['registry.devices.pixel.match.jwt', credentialShaped],
    ] as const) {
      expect(config.entries, key).toContainEqual({ key, value, source: 'config-file', masked: false })
    }
  })
})
