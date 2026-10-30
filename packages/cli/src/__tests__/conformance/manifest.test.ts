// The census cells read the live mint; only `catalog.test.ts` compares committed and live bytes.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentManifestPostureSchema,
  AgentManifestSchema,
  canonicalJson,
  type CapabilityCatalog,
  type CatalogOpRow,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { loadCapabilityCatalog } from '../../capability-catalog/loader.js'
import { buildAgentManifest } from '../../capability-catalog/manifest.js'
import { CLI_FUNCTION_CALLER } from '../../composition/local-agent-host.js'
import { registryOpIds } from './adapters.js'
import {
  CATALOG_PATH,
  catalogExampleCallOf,
  capabilityCatalogFromRoot,
} from './catalog.js'

// ---- The derived example calls ----

describe('the catalog\'s example calls', () => {
  let live: CapabilityCatalog

  beforeAll(async () => {
    live = await capabilityCatalogFromRoot()
  })

  const opRows = (): readonly CatalogOpRow[] =>
    live.rows.filter((row): row is CatalogOpRow => row.kind === 'op')

  it('re-derives byte-identically from each row\'s OWN params — produced, never authored', () => {
    // Each example is what the derivation answers for that row's params; a hand-written one reds.
    const drifted: string[] = []
    for (const row of opRows()) {
      const derived = catalogExampleCallOf(row.params, row.id)
      const carried = {
        exampleCall: row.exampleCall,
        ...(row.exampleCallAbsentReason === undefined
          ? {}
          : { exampleCallAbsentReason: row.exampleCallAbsentReason }),
      }
      if (canonicalJson(derived) !== canonicalJson(carried)) {
        drifted.push(
          `${row.id}: the row carries ${canonicalJson(carried)}, its params derive `
          + `${canonicalJson(derived)}`,
        )
      }
    }
    expect(drifted, 'catalog example calls disagree with what their own params derive').toEqual([])
    expect(opRows().length, 'the catalog produced no op rows to derive examples from')
      .toBeGreaterThan(0)
  })

  it('states an example or a reason there is none — never a silent blank', () => {
    // The cast asks a runtime question: a catalog without the column would pass both filters.
    const columnless = opRows()
      .filter((row) => !('exampleCall' in (row as unknown as Record<string, unknown>)))
      .map((row) => row.id)
    expect(columnless, 'op rows carry no exampleCall column at all').toEqual([])

    const unexplained = opRows()
      .filter((row) => row.exampleCall === null && row.exampleCallAbsentReason === undefined)
      .map((row) => row.id)
    const overExplained = opRows()
      .filter((row) => row.exampleCall !== null && row.exampleCallAbsentReason !== undefined)
      .map((row) => row.id)
    expect(unexplained, 'op rows carry no example call and no reason there is none').toEqual([])
    expect(overExplained, 'op rows carry both an example call and a reason there is none')
      .toEqual([])
  })

  it('names every key an example carries in the row\'s own required set', () => {
    // A derived example that invented a key would be teaching an argument the contract refuses,
    // which is exactly the failure this column exists to avoid rather than to introduce.
    const invented: string[] = []
    for (const row of opRows()) {
      if (row.exampleCall === null) continue
      const required = Array.isArray(row.params.required) ? row.params.required as string[] : []
      for (const key of Object.keys(row.exampleCall.arguments)) {
        if (!required.includes(key)) invented.push(`${row.id}.${key}`)
      }
      // …and every required key IS present, or the example is a call the contract would refuse
      // for the opposite reason.
      for (const key of required) {
        if (!(key in row.exampleCall.arguments)) invented.push(`${row.id}.${key} (missing)`)
      }
    }
    expect(invented, 'derived example calls disagree with their row\'s required property set')
      .toEqual([])
  })

  it('refuses on exactly the pinned constructs, and shows an example everywhere else', () => {
    // THE ABSENCE ARM IS A PINNED CLOSED SET, not an escape hatch. Without this cell a derivation
    // that quietly started refusing everything would leave a catalog of forty-one explicit
    // absences and every other cell above green.
    const absent = opRows().filter((row) => row.exampleCall === null).map((row) => row.id).sort()
    expect(
      absent,
      'the set of ops with no derivable example moved. Every member is an op whose required '
      + 'params carry a construct the derivation will not guess at (today: a regular-expression '
      + '`pattern`). A new member is a deliberate decision, not a default.',
    ).toEqual([
      // `runs.artifact` needs a hex `sha` and the derivation guesses no `pattern`, so it is absent.
      'runs.artifact',
    ])
    // The vacuity floor on the other side: most ops DO get an example, and a derivation that
    // returned `{}` for everything would satisfy every cell above this one.
    const withArguments = opRows().filter(
      (row) => row.exampleCall !== null && Object.keys(row.exampleCall.arguments).length > 0,
    )
    expect(withArguments.length, 'no op row carries an example call with any argument in it')
      .toBeGreaterThan(20)
  })

  it('derives each documented construct, driven over synthetic schemas', () => {
    // THE DERIVATION'S OWN BRANCHES, driven with input rather than asserted about. The registry's
    // real params exercise most of these, but "most" is not a list, and a branch nobody has seen
    // answer is a branch nobody has seen answer.
    const derive = (properties: Record<string, unknown>, required: readonly string[]): unknown =>
      catalogExampleCallOf(
        { type: 'object', additionalProperties: false, properties, required: [...required] },
        'control.398.08',
      )

    expect(derive({ name: { type: 'string' } }, ['name']))
      .toEqual({ exampleCall: { arguments: { name: '<NAME>' } } })
    expect(derive({ count: { type: 'integer', minimum: 0, maximum: 10 } }, ['count']))
      .toEqual({ exampleCall: { arguments: { count: 0 } } })
    expect(derive({ count: { type: 'integer', minimum: 3 } }, ['count']))
      .toEqual({ exampleCall: { arguments: { count: 3 } } })
    expect(derive({ count: { type: 'integer', exclusiveMinimum: 0 } }, ['count']))
      .toEqual({ exampleCall: { arguments: { count: 1 } } })
    expect(derive({ on: { type: 'boolean' } }, ['on']))
      .toEqual({ exampleCall: { arguments: { on: false } } })
    expect(derive({ kind: { type: 'string', enum: ['a', 'b'] } }, ['kind']))
      .toEqual({ exampleCall: { arguments: { kind: 'a' } } })
    expect(derive({ kind: { type: 'string', const: 'web' } }, ['kind']))
      .toEqual({ exampleCall: { arguments: { kind: 'web' } } })
    expect(derive({ tags: { type: 'array' } }, ['tags']))
      .toEqual({ exampleCall: { arguments: { tags: [] } } })
    expect(derive({}, []))
      .toEqual({ exampleCall: { arguments: {} } })
    expect(
      derive(
        {
          nested: {
            type: 'object',
            additionalProperties: false,
            properties: { inner: { type: 'string' } },
            required: ['inner'],
          },
        },
        ['nested'],
      ),
    ).toEqual({ exampleCall: { arguments: { nested: { inner: '<INNER>' } } } })

    // A DISCRIMINATED `oneOf` resolves to its first branch…
    expect(
      derive(
        {
          window: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: { scope: { type: 'string', const: 'session' }, ref: { type: 'string' } },
                required: ['scope', 'ref'],
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: { scope: { type: 'string', const: 'all-time' } },
                required: ['scope'],
              },
            ],
          },
        },
        ['window'],
      ),
    ).toEqual({ exampleCall: { arguments: { window: { scope: 'session', ref: '<REF>' } } } })
  })

  it('refuses rather than guessing, on every construct it cannot satisfy', () => {
    // THE REFUSING BRANCHES, driven — the half a green suite never reaches. Each of these is a
    // shape where a placeholder would be a value the shipped contract REJECTS, and an example an
    // agent copies and gets refused for is worse than a column that says there is none.
    const derive = (properties: Record<string, unknown>, required: readonly string[]): {
      exampleCall: unknown
      exampleCallAbsentReason?: string
    } => catalogExampleCallOf(
      { type: 'object', additionalProperties: false, properties, required: [...required] },
      'control.398.08',
    )

    const refusal = (properties: Record<string, unknown>, required: readonly string[]): string => {
      const answer = derive(properties, required)
      expect(answer.exampleCall, `${canonicalJson(properties)} produced an example`).toBeNull()
      return answer.exampleCallAbsentReason ?? ''
    }

    // (a) A regular expression. The four real ops in the pinned set above are all this case.
    expect(refusal({ id: { type: 'string', pattern: '^prop_[a-z]+$' } }, ['id']))
      .toContain('^prop_[a-z]+$')
    // (b) A keyword the derivation has no rule for — the OPEN edge, refused by default rather
    //     than ignored. A schema keyword this derivation silently dropped would produce a value
    //     that looks right and is not.
    expect(refusal({ id: { type: 'string', format: 'uuid' } }, ['id'])).toContain('format')
    // (c) A `minLength` the placeholder cannot reach. `<ID>` is four characters; a contract asking
    //     for ten would refuse it.
    expect(refusal({ id: { type: 'string', minLength: 40 } }, ['id'])).toContain('minLength')
    // (d) An undiscriminated `oneOf`: branch 0's value may match branch 1 too, and a value that
    //     matches two branches of a `oneOf` is refused BECAUSE it matches two.
    expect(
      refusal(
        {
          either: {
            oneOf: [
              { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
              { type: 'object', additionalProperties: false, properties: { b: { type: 'string' } } },
            ],
          },
        },
        ['either'],
      ),
    ).toContain('oneOf')
    // (e) A required property with no schema at all.
    expect(refusal({}, ['ghost'])).toContain('ghost')
    // (f) A bound pair no number satisfies.
    expect(refusal({ n: { type: 'integer', minimum: 5, maximum: 1 } }, ['n'])).toContain('maximum')
    // (g) An array that must carry elements — deriving one would need a value for a schema the
    //     derivation was not handed.
    expect(refusal({ tags: { type: 'array', minItems: 1 } }, ['tags'])).toContain('minItems')

    // …and the control on the control: the same shapes WITHOUT the refused construct derive.
    expect(derive({ id: { type: 'string' } }, ['id']).exampleCall)
      .toEqual({ arguments: { id: '<ID>' } })
  })
})

