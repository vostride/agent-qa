// The `config.get` view, asserted on the builder itself.
//
// Every value is rendered as written and passed through the host's declared-secret mask, and
// nothing else: no path map, no URL reduction, no placeholder.

import { SecretRedactor, SecretStore } from '@vostride/agent-qa-runner'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { MaskFn } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { buildMaskedResolvedConfig } from '../masked-config.js'

const DECLARED_VALUE = 'Hunter-42-zz'
const DECLARED_MARKER = '[secret:PW_KEY]'
const declaredRedactor = new SecretRedactor(SecretStore.fromEnvContent(`PW_KEY=${DECLARED_VALUE}\n`))
const declaredMask: MaskFn = (text) => declaredRedactor.redactString(text)
const identity: MaskFn = (text) => text

/** A scoped package name: an '@'-carrying value. */
const SCOPED_PACKAGE_NAME = '@acme/auth-plugin-SHOW-ME-9111'

/** Ordinary values whose characters a value-inspecting rule used to mistake for URL parts. */
const GLOB_WILDCARD_VALUE = 'tests/**/case-?.yaml'
const IGNORE_GLOB_VALUE = 'tests/legacy#old/**'
const CSS_SELECTOR_VALUE = '#cookie-banner'
const OVER_MASK_PACKAGE_VALUE = '@acme/plugin-foo-SHOW-ME-9210'

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
        services: { dashboard: { port: 4000, dbPath: null } },
        use: { browser: { headless: true } },
        workspace: { testMatch: [] },
      },
      layers: [],
      mask: identity,
    })

    const byKey = Object.fromEntries(config.entries.map((entry) => [entry.key, entry.value]))
    expect(byKey['services.dashboard.port']).toBe('4000')
    expect(byKey['use.browser.headless']).toBe('true')
    expect(byKey['workspace.testMatch']).toBe('[]')
    expect(byKey['services.dashboard.dbPath']).toBe('null')
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

describe('declared values in the config.get view', () => {
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
    const credentialShaped = 'sk-live-UNDECLARED-4242'
    const userinfoUrl = 'https://ops:hunter2-undeclared@llm.acme.test/v1?ticket=t-undeclared#frag'
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
