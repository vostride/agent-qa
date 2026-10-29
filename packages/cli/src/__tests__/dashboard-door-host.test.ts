// The dashboard door host's claims that outlive its chat door (430-03, D-01 step 1).
//
// Every cell here drives the shipped `composeDashboardDoor` and reads what it composed through its
// own registry with `DASHBOARD_FUNCTION_CALLER`, so each claim is measured at the op boundary
// without a chat turn. The base-URL overlay stays because the co-hosted MCP endpoint serves this
// registry and reads cards through it (430 RESEARCH P5, Open Question 1).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { invokeFunction } from '@vostride/agent-qa-agent'
import type { LocalAgentHost } from '@vostride/agent-qa-agent-local'
import { publishBundleForTest } from '@vostride/agent-qa-knowledge-local'
import type { BundleStoreConfig, PublishBundleInput } from '@vostride/agent-qa-knowledge-local'
import { EntityCardSchema, MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  composeDashboardDoor,
  overlayDashboardBaseUrl,
  DASHBOARD_FUNCTION_CALLER,
} from '../commands/dashboard.js'

/**
 * A deterministic project the door can be composed over, and nothing more.
 *
 * It VALIDATES against `AgentQaConfigSchema` (an invalid config kills the capability that reads
 * configuration before dispatch), and it declares one target so the project is in the ordinary
 * posture rather than the empty one that refuses before the gate.
 */
function fixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-430-03-'))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      registry: {
        targets: {
          conformance: { platform: 'web', url: 'https://conformance.invalid' },
        },
      },
    })}\n`,
    'utf8',
  )
  // config.get reads through the declared mask, which needs the file.
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return configPath
}

interface HostFixture {
  readonly origin: string
  readonly configRoot: string
  readonly host: LocalAgentHost
  readonly server: Server
}

async function openHost(): Promise<HostFixture> {
  const configPath = fixtureWorkspace()
  const configRoot = dirname(resolve(configPath))
  // The bound origin, closed over and written after `listen` — the same mutable box the shipped
  // command uses, so D-16's second supplier is exercised rather than argued.
  let boundOrigin: string | undefined
  const { host } = composeDashboardDoor({
    agentQaRoot: join(configRoot, '.agent-qa'),
    configPath,
    boundOrigin: () => boundOrigin,
    resolveExecutionContext: () => 'local-interactive',
  })
  // The server only has to own a real ephemeral port; it mounts no router.
  const server = createServer((_request, response) => {
    response.statusCode = 204
    response.end()
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new TypeError('the door host bound no port')
  }
  boundOrigin = `http://127.0.0.1:${String(address.port)}`
  return { origin: boundOrigin, configRoot, host, server }
}

async function closeHost(fixture: HostFixture): Promise<void> {
  await new Promise<void>((closed) => fixture.server.close(() => closed()))
  await fixture.host.close()
  rmSync(fixture.configRoot, { recursive: true, force: true })
}

