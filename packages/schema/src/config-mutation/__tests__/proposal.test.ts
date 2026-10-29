// These inputs come from a model, so each schema is `.strict()`: an unknown key is refused.

import { describe, expect, it } from 'vitest'

import * as actions from '../actions'
import {
  CONFIG_HOOK_RUNTIMES,
  ConfigAuthSetInputSchema,
  ConfigChangeFileSchema,
  ConfigChangeOutputSchema,
  ConfigFieldSetInputSchema,
  ConfigHookAddInputSchema,
  ConfigProjectScaffoldInputSchema,
  ConfigTargetCreateInputSchema,
  ConfigTargetEditInputSchema,
  CONFIG_BLOCKED_REASONS,
} from '../actions'
import { base64Encode } from '../base64'
import {
  CROSS_BOUNDARY_REASONS,
  SECRET_ADJACENT_CONFIG_FIELDS,
  isSecretAdjacentConfigField,
} from '../constants'
import { renderConfigDiff } from '../diff-digest'
import { ConfigChangeFoldInputSchema, ConfigChangeFoldOutputSchema } from '../../functions/tool-folds'

const RETIRED_ACTION_EXPORTS = [
  'ConfigUndoProposeInputSchema',
  'ConfigProposalApplyInputSchema',
  'ConfigApplyCommitSchema',
  'ConfigApplyReceiptsSchema',
  'ConfigApplyOutcomeSchema',
] as const

type ChangeArm = (typeof ConfigChangeOutputSchema.options)[number]
function changeArm(outcome: string): ChangeArm {
  const arm = ConfigChangeOutputSchema.options.find((option) => option.shape.outcome.value === outcome)
  if (arm === undefined) throw new TypeError(`no ${outcome} arm`)
  return arm
}
import { utf8Encode } from '../utf8'

// Each object schema with one value that parses, so every one is checked for `.strict()`.
const STRICT_SCHEMAS = [
  ['ConfigTargetCreateInputSchema', ConfigTargetCreateInputSchema,
    { name: 'shop', platform: 'web', url: 'https://example.com' }],
  ['ConfigTargetEditInputSchema', ConfigTargetEditInputSchema,
    { name: 'shop', changes: { url: 'https://example.com' } }],
  ['ConfigAuthSetInputSchema', ConfigAuthSetInputSchema, { target: 'shop' }],
  ['ConfigHookAddInputSchema', ConfigHookAddInputSchema,
    { name: 'seed', runtime: 'node', file: 'scripts/seed.mjs' }],
  ['ConfigFieldSetInputSchema', ConfigFieldSetInputSchema, { path: 'use.parallel', value: true }],
  ['ConfigProjectScaffoldInputSchema', ConfigProjectScaffoldInputSchema, { domain: 'booking.com' }],
  ['ConfigChangeFileSchema', ConfigChangeFileSchema,
    { path: 'agent-qa.config.yaml', changeKind: 'modify', newContentBase64: '' }],
] as const

describe('the six action inputs and the change file', () => {
  it('parses every listed value — the census is not passing because nothing parses', () => {
    for (const [name, schema, value] of STRICT_SCHEMAS) {
      expect({ name, ok: schema.safeParse(value).success }).toEqual({ name, ok: true })
    }
  })

  it('refuses an unrecognised key on every one of them', () => {
    for (const [name, schema, value] of STRICT_SCHEMAS) {
      const smuggled = schema.safeParse({ ...value, unexpectedKey: 'anything' })
      expect({ name, refused: !smuggled.success }).toEqual({ name, refused: true })
    }
  })

  it('covers every action in the closed class — one input per op id', () => {
    expect(STRICT_SCHEMAS.map(([name]) => name)).toEqual([
      'ConfigTargetCreateInputSchema',
      'ConfigTargetEditInputSchema',
      'ConfigAuthSetInputSchema',
      'ConfigHookAddInputSchema',
      'ConfigFieldSetInputSchema',
      'ConfigProjectScaffoldInputSchema',
      'ConfigChangeFileSchema',
    ])
  })

  it('the hook runtimes are the four the hooks file already admits', () => {
    expect([...CONFIG_HOOK_RUNTIMES]).toEqual(['node', 'bun', 'python', 'bash'])
    expect(ConfigHookAddInputSchema.safeParse({
      name: 'seed', runtime: 'deno', file: 'scripts/seed.ts',
    }).success).toBe(false)
  })

  it('the undo and apply inputs and the apply receipts are deleted with their ops', () => {
    expect(RETIRED_ACTION_EXPORTS.filter((name) => name in actions)).toEqual([])
  })

  it('the scaffold input carries the domain and nothing a model could invent', () => {
    expect(Object.keys(ConfigProjectScaffoldInputSchema.shape)).toEqual(['domain'])
  })

})