// ---- `init --agent` ---------------------------------------------------------------------

describe('the agent manifest', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /**
   * A real project on disk, and the ONE place a token entry is declared in this file.
   *
   * The declared credential is what makes the refs-only cell a measurement rather than a shape
   * assertion: without an entry there is no name to find and no value to fail to find.
   */
  const fixtureProject = (label: string, tokenEnvVar?: string): string => {
    const root = mkdtempSync(join(tmpdir(), `agent-qa-398-08-${label}-`))
    roots.push(root)
    writeFileSync(
      join(root, 'agent-qa.config.yaml'),
      `${JSON.stringify(
        {
          workspace: {
            testMatch: ['tests/**/*.yaml'],
            testPathIgnore: [],
            suiteMatch: ['suites/**/*.suite.yaml'],
            hooksFile: 'hooks.yaml',
            envFile: '.env',
            secretsFile: '.env.secrets.local',
          },
          use: { mobile: { appState: 'preserve' } },
          ...(tokenEnvVar === undefined
            ? {}
            : {
                services: {
                  mcp: {
                    tokens: [{ name: 'ci', tokenEnvVar, scopes: ['read'] }],
                  },
                },
              }),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return root
  }

  it('IS the committed catalog: rows, through the ONE loader', async () => {
    // Both sides read the committed artifact via `loadCapabilityCatalog`: the manifest is a load.
    const manifest = await buildAgentManifest({
      configPath: join(fixtureProject('identity'), 'agent-qa.config.yaml'),
    })
    const catalog = loadCapabilityCatalog(CATALOG_PATH)

    expect(manifest.rows, 'the manifest and the committed catalog disagree about the rows')
      .toEqual(catalog.rows)
    // The vacuity floor: two empty sides agree perfectly and prove nothing.
    expect(manifest.rows.length, 'the manifest carried no rows').toBeGreaterThan(0)
  })

  it('emits EVERY row, unfiltered — it documents, it does not grant', async () => {
    // The manifest must not filter: a second application of the visibility law drops rows silently.
    const manifest = await buildAgentManifest({
      configPath: join(fixtureProject('unfiltered'), 'agent-qa.config.yaml'),
    })
    // Rows carry no scope column, so the claim is completeness: every registered op is a row.
    const opRows = manifest.rows.filter((row): row is CatalogOpRow => row.kind === 'op')
    expect(
      opRows.map((row) => row.id).sort(),
      'the manifest dropped a registered capability — it has started filtering',
    ).toEqual([...registryOpIds()].sort())
    expect(opRows.filter((row) => row.id.startsWith('config.') && row.id !== 'config.get').length)
      .toBeGreaterThan(0)
    // The note says the manifest is unfiltered and nothing is permissioned, in the document itself.
    expect(manifest.$note.join(' ')).toContain('THIS MANIFEST IS UNFILTERED')
    expect(manifest.$note.join(' ')).toContain('there are no permissions')
    expect(manifest.$note.join(' ')).not.toMatch(/grant list/iu)
  })

  it('reports a declared credential by env-ref NAME and never by value',
    async () => {
    // THE REFS-ONLY LAW, DRIVEN OVER A REAL SECRET. A cell that only asserted the shape of the
    // posture would pass against a manifest that also carried the value in some field nobody
    // thought to look at, so what is asserted is the ABSENCE OF THE BYTES from the whole
    // serialized document — the surface a person actually reads.
    const sentinel = 'sk-398-08-sentinel-2b41c9d7e5f60a83'
    const tokenEnvVar = 'AGENT_QA_SENTINEL_TOKEN'
    const configPath = join(fixtureProject('refs-only', tokenEnvVar), 'agent-qa.config.yaml')

    const previous = process.env[tokenEnvVar]
    process.env[tokenEnvVar] = sentinel
    try {
      const manifest = await buildAgentManifest({ configPath })

      // The sentinel must be set while the manifest builds, or its absence below proves nothing.
      expect(process.env[tokenEnvVar], 'the sentinel was not set during the build').toBe(sentinel)

      const serialized = JSON.stringify(manifest, null, 2)

      // The legacy block is a deleted key, so the config does not resolve.
      expect(manifest.posture.configuration, 'a legacy token block must fail strict validation')
        .toBe('unresolved')
      // No ref is reported; the whole set of rows is the non-vacuity control.
      expect(manifest.posture, 'the manifest reported a legacy token declaration')
        .not.toHaveProperty('tokenEnvRefs')
      expect(manifest.rows.length, 'the manifest carried no rows').toBeGreaterThan(0)

      // …and the VALUE is nowhere in it. The environment variable was SET while the manifest was
      // built, so any path from a declared name to its contents would have had one.
      expect(
        serialized.includes(sentinel),
        'the serialized manifest contains the token VALUE — a declared credential reached the '
        + 'document that documents it',
      ).toBe(false)
    } finally {
      if (previous === undefined) delete process.env[tokenEnvVar]
      else process.env[tokenEnvVar] = previous
    }
  })

  // The posture is `.strict()`, so a token ref, with a value or without, stops parsing.
  it('refuses a token ref on the strict posture, with a value or without one', () => {
    const refused = AgentManifestPostureSchema.safeParse({
      configuration: 'resolved',
      tokenEnvRefs: [{
        name: 'ci',
        tokenEnvVar: 'AGENT_QA_TOKEN',
        scopes: ['read'],
        token: 'sk-live-nobody-should-be-able-to-write-this',
      }],
    })
    expect(refused.success, 'a token ref carrying a value parsed').toBe(false)
    expect(
      AgentManifestPostureSchema.safeParse({
        configuration: 'resolved',
        tokenEnvRefs: [{ name: 'ci', tokenEnvVar: 'AGENT_QA_TOKEN', scopes: ['read'] }],
      }).success,
      'a posture carrying a value-free token ref parsed — the member is back',
    ).toBe(false)
    // …and the posture without it is accepted, so the refusal is about the extra member.
    expect(AgentManifestPostureSchema.safeParse({ configuration: 'resolved' }).success).toBe(true)
  })

  it('reports a posture of exactly { configuration }, with no default grant or safe-mode member', async () => {
    const manifest = await buildAgentManifest({
      configPath: join(fixtureProject('posture'), 'agent-qa.config.yaml'),
    })
    expect(manifest.posture, 'the manifest still reports a default grant')
      .not.toHaveProperty('defaultScopes')
    expect(Object.keys(manifest.posture), 'the local posture carries a retired permission member')
      .toEqual(['configuration'])
    expect(manifest.posture, 'no composition hides an op from a listing').not.toHaveProperty('safeMode')
    expect(CLI_FUNCTION_CALLER, 'the CLI mint carries no safe-mode flag').not.toHaveProperty('safeMode')
    expect(manifest.posture.configuration, 'a resolvable config was reported unresolved')
      .toBe('resolved')
  })

  it('tells a directory that is not a project yet from one whose config will not read', async () => {
    // `init --agent` is what an agent runs BEFORE there is a project — that is what `init` is for —
    // so neither state below may be an error, and neither may be reported as `resolved` with no
    // credentials, which reads as "this workspace declares none" about a workspace nobody could
    // read. The two are told apart by whether the FILE IS THERE, so the classification never comes
    // from an exception's message: the message quotes the file, and the file is where credentials
    // are declared.
    const bare = mkdtempSync(join(tmpdir(), 'agent-qa-398-08-bare-'))
    roots.push(bare)
    const absent = await buildAgentManifest({ configPath: join(bare, 'agent-qa.config.yaml') })
    expect(absent.posture.configuration, 'a directory with no config did not report `absent`')
      .toBe('absent')
    expect(absent.posture, 'a directory with no config reported credentials')
      .not.toHaveProperty('tokenEnvRefs')
    // The capability half is workspace-independent and must still be whole.
    expect(absent.rows.length, 'a directory with no config produced no rows').toBeGreaterThan(0)

    // …and a config that IS there and does not validate is the OTHER answer. `init` is the wrong
    // advice for this one, which is why it must not share an arm with the case above.
    const broken = mkdtempSync(join(tmpdir(), 'agent-qa-398-08-broken-'))
    roots.push(broken)
    const brokenPath = join(broken, 'agent-qa.config.yaml')
    writeFileSync(brokenPath, '{ "workspace": { "testMatch": 17 } }\n', 'utf8')
    const unresolved = await buildAgentManifest({ configPath: brokenPath })
    expect(unresolved.posture.configuration, 'an unreadable config did not report `unresolved`')
      .toBe('unresolved')
    expect(unresolved.posture, 'an unreadable config reported credentials').not.toHaveProperty('tokenEnvRefs')
    // The refusal carries no text out of the file it refused, which is the whole reason the arm is
    // a bare enum member.
    expect(JSON.stringify(unresolved)).not.toContain('testMatch')
  })

  it('parses against the published manifest contract, so no consumer defends against its shape',
    async () => {
      const manifest = await buildAgentManifest({
        configPath: join(fixtureProject('contract'), 'agent-qa.config.yaml'),
      })
      const parsed = AgentManifestSchema.safeParse(JSON.parse(JSON.stringify(manifest)) as unknown)
      expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.')))
        .toEqual([])
    })

  it('is idempotent: two builds are the same document', async () => {
    // A READ, and reads repeat. If two consecutive builds could differ, every cell above would be
    // measuring one draw from a distribution — and the anchor in `parity-anchors.test.ts`, which
    // compares a build here against one in another process, would be measuring two.
    const configPath = join(fixtureProject('idempotent'), 'agent-qa.config.yaml')
    const first = await buildAgentManifest({ configPath })
    const second = await buildAgentManifest({ configPath })
    expect(canonicalJson(second), 'two consecutive manifest builds differ')
      .toBe(canonicalJson(first))
  })
})
