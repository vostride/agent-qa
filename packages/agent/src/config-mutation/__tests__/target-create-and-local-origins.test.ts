// Target creation class and local origins.
//
// WHAT EACH NAMED CELL REDS ON:
//
//   a create that accepts the class but drops it on the way into
//     the registry entry, a create that defaults an undeclared target to some class, or a create that
//     lets a second declaration overwrite an existing target. Read back from the bytes the direct
//     writer published (432-11: the create writes in the call), never from the input.
//   a gate that still needs a dot and an alphabetic TLD (every local spelling
//     refused), one that upgrades an explicit http to https or drops an explicit port, and one that
//     widens into guessing: non-loopback IPs, obfuscated loopback spellings and non-web schemes stay
//     refused. The write_test route and the scaffold op are measured too, because a derivation the
//     gate gets right can still be lost if a caller hands on only the host.

import { utf8Decode, utf8Encode } from '@vostride/agent-qa-schema'
import {
  ConfigProjectScaffoldInputSchema,
  ConfigTargetCreateInputSchema,
} from '@vostride/agent-qa-schema'
import type { ConfigChange, ConfigChangeOutput } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { Document as YamlDocument, isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml'

import { createConfigTarget, scaffoldConfigProject } from '../construct.js'
import type { ConstructConfigScaffoldDeps } from '../construct.js'
import { parseHostnameToken } from '../hostname-gate.js'
import type { ConfigPathFacts, ConfigStructuredValue } from '../ports.js'
import { resolveWriteTestRoute } from '../write-test-route.js'

const CONFIG_FILE = 'agent-qa.config.yaml'
const HOOKS_FILE = 'hooks.yaml'
const CREATE = 'config.target.create'

const CONFIG = `# agent-qa Configuration
registry:
  targets:
    # The one target this project already has.
    shop:
      platform: web
      url: https://shop.example.com/cart
      environment: shared
use:
  parallel: false
`

interface Harness {
  readonly deps: ConstructConfigScaffoldDeps
  /** The files as the direct writer left them. */
  readonly bytes: Map<string, Uint8Array | undefined>
  /** How many publications the direct writer received. */
  readonly writes: () => number
  readonly rendered: { targetName: string; baseUrl: string }[]
  readonly reads: () => number
}

/** The config transaction's field operations, applied to in-memory bytes with the real yaml calls. */
function applyChanges(input: Uint8Array | undefined, changes: readonly ConfigChange[]): Uint8Array {
  const document = input === undefined ? new YamlDocument({}) : parseDocument(utf8Decode(input))
  for (const change of changes) {
    const path = change.path as (string | number)[]
    if (change.op === 'set') document.setIn(path, document.createNode(change.value))
    if (change.op === 'append') {
      const existing = document.getIn(path, true)
      if (isSeq(existing)) existing.add(document.createNode(change.value))
      else document.setIn(path, document.createNode([change.value]))
    }
  }
  return utf8Encode(document.toString())
}

function harness(options: { readonly config?: string } = {}): Harness {
  const bytes = new Map<string, Uint8Array | undefined>([
    [CONFIG_FILE, options.config === undefined ? utf8Encode(CONFIG) : utf8Encode(options.config)],
    [HOOKS_FILE, undefined],
    ['.gitignore', utf8Encode('.agent-qa/\n')],
  ])
  const rendered: { targetName: string; baseUrl: string }[] = []
  let reads = 0
  let writes = 0
  const documentFor = (input?: Uint8Array): YamlDocument =>
    input === undefined ? new YamlDocument({}) : parseDocument(utf8Decode(input))

  return {
    bytes,
    writes: () => writes,
    rendered,
    reads: () => reads,
    deps: {
      configFiles: {
        read: () => {
          reads += 1
          return Promise.resolve({
            configFile: CONFIG_FILE,
            hooksFile: HOOKS_FILE,
            files: [...bytes].map(([path, content]) =>
              content === undefined ? { path } : { path, bytes: content }),
          })
        },
        inspect: ({ bytes: input, paths }) => {
          const document = documentFor(input)
          return Promise.resolve(paths.map((path): ConfigPathFacts => {
            const node = document.getIn(path.split('.'), true)
            if (node === undefined || node === null) return { path, present: false }
            if (isSeq(node)) return { path, present: true, kind: 'sequence', length: node.items.length }
            if (isMap(node)) {
              return {
                path,
                present: true,
                kind: 'map',
                keys: node.items.map((item) => String(isScalar(item.key) ? item.key.value : item.key)),
              }
            }
            return { path, present: true, kind: 'scalar' }
          }))
        },
        setField: ({ bytes: input, path, value }: {
          bytes?: Uint8Array
          path: string
          value: ConfigStructuredValue
        }) => {
          const document = documentFor(input)
          const segments = path.split('.')
          const previous = document.getIn(segments) as unknown
          document.setIn(segments, value)
          const mutated = utf8Encode(document.toString())
          return Promise.resolve(typeof previous === 'string'
            ? { bytes: mutated, previousValue: previous }
            : { bytes: mutated })
        },
        mintHookId: () => 'h_minted-by-the-port',
      },
      configValidate: { validate: () => Promise.resolve({ ok: true }) },
      configWrite: {
        applyFields: ({ changes }) => {
          writes += 1
          bytes.set(CONFIG_FILE, applyChanges(bytes.get(CONFIG_FILE), changes))
          return Promise.resolve({
            kind: 'applied' as const,
            file: CONFIG_FILE,
            revision: 'revision-after',
            baseRevision: 'revision-before',
          })
        },
        publishFiles: ({ files }) => {
          writes += 1
          for (const file of files) bytes.set(file.path, file.bytes)
          return Promise.resolve({ kind: 'published' as const, written: files.map((file) => file.path) })
        },
      },
      scaffoldContent: {
        render: (input) => {
          rendered.push({ targetName: input.targetName, baseUrl: input.baseUrl })
          return Promise.resolve([{
            path: CONFIG_FILE,
            bytes: utf8Encode(
              `registry:\n  targets:\n    ${input.targetName}:\n      platform: web\n`
              + `      url: ${input.baseUrl}\n`,
            ),
          }])
        },
      },
    },
  }
}

/** The target entry as the written config bytes carry it, parsed back rather than assumed. */
function writtenTarget(test: Harness, name: string): Record<string, unknown> {
  const parsed = parseYaml(utf8Decode(test.bytes.get(CONFIG_FILE) as Uint8Array)) as {
    registry?: { targets?: Record<string, Record<string, unknown>> }
  }
  const entry = parsed.registry?.targets?.[name]
  if (entry === undefined) throw new Error(`the written config carries no target ${name}`)
  return entry
}

async function create(
  test: Harness,
  input: Record<string, unknown>,
): Promise<ConfigChangeOutput> {
  const parsed = ConfigTargetCreateInputSchema.parse(input)
  return await createConfigTarget({ action: CREATE, ...parsed }, test.deps)
}

describe('a target declares its class at creation', () => {
  for (const environment of ['local', 'shared', 'production'] as const) {
    it(`${environment} is written into the new registry entry`, async () => {
      const test = harness()
      const answer = await create(test, {
        name: 'checkout',
        platform: 'web',
        url: 'https://checkout.example.com',
        environment,
      })

      expect(answer.outcome).toBe('applied')
      expect(writtenTarget(test, 'checkout')).toEqual({
        platform: 'web',
        url: 'https://checkout.example.com',
        environment,
      })
      // The existing target, and its own declaration, are untouched by the create.
      expect(writtenTarget(test, 'shop')).toEqual({
        platform: 'web',
        url: 'https://shop.example.com/cart',
        environment: 'shared',
      })
    })
  }

  it('an undeclared create stays undeclared — no class is defaulted', async () => {
    const test = harness()
    await create(test, { name: 'checkout', platform: 'web', url: 'https://checkout.example.com' })

    const entry = writtenTarget(test, 'checkout')
    expect(entry).toEqual({ platform: 'web', url: 'https://checkout.example.com' })
    expect(Object.hasOwn(entry, 'environment')).toBe(false)
  })

  it('a create never overwrites an existing target, whatever class it declares', async () => {
    const test = harness()
    const answer = await create(test, {
      name: 'shop',
      platform: 'web',
      url: 'https://elsewhere.example.com',
      environment: 'production',
    })

    expect(answer).toMatchObject({ outcome: 'refused', reason: 'target-exists', candidates: ['shop'] })
    expect(test.writes()).toBe(0)
    // A second attempt is refused the same way: nothing was written by the first.
    await expect(create(test, {
      name: 'shop',
      platform: 'web',
      url: 'https://shop.example.com/cart',
      environment: 'local',
    })).resolves.toMatchObject({ outcome: 'refused', reason: 'target-exists' })
    expect(test.writes()).toBe(0)
    expect(writtenTarget(test, 'shop')).toMatchObject({ environment: 'shared' })
  })

  it('the collision check is exact, so a Unicode label is its own name', async () => {
    const test = harness({
      config: 'registry:\n  targets:\n    strasse:\n      platform: web\n      url: https://a.example\n',
    })
    const answer = await create(test, {
      name: 'straße',
      platform: 'web',
      url: 'https://b.example',
      environment: 'local',
    })

    // No folding of ß onto ss, and the label reaches the entry exactly as typed. Whether the
    // registry's slug rule then accepts it is whole-config validation's call, measured in cli.
    expect(answer.outcome).toBe('applied')
    expect(writtenTarget(test, 'straße')).toMatchObject({ environment: 'local' })
    expect(writtenTarget(test, 'strasse')).toEqual({ platform: 'web', url: 'https://a.example' })
  })

  // RE-SPELLED 2026-10-02: was '… sits beside an auth binding …'. The create
  // binds no auth state now (the committed configuration has no key for one), so the file gains no
  // `use.authState` beside the class.
  it('the class is written and named in the summary line', async () => {
    const test = harness()
    const answer = await create(test, {
      name: 'checkout',
      platform: 'web',
      url: 'https://checkout.example.com',
      environment: 'production',
    })

    expect(answer.outcome === 'applied' && answer.summaryLine)
      .toBe('create web target checkout at https://checkout.example.com (production)')
    expect(writtenTarget(test, 'checkout')).toMatchObject({ environment: 'production' })
    const parsed = parseYaml(utf8Decode(test.bytes.get(CONFIG_FILE) as Uint8Array)) as {
      use?: { authState?: string }
    }
    expect(parsed.use?.authState).toBeUndefined()
    // An undeclared create keeps the summary line it always had.
    const plain = harness()
    const undeclared = await create(plain, { name: 'checkout', platform: 'web', url: 'https://checkout.example.com' })
    expect(undeclared.outcome === 'applied' && undeclared.summaryLine)
      .toBe('create web target checkout at https://checkout.example.com')
  })

  it('the input admits exactly the three classes, optionally', () => {
    const base = { name: 'checkout', platform: 'web', url: 'https://checkout.example.com' }
    for (const environment of ['local', 'shared', 'production']) {
      expect(ConfigTargetCreateInputSchema.safeParse({ ...base, environment }).success).toBe(true)
    }
    expect(ConfigTargetCreateInputSchema.safeParse(base).success).toBe(true)
    for (const environment of [null, '', 'Production', 'staging', 'prod', true]) {
      expect(
        ConfigTargetCreateInputSchema.safeParse({ ...base, environment }).success,
        `environment ${JSON.stringify(environment)}`,
      ).toBe(false)
    }
  })
})

/** Every local spelling, with the one derivation each must produce. */
const LOCAL_ORIGINS = [
  { token: 'localhost', domain: 'localhost', baseUrl: 'https://localhost', targetName: 'localhost' },
  { token: 'localhost:3000', domain: 'localhost', baseUrl: 'https://localhost:3000', targetName: 'localhost-3000' },
  { token: 'http://localhost:3000', domain: 'localhost', baseUrl: 'http://localhost:3000', targetName: 'localhost-3000' },
  { token: 'HTTP://LocalHost:5173/app?x=1', domain: 'localhost', baseUrl: 'http://localhost:5173', targetName: 'localhost-5173' },
  { token: 'http://127.0.0.1:8931/form.html', domain: '127.0.0.1', baseUrl: 'http://127.0.0.1:8931', targetName: 'ip-127-0-0-1-8931' },
  { token: '127.0.0.1', domain: '127.0.0.1', baseUrl: 'https://127.0.0.1', targetName: 'ip-127-0-0-1' },
  { token: '127.0.0.1:8080', domain: '127.0.0.1', baseUrl: 'https://127.0.0.1:8080', targetName: 'ip-127-0-0-1-8080' },
  { token: 'http://[::1]:3000/', domain: '[::1]', baseUrl: 'http://[::1]:3000', targetName: 'ipv6-loopback-3000' },
  { token: '[::1]', domain: '[::1]', baseUrl: 'https://[::1]', targetName: 'ipv6-loopback' },
  { token: 'https://[::1]:8443', domain: '[::1]', baseUrl: 'https://[::1]:8443', targetName: 'ipv6-loopback-8443' },
] as const

/** Plain hostnames keep the pinned default; an explicit scheme and port are kept exactly. */
const HOSTNAME_ORIGINS = [
  { token: 'booking.com', domain: 'booking.com', baseUrl: 'https://booking.com', targetName: 'booking-com' },
  { token: 'http://booking.com/rooms', domain: 'booking.com', baseUrl: 'http://booking.com', targetName: 'booking-com' },
  { token: 'https://booking.com:8443/', domain: 'booking.com', baseUrl: 'https://booking.com:8443', targetName: 'booking-com-8443' },
  { token: 'staging.example.com:9000', domain: 'staging.example.com', baseUrl: 'https://staging.example.com:9000', targetName: 'staging-example-com-9000' },
] as const

/** Refused: non-web schemes, non-loopback addresses, obfuscated loopback, and non-tokens. */
const STILL_REFUSED = [
  'ftp://localhost',
  'ws://127.0.0.1:3000',
  'file://localhost/etc/passwd',
  'javascript:alert(1)',
  'data:text/html,hi',
  '192.168.0.1',
  'http://10.0.0.1:3000',
  'http://[::2]:3000',
  'http://[fe80::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://127.1:3000',
  'http://2130706433/',
  'http://0x7f.0.0.1/',
  'http://127.000.000.001/',
  'localhost/app',
  'localhost:',
  'localhost:99999',
  'user@localhost:3000',
  '',
  '   ',
] as const

describe('the hostname gate admits local origins by parsing them', () => {
  it('localhost, IPv4 and bracketed IPv6 loopback keep their scheme and port', () => {
    for (const row of LOCAL_ORIGINS) {
      expect(parseHostnameToken(row.token), `token ${row.token}`).toEqual({
        kind: 'hostname',
        domain: row.domain,
        baseUrl: row.baseUrl,
        targetName: row.targetName,
      })
    }
  })

  it('a plain hostname defaults to https, and an explicit scheme or port is kept exactly', () => {
    for (const row of HOSTNAME_ORIGINS) {
      expect(parseHostnameToken(row.token), `token ${row.token}`).toEqual({
        kind: 'hostname',
        domain: row.domain,
        baseUrl: row.baseUrl,
        targetName: row.targetName,
      })
    }
  })

  it('non-web schemes, other addresses and rewritten loopback spellings stay refused', () => {
    for (const token of STILL_REFUSED) {
      expect(parseHostnameToken(token), `token ${JSON.stringify(token)}`).toEqual({ kind: 'not-a-hostname' })
    }
    // Null never reaches the gate: the op's input refuses it at the boundary.
    expect(ConfigProjectScaffoldInputSchema.safeParse({ domain: null }).success).toBe(false)
    expect(ConfigProjectScaffoldInputSchema.safeParse({ domain: '' }).success).toBe(false)
  })

  it('the scaffold op hands the content port the kept scheme and port', async () => {
    const test = harness({ config: 'workspace:\n  hooksFile: hooks.yaml\n' })
    const answer = await scaffoldConfigProject(
      { action: 'config.project.scaffold', domain: 'http://127.0.0.1:8931/form.html' },
      test.deps,
    )

    expect(answer.outcome).toBe('applied')
    expect(test.rendered).toEqual([{ targetName: 'ip-127-0-0-1-8931', baseUrl: 'http://127.0.0.1:8931' }])
    expect(answer.outcome === 'applied' && answer.summaryLine)
      .toBe('configure this project for http://127.0.0.1:8931 as target ip-127-0-0-1-8931')
  })

  it('a write_test route hands on a spelling that re-derives the same origin', () => {
    for (const [intent, token] of [
      ['write a test for http://localhost:3000 please', 'http://localhost:3000'],
      ['write a test for the form at http://[::1]:8931/form.html', 'http://[::1]:8931/form.html'],
      ['write a test for 127.0.0.1:8080', '127.0.0.1:8080'],
      ['write a test for booking.com', 'booking.com'],
    ] as const) {
      const route = resolveWriteTestRoute({ intent, configuredTargetNames: [] })
      const expected = parseHostnameToken(token)
      expect(expected.kind, token).toBe('hostname')
      expect(route.kind, intent).toBe('scaffold')
      if (expected.kind !== 'hostname' || route.kind !== 'scaffold') return
      expect(route.targetName, intent).toBe(expected.targetName)
      // The op re-parses what the route hands it, so the handed spelling must carry the origin.
      expect(parseHostnameToken(route.domain), intent).toEqual(expected)
    }
    // The plain-hostname hand-off is unchanged: the bare domain, as before.
    expect(resolveWriteTestRoute({ intent: 'write a test for booking.com', configuredTargetNames: [] }))
      .toEqual({ kind: 'scaffold', domain: 'booking.com', targetName: 'booking-com' })
  })

  it('a local origin whose derived name is configured routes to that target', () => {
    expect(resolveWriteTestRoute({
      intent: 'write a test for http://localhost:3000',
      configuredTargetNames: ['localhost-3000'],
    })).toEqual({ kind: 'configured', name: 'localhost-3000' })
    // A different port is a different origin, so it is not that target.
    expect(resolveWriteTestRoute({
      intent: 'write a test for http://localhost:5173',
      configuredTargetNames: ['localhost-3000'],
    })).toEqual({ kind: 'passthrough' })
  })
})