/**
 * Does any of these field names look like somewhere a VALUE could be put?
 *
 * The predicate is deliberately broad — it is looking for the shape of a mistake, not for a known
 * bad name — and its ability to fire is proven below before it is trusted to pass.
 */
function namesAValueBearingField(keys: readonly string[]): string[] {
  return keys.filter((key) => /secret|password|token|credential|apikey|value|\bkey$/i.test(key))
}

describe('set_auth is refs-only by shape, not by discipline', () => {
  const keys = Object.keys(ConfigAuthSetInputSchema.shape)

  it('the predicate can fire — a control keyset carrying a credential field is caught', () => {
    expect(namesAValueBearingField(['target', 'password'])).toEqual(['password'])
    expect(namesAValueBearingField(['target', 'apiKey'])).toEqual(['apiKey'])
    expect(namesAValueBearingField(['target', 'authStateSecret'])).toEqual(['authStateSecret'])
  })

  it('the keyset is exactly the three references, in the order the shape declares them', () => {
    expect(keys).toEqual(['target', 'pluginPackage', 'envVarName'])
  })

  it('no field of it could carry a credential value', () => {
    expect(namesAValueBearingField(keys)).toEqual([])
  })

  it('a credential handed to it under any name is refused by strictness', () => {
    for (const smuggled of ['password', 'token', 'apiKey', 'authStateValue']) {
      expect(ConfigAuthSetInputSchema.safeParse({ target: 'shop', [smuggled]: 'hunter2' }).success)
        .toBe(false)
    }
  })
})

describe('the blocked arm cannot carry the payload it blocked', () => {
  // Spelled in parts so a grep for the retired name finds no live spelling.
  const RETIRED_REASON = ['guardrail', 'hit'].join('-')
  const RETIRED_FIELD = ['scan', 'Findings'].join('')
  const RETIRED_SCHEMA = ['Config', 'Scan', 'Finding', 'Schema'].join('')
  const blocked = {
    outcome: 'blocked' as const,
    summaryLine: 'set use.parallel to a string',
    blockedReason: 'schema-fail' as const,
    paths: ['agent-qa.config.yaml'],
    validationIssues: ['use.parallel: expected boolean, received string'],
  }
  const finding = {
    path: 'agent-qa.config.yaml',
    field: 'workspace.secretsFile',
    detector: 'known-secret',
    redactedFingerprint: 'sha256:9f86…0a08',
  }

  it('parses as a config payload, and narrows to the blocked arm', () => {
    const parsed = ConfigChangeOutputSchema.parse(blocked)
    expect(parsed.outcome).toBe('blocked')
  })

  it('refuses a payload carrying the rendered diff bytes', () => {
    expect(ConfigChangeOutputSchema.safeParse({
      ...blocked,
      shownDiffBase64: base64Encode(utf8Encode('--- a/agent-qa.config.yaml\n')),
    }).success).toBe(false)
    expect(ConfigChangeOutputSchema.safeParse({
      ...blocked,
      shownDiffDigest: 'deadbeef',
    }).success).toBe(false)
  })

  it('refuses a payload carrying file content', () => {
    expect(ConfigChangeOutputSchema.safeParse({
      ...blocked,
      newContentBase64: base64Encode(utf8Encode('use:\n  parallel: true\n')),
    }).success).toBe(false)
    expect(ConfigChangeOutputSchema.safeParse({
      ...blocked,
      files: [{ path: 'agent-qa.config.yaml', changeKind: 'modify', newContentBase64: '' }],
    }).success).toBe(false)
  })

  it('has no diff or content field in its declared shape at all', () => {
    const shape = Object.keys(changeArm('blocked').shape)
    expect(shape.filter((key) => /diff|content|bytes|base64/i.test(key))).toEqual([])
    expect(shape).toEqual([
      'outcome',
      'summaryLine',
      'blockedReason',
      'paths',
      'validationIssues',
    ])
  })

  it('names one posture and one reason, and the guardrail reason is gone', () => {
    expect([...CONFIG_BLOCKED_REASONS]).toEqual(['schema-fail'])
    expect(ConfigChangeOutputSchema.safeParse({ ...blocked, blockedReason: 'other' }).success)
      .toBe(false)
    expect(ConfigChangeOutputSchema.safeParse({ ...blocked, blockedReason: RETIRED_REASON }).success)
      .toBe(false)
  })

  it('a schema-fail carries validation issues and no scan findings', () => {
    expect(ConfigChangeOutputSchema.safeParse(blocked).success).toBe(true)
    expect(ConfigChangeOutputSchema.safeParse({ ...blocked, [RETIRED_FIELD]: [finding] }).success)
      .toBe(false)
    expect(ConfigChangeOutputSchema.safeParse({ ...blocked, [RETIRED_FIELD]: [] }).success)
      .toBe(false)
  })

  it('the finding schema is deleted with the scan', () => {
    expect(RETIRED_SCHEMA in actions).toBe(false)
  })
})