describe('the dashboard door host supplies the card url base it bound', () => {
  let fixture: HostFixture

  beforeAll(async () => {
    fixture = await openHost()
  })

  afterAll(async () => {
    await closeHost(fixture)
  })

  it('overlays services.dashboard.baseUrl with the origin it actually bound', async () => {
    // 387 D-10 made the entity card's `url` config-derived and absent by default, read through the
    // masker at `services.dashboard.baseUrl`. D-16 adds the SECOND SUPPLIER: a dashboard that
    // serves its own registry knows its own origin, so cards it produces carry working links with
    // no user setup — one mechanism, two suppliers, and no change to the card producer.
    //
    // MEASURED AT THE OP BOUNDARY, which is the only place the claim is about the product. The
    // producer reads `deps.config.getMasked()`, so invoking `config.get` on the door's registry
    // reads the exact entry the producer would: same port, same composition, same masking oracle.
    const payload = await invokeFunction(
      fixture.host.registry,
      'config.get',
      {},
      DASHBOARD_FUNCTION_CALLER,
    ) as {
      entries?: readonly { key: string; value: string; source: string; masked: boolean }[]
    }
    const entry = payload.entries?.find((row) => row.key === 'services.dashboard.baseUrl')
    expect(entry, 'the door composed no dashboard base URL, so every card it renders would be '
      + 'url-absent even though this server has an address').toBeDefined()
    expect(entry?.value, 'the base URL must be the origin this server BOUND, not a guess: an '
      + 'ephemeral port is a real posture and a value captured before `listen` would be wrong')
      .toBe(fixture.origin)
    // `masked: false` is load-bearing, not decoration. The producer decides a base is usable by
    // reading that flag — a `true` here would make the whole overlay contribute nothing, and the
    // cards would be url-absent with everything else looking correct.
    expect(entry?.masked, 'a masked base is treated as NO base by the card producer').toBe(false)
    expect(entry?.source, 'no file, environment variable or flag carries this value').toBe('default')
  })

  it('lets an operator\'s own configured base URL win over the bound origin', async () => {
    // THE OVERLAY FILLS AN ABSENCE AND NEVER REPLACES A PRESENCE. A configured base is somebody
    // pointing at something — a reverse proxy, a tunnel, a path prefix — and overwriting it with
    // `http://127.0.0.1:<port>` would silently redirect every card link away from the address they
    // chose. The knob stays THE mechanism; this door is its second supplier, not its owner.
    const configured = 'https://qa.example.invalid'
    const overlaid = overlayDashboardBaseUrl(
      {
        getMasked: async () => Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [{
            key: 'services.dashboard.baseUrl',
            value: configured,
            source: 'config-file' as const,
            masked: false,
          }],
        }),
      },
      () => 'http://127.0.0.1:9999',
      // No workspace supplied: this cell is about the baseUrl half's precedence, and the second
      // half has its own control below. `undefined` overlays nothing for that key, which
      // keeps the assertion below a statement about one supplier rather than two.
      undefined,
    )
    const masked = await overlaid.getMasked()
    expect(
      masked.entries.filter((row) => row.key === 'services.dashboard.baseUrl'),
      'the operator\'s value must survive, exactly once',
    ).toEqual([{
      key: 'services.dashboard.baseUrl',
      value: configured,
      source: 'config-file',
      masked: false,
    }])
  })
})