describe('a produced applyable payload round-trips through its own schema', () => {
  // PRODUCED, NEVER A LITERAL. Every byte-bearing field below comes out of the real primitive and
  // the real codec, so a shape no producer can fill cannot satisfy this cell.
  const oldBytes = utf8Encode('use:\n  parallel: false\n')
  const newBytes = utf8Encode('use:\n  parallel: true\n')
  const rendered = renderConfigDiff([{ path: 'agent-qa.config.yaml', oldBytes, newBytes }])
  if (rendered.outcome !== 'changed') throw new TypeError('the corpus produced no change')
  const digests = rendered.perFileDigests[0]!

  const file = {
    path: 'agent-qa.config.yaml',
    changeKind: 'modify' as const,
    baseDigest: digests.oldDigest!,
    newContentBase64: base64Encode(newBytes),
  }

  it('parses, and parsing changes nothing about it', () => {
    expect(ConfigChangeFileSchema.parse(file)).toEqual(file)
  })

  it('narrows to the applyable arm through the union', () => {
    const parsed = ConfigChangeOutputSchema.parse({
      outcome: 'applied', summaryLine: 'set use.parallel to true', files: [file.path],
      fields: ['use.parallel'], crossBoundary: false, crossBoundaryReasons: [],
      shownDiff: new TextDecoder().decode(rendered.diffBytes),
    })
    expect(parsed.outcome).toBe('applied')
  })
})

describe('the proposed arm cannot carry an EMPTY rendered diff', () => {
  // `shownDiff` carries `.min(1)`, so an empty rendered diff cannot reach a surface.
  const proposed = {
    outcome: 'applied' as const,
    summaryLine: 'configure this project for https://booking.com as target booking-com',
    crossBoundary: true,
    crossBoundaryReasons: ['new-origin' as const],
    files: ['agent-qa.config.yaml'],
    fields: ['registry.targets.booking-com'],
  }

  it('refuses an empty shownDiff', () => {
    expect(ConfigChangeOutputSchema.safeParse({ ...proposed, shownDiff: '' }).success).toBe(false)
  })

  it('accepts a one-character shownDiff — the boundary control', () => {
    // THE CONTROL IS THE POINT OF THE PAIR: `.min(1)` and a rejection of everything are the same
    // cell without it, and a proposed arm nothing could satisfy would be a worse defect than the
    // one being closed.
    expect(ConfigChangeOutputSchema.safeParse({ ...proposed, shownDiff: '-' }).success).toBe(true)
  })

})

describe('the cross-boundary reason vocabulary is closed', () => {
  it('bounds exactly the four classes', () => {
    expect([...CROSS_BOUNDARY_REASONS]).toEqual([
      'secret-adjacent-field',
      'new-origin',
      'hook-added',
      'out-of-set-path',
    ])
  })

  it('the payload accepts every member of it', () => {
    const base = {
      outcome: 'applied' as const,
      summaryLine: 'add target shop',
      files: ['agent-qa.config.yaml'],
      fields: ['registry.targets.shop'],
      shownDiff: 'x',
      crossBoundary: true,
    }
    expect(ConfigChangeOutputSchema.safeParse({
      ...base,
      crossBoundaryReasons: [...CROSS_BOUNDARY_REASONS],
    }).success).toBe(true)
  })

  it('refuses a reason nobody can enforce on', () => {
    expect(ConfigChangeOutputSchema.safeParse({
      outcome: 'applied',
      summaryLine: 'add target shop',
      files: ['agent-qa.config.yaml'],
      fields: ['registry.targets.shop'],
      shownDiff: 'x',
      crossBoundary: true,
      crossBoundaryReasons: ['feels-risky'],
    }).success).toBe(false)
  })
})

describe('the secret-adjacent field set is roots, and matching is by subtree', () => {
  it('names the roots', () => {
    expect([...SECRET_ADJACENT_CONFIG_FIELDS]).toEqual([
      'workspace.envFile',
      'workspace.secretsFile',
      'services.authState',
      'plugins.auth',
      'plugins.providers',
      'registry.targets.*.authState',
      // The committed config binds an auth state at `use.authState`, not under targets.
      'use.authState',
    ])
  })

  it('flags the path the committed configuration actually binds an auth state at', () => {
    // THE CELL THAT WOULD HAVE CAUGHT THE GAP. It is phrased against the two paths together so a
    // reader can see the difference: only one of them is reachable in a committed config.
    expect(isSecretAdjacentConfigField('use.authState')).toBe(true)
    expect(isSecretAdjacentConfigField('use.authState.name')).toBe(true)
    // ...and an ordinary `use` sibling is NOT flagged, so this root did not widen `use` wholesale.
    expect(isSecretAdjacentConfigField('use.parallel')).toBe(false)
    expect(isSecretAdjacentConfigField('use.timeout.step')).toBe(false)
  })

  it('flags each root exactly', () => {
    for (const root of SECRET_ADJACENT_CONFIG_FIELDS) {
      const concrete = root.replace('*', 'shop')
      expect({ root, flagged: isSecretAdjacentConfigField(concrete) })
        .toEqual({ root, flagged: true })
    }
  })

  it('flags anything UNDER a root, whether or not anybody enumerated it', () => {
    for (const path of [
      'services.authState.dir',
      'plugins.auth.0.package',
      'plugins.providers.0.path',
      'use.authState.capture',
      'registry.targets.shop.authState.name',
    ]) {
      expect({ path, flagged: isSecretAdjacentConfigField(path) }).toEqual({ path, flagged: true })
    }
  })

  it('flags an edit ABOVE a root too — setting it replaces the subtree', () => {
    for (const path of [
      'plugins',
      'workspace',
      'services',
      'registry.targets.shop',
      'registry.targets',
    ]) {
      expect({ path, flagged: isSecretAdjacentConfigField(path) }).toEqual({ path, flagged: true })
    }
  })

  it('does not flag the ordinary config a person edits all day', () => {
    for (const path of [
      'use.parallel',
      'use.timeout.step',
      'workspace.testMatch',
      'workspace.hooksFile',
      'registry.targets.shop.url',
      'services.dashboard.port',
      'registry.llms',
      'knowledge.dir',
    ]) {
      expect({ path, flagged: isSecretAdjacentConfigField(path) }).toEqual({ path, flagged: false })
    }
  })

  it('the wildcard matches one segment, never a prefix of a longer name', () => {
    expect(isSecretAdjacentConfigField('registry.targetsOther.shop.authState')).toBe(false)
    expect(isSecretAdjacentConfigField('workspace.envFileBackup')).toBe(false)
  })
})

describe('the config change fold has six arms and no undo arm', () => {
  it('advertises the direct change contract alone and refuses the undo arm', () => {
    expect(ConfigChangeFoldOutputSchema).toBe(ConfigChangeOutputSchema)
    expect(ConfigChangeFoldInputSchema.safeParse({ action: 'config.undo.propose' }).success).toBe(false)
    expect(ConfigChangeFoldInputSchema.safeParse({
      action: 'config.field.set', path: 'use.timeout.step', value: '45s',
    }).success).toBe(true)
    expect(ConfigChangeFoldInputSchema.safeParse({
      action: 'config.field.set', path: 'use.timeout.step', value: '45s', confirmed: true,
    }).success).toBe(false)
    expect('ConfigUndoProposeInputSchema' in actions).toBe(false)
  })
})