describe('the door is composed once, and mounted where the server serves it', () => {
  it('dispatches as a caller derived from the CLI chat door\'s own mint', async () => {
    // Pitfall 9's check, in the only form that can catch it: the two mints are compared as SETS
    // rather than each spelled here. A literal list in this cell would be a third copy, agreeing
    // with both today and with neither the day a seventh scope lands.
    const { CLI_FUNCTION_CALLER } = await import('../composition/local-agent-host.js')
    // `grantedScopes` and `safeMode` are deleted from the caller, so
    // the two mints are compared as KEY sets instead: they agree on every member but `surface`.
    expect(Object.keys(DASHBOARD_FUNCTION_CALLER).sort())
      .toEqual(Object.keys(CLI_FUNCTION_CALLER).sort())
    expect(DASHBOARD_FUNCTION_CALLER.origin).toBe(CLI_FUNCTION_CALLER.origin)
    expect(DASHBOARD_FUNCTION_CALLER).not.toHaveProperty('safeMode')
    expect(CLI_FUNCTION_CALLER).not.toHaveProperty('safeMode')
    // Attribution is the one difference, and it is the only legitimate one.
    expect(DASHBOARD_FUNCTION_CALLER.surface).toBe('dashboard')
  })

  // RE-SPELLED 2026-10-01: was a pin that `routes.ts` mounted the run-confirm router
  // the security corpus stood up itself. That router is deleted and the corpus now drives the
  // shipped `startServer`, so the claim that survives is the "no second door" half: the shipped
  // router dispatches no run-confirm prefix and mounts no router of its own beside its routes, and
  // the mark arm reaches the one mark route.
  it('mounts the SAME router the cells above drive (no second door)', () => {
    const routesPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../dashboard-server/src/server/routes.ts',
    )
    const source = readFileSync(routesPath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(source).not.toContain('createChat' + 'Router')
    expect(source).not.toContain('RUN_CONFIRM_' + 'ROUTE_PREFIX')
    expect(source).not.toContain('/api/run-' + 'confirm')
    expect(source.split('registerRunMarkRoute(').length - 1, 'the mark arm is not the one route').toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Gap 1: the card's OWN `url`, read off the door's registry.
//
// The overlay cells above assert one entry in `config.get`'s masked listing, and the claim D-16
// makes is about a CARD. The producer requires BOTH halves of the url base
// (`services.dashboard.baseUrl` AND `services.dashboard.workspace`, `card-context.ts`), so this
// block asserts the field a person sees.
//
// ORTHOGONAL TO ROUTED-KIND HONESTY, deliberately. MEM is unrouted and stays unrouted: `url`
// present and `kind` routed are two claims and this file keeps them apart.

/** The workspace directory name the segment must be derived FROM — known here, asserted below. */
const CARD_URL_WORKSPACE_NAME = 'ws-cardurl'

/**
 * The origin the overlay is handed: a value nothing else in this file can produce, so a base
 * derived from the factory is visible as such.
 */
const CARD_URL_ORIGIN = 'http://localhost:4599'

const CARD_URL_PRODUCT = 'gap1-card-url-product'
const CARD_URL_SUMMARY = 'Checkout control, gap 1'

interface CardUrlFixture {
  readonly parent: string
  readonly host: LocalAgentHost
  readonly bundleId: string
}

/**
 * A project whose directory NAME is the workspace segment, with one real entity in it.
 *
 * The parent temp root is `mkdtemp`'d and the project sits inside it under a fixed name, because
 * `mkdtemp`'s own suffix is random and the segment under measurement has to be a value this cell
 * can name. The knowledge root is declared so the bundle below has somewhere to land.
 */
function cardUrlProject(): { parent: string; root: string; knowledgeRoot: string; configPath: string } {
  const parent = mkdtempSync(join(tmpdir(), 'agent-qa-400-10-'))
  const root = join(parent, CARD_URL_WORKSPACE_NAME)
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: 'agent-qa-knowledge' },
      use: { mobile: { appState: 'reset' } },
      registry: {
        targets: {
          conformance: { platform: 'web', url: 'https://conformance.invalid' },
        },
      },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return { parent, root, knowledgeRoot, configPath }
}

/**
 * Publish ONE real memory bundle through the shipped writer (dashboard-dom's idiom).
 *
 * MEM is the only kind this build can mint an address for — `compose-local-agent.ts` wires exactly
 * one sighting source — so it is the only kind a DRIVEN card cell can be about here.
 */
function seedCardUrlBundle(project: { root: string; knowledgeRoot: string }): string {
  const config: BundleStoreConfig = {
    knowledgeRoot: project.knowledgeRoot,
    productKey: CARD_URL_PRODUCT,
  }
  const input: PublishBundleInput = {
    draft: {
      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
      scope: { tier: 'product', key: CARD_URL_PRODUCT },
      summary: CARD_URL_SUMMARY,
      body: 'The verified checkout control.',
      distilledEvidenceRef: { id: 'gap1-evidence', sha: 'b'.repeat(64) },
      originStage: 'run-curation',
    },
    discriminant: {
      kind: 'fact',
      subtype: 'selector',
      elementRef: { role: 'button', name: 'Checkout' },
    },
    originClass: 'agent-verified',
    createdAtOrdinal: 5,
    screenStates: [],
    initialEvents: [],
    relations: [],
    provenance: {
      mode: 'run-linked',
      runId: 'gap1-run',
      testId: 'gap1-test',
      stepIndex: 0,
      sourceBuildOrdinal: 5,
    },
    artifacts: [],
  }
  const published = publishBundleForTest(config, input)
  if (published.kind !== 'published') {
    throw new Error(`the gap-1 fixture published no bundle: ${JSON.stringify(published)}`)
  }
  return published.id
}

describe('a card the co-hosted door\'s registry produces carries a url', () => {
  let fixture: CardUrlFixture

  beforeAll(() => {
    const project = cardUrlProject()
    const bundleId = seedCardUrlBundle(project)
    const { host } = composeDashboardDoor({
      agentQaRoot: join(project.root, '.agent-qa'),
      configPath: project.configPath,
      boundOrigin: () => CARD_URL_ORIGIN,
      resolveExecutionContext: () => 'local-interactive',
    })
    fixture = { parent: project.parent, host, bundleId }
  })

  afterAll(async () => {
    await fixture.host.close()
    rmSync(fixture.parent, { recursive: true, force: true })
  })

  it('DRIVEN: entities.get returns a card whose own `url` names the bound origin and this workspace',
    async () => {
      // `entities.get` NEVER MINTS (387 D-09: a get that could write would make every card render
      // a mutation), so the address has to exist before it is asked for. `entities.resolve` is the
      // sighting leg that mints it, invoked on the same registry as the same caller.
      const resolution = await invokeFunction(
        fixture.host.registry,
        'entities.resolve',
        { ref: fixture.bundleId },
        DASHBOARD_FUNCTION_CALLER,
      ) as { kind?: string; card?: { kind?: string; id?: string; uri?: string } }
      expect(resolution.kind, 'the seeded bundle did not resolve').toBe('resolved')
      const uri = resolution.card?.uri
      expect(uri, 'the sighting minted no address, so there is nothing to `get`').toBeDefined()

      // PARSED BY THE SCHEMA, never shape-checked (400-08's anti-duck-typing rule). A `url` on an
      // object this cell merely believes is a card would be a claim about this cell.
      const card = EntityCardSchema.parse(await invokeFunction(
        fixture.host.registry,
        'entities.get',
        { ref: uri },
        DASHBOARD_FUNCTION_CALLER,
      ))

      expect(
        card.url,
        'the card the door\'s registry produced carries no `url`: the host supplied only one of '
        + 'the two halves `readDashboardUrlBase` requires, so `urlBase` is undefined and the '
        + 'producer omits the field on every card',
      ).toBeTypeOf('string')
      // The ORIGIN half, from the factory — and the WORKSPACE half, from the project directory's
      // own name. Asserting the prefix asserts both suppliers at once; neither is guessable from
      // the other, and the shipped `/t/:workspace/:kind/:shortId/:slug` route puts them adjacent.
      expect(card.url).toMatch(
        new RegExp(`^${CARD_URL_ORIGIN}/t/${CARD_URL_WORKSPACE_NAME}/memory/`, 'u'),
      )
      expect(card.url, 'the kind segment must be the URI word, not the short-ID prefix')
        .toContain('/memory/')
      expect(card.kind, 'MEM stays MEM: url-present is not routed-kind').toBe('MEM')
    })

  it('overlays BOTH producer halves, read back verbatim from the shipped overlay', async () => {
    // The producer's rule is an AND over two keys read through `verbatim()`, so an overlay that
    // supplies one of them contributes exactly nothing — which is the whole of gap 1. Read BOTH
    // keys back off one `getMasked()`, with the flags, because `masked: true` on either half is
    // the silent-inert failure this assertion exists to stop somebody re-introducing.
    const overlaid = overlayDashboardBaseUrl(
      {
        getMasked: async () => Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
      },
      () => CARD_URL_ORIGIN,
      CARD_URL_WORKSPACE_NAME,
    )
    const masked = await overlaid.getMasked()
    expect(
      masked.entries.filter((row) => row.key.startsWith('services.dashboard.')),
    ).toEqual([
      {
        key: 'services.dashboard.baseUrl',
        value: CARD_URL_ORIGIN,
        source: 'default',
        masked: false,
      },
      {
        key: 'services.dashboard.workspace',
        value: CARD_URL_WORKSPACE_NAME,
        source: 'default',
        masked: false,
      },
    ])
  })

  it('lets an operator\'s own configured workspace win over the derived directory name', async () => {
    // The control for the half above, on the baseUrl half's own reasoning: the overlay FILLS AN
    // ABSENCE and never replaces a presence. A configured workspace is somebody naming the
    // workspace their hosted dashboard serves, and overwriting it with this machine's directory
    // name would point every card link at a workspace that host does not have.
    const configured = 'operator-named-workspace'
    const overlaid = overlayDashboardBaseUrl(
      {
        getMasked: async () => Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [{
            key: 'services.dashboard.workspace',
            value: configured,
            source: 'config-file' as const,
            masked: false,
          }],
        }),
      },
      () => CARD_URL_ORIGIN,
      CARD_URL_WORKSPACE_NAME,
    )
    const masked = await overlaid.getMasked()
    expect(
      masked.entries.filter((row) => row.key === 'services.dashboard.workspace'),
      'the operator\'s workspace must survive, exactly once',
    ).toEqual([{
      key: 'services.dashboard.workspace',
      value: configured,
      source: 'config-file',
      masked: false,
    }])
  })

  it('overlays the workspace half even while the origin factory is still empty', async () => {
    // INDEPENDENT SUPPLIERS. The origin is only known after `listen`, and a lone workspace is
    // INERT rather than wrong — the producer's both-halves AND refuses it. Gating the workspace
    // on the origin would be a second, invisible precondition on a value that has none.
    const overlaid = overlayDashboardBaseUrl(
      {
        getMasked: async () => Promise.resolve({
          schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
          configPath: 'agent-qa.config.yaml',
          entries: [],
        }),
      },
      () => undefined,
      CARD_URL_WORKSPACE_NAME,
    )
    const masked = await overlaid.getMasked()
    expect(masked.entries.map((row) => row.key)).toEqual(['services.dashboard.workspace'])
  })
})
