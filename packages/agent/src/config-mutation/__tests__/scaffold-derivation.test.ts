// Each domain goes through one producer, so a gate hard-coding one domain fails the rest.

import { isMap, isScalar, parseDocument } from 'yaml'

import { utf8Decode, utf8Encode } from '@vostride/agent-qa-schema'
import type { ConfigChangeOutput } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { scaffoldConfigProject } from '../construct.js'
import {
  HOSTNAME_GATE_REFUSAL_DETAIL,
  parseHostnameToken,
} from '../hostname-gate.js'
import type { ConstructConfigScaffoldDeps } from '../construct.js'

const CONFIG_FILE = 'agent-qa.config.yaml'
const ACTION = 'config.project.scaffold'

/**
 * The derivation corpus, RANGED. Five rows, one producer, and no two rows share a domain — so a
 * derivation that returned a constant, or one keyed on a particular site, reds on the rows it does
 * not happen to be about.
 */
const DERIVATIONS = [
  { token: 'booking.com', domain: 'booking.com', baseUrl: 'https://booking.com', targetName: 'booking-com' },
  { token: 'shop.example.co.uk', domain: 'shop.example.co.uk', baseUrl: 'https://shop.example.co.uk', targetName: 'shop-example-co-uk' },
  { token: 'BOOKING.DE', domain: 'booking.de', baseUrl: 'https://booking.de', targetName: 'booking-de' },
  { token: 'my-store.io', domain: 'my-store.io', baseUrl: 'https://my-store.io', targetName: 'my-store-io' },
  { token: 'https://booking.com/rooms?x=1', domain: 'booking.com', baseUrl: 'https://booking.com', targetName: 'booking-com' },
] as const

/**
 * The rejection corpus. Every member is a NEAR MISS the gate must refuse, and each one is here
 * because a plausible weaker rule would accept it.
 */
const REJECTED = [
  // No dot at all, as in a typical utterance.
  'checkout flow',
  'booking',
  // A dot, and an illegal label: `_` is not DNS label syntax. Accepted by "has a dot".
  'not_a_domain.x',
  // A dot and legal labels, and a TLD that is one character. Accepted by "has a dot and labels".
  'a.x',
  // A dot and legal labels, and a NUMERIC final label. A non-loopback IPv4 address is not a
  // hostname, and a gate that only checked label syntax would scaffold `https://192.168.0.1`. Only
  // loopback literals are admitted — see target-create-and-local-origins.test.ts.
  '192.168.0.1',
  // Leading and trailing hyphens — legal characters in the wrong position.
  '-lead.com',
  'trail-.com',
  // A fully-qualified name with the root dot. Refused rather than silently rewritten: what a
  // person typed is what gets configured.
  'example.com.',
  // A bare host with a path, no scheme. The path is not a label, and the gate does not invent a
  // boundary the person did not write.
  'booking.com/rooms',
  // Parseable URLs that are not sites this product can drive.
  'file:///etc/passwd',
  'javascript:alert(1)',
  // A sentence that contains a hostname. The gate parses a TOKEN, and this is not one.
  'write a test for booking.com please',
  '',
  '   ',
] as const

/** One publication the direct writer received: the files, by path, and what they carry. */
interface Published {
  readonly files: readonly { path: string; baseDigest?: string; text: string }[]
}

// What the content port was asked for, including merge mode when present.
interface RenderedCall {
  readonly targetName: string
  readonly baseUrl: string
  readonly existingGitignore?: string
  readonly existingConfig?: {
    readonly path: string
    readonly text: string
    readonly hooksPath: string
    readonly hooksPresent: boolean
  }
}

interface Harness {
  readonly published: Published[]
  readonly rendered: RenderedCall[]
  readonly deps: ConstructConfigScaffoldDeps
}

/**
 * The host doubles, with the REAL renderer behind them.
 *
 * `configFiles.read` ANSWERS AN EMPTY WORKSPACE BY DEFAULT — three enumerated members, none with
 * bytes — which is exactly what `enumerateConfigFileSet` answers for a project that has no config
 * file: the set is what the config NAMES, not what happens to exist. Measured against the shipped
 * function in `cli`'s composed cells rather than asserted here.
 */
function harness(options: {
  readonly configBytes?: string
  readonly gitignoreBytes?: Uint8Array
  readonly content?: (input: { targetName: string; baseUrl: string; existingGitignore?: Uint8Array }) =>
    readonly { path: string; bytes: Uint8Array }[]
  readonly readThrows?: boolean
  readonly validation?:
    | { ok: false; issues: readonly { path: string; message: string }[] }
    | { ok: true }
} = {}): Harness {
  const published: Published[] = []
  const rendered: RenderedCall[] = []

  const defaultContent = (input: { targetName: string; baseUrl: string }) => [
    {
      path: CONFIG_FILE,
      bytes: utf8Encode(
        `# agent-qa Configuration\nregistry:\n  targets:\n    ${input.targetName}:\n`
        + `      platform: web\n      url: ${input.baseUrl}\n`,
      ),
    },
    { path: 'hooks.yaml', bytes: utf8Encode('hooks:\n  - id: h_one\n') },
    { path: '.gitignore', bytes: utf8Encode('# agent-qa init:start\n.env\n# agent-qa init:end\n') },
  ]

  return {
    published,
    rendered,
    deps: {
      configFiles: {
        read: () => {
          if (options.readThrows === true) {
            throw new Error('the gate must refuse before anything is read')
          }
          return Promise.resolve({
            configFile: CONFIG_FILE,
            hooksFile: 'hooks.yaml',
            files: [
              { path: '.gitignore', ...(options.gitignoreBytes === undefined ? {} : { bytes: options.gitignoreBytes }) },
              { path: CONFIG_FILE, ...(options.configBytes === undefined ? {} : { bytes: utf8Encode(options.configBytes) }) },
              { path: 'hooks.yaml' },
            ],
          })
        },
        // Mirrors the host's `parseDocument`, `getIn` and `keys` answer: names, never values.
        inspect: ({ bytes, paths }) => {
          const document = parseDocument(bytes === undefined ? '' : utf8Decode(bytes))
          return Promise.resolve(paths.map((path) => {
            const node = document.getIn(path.split('.'), true)
            if (node === undefined || node === null) return { path, present: false }
            if (isMap(node)) {
              return {
                path,
                present: true,
                kind: 'map' as const,
                keys: node.items.map((item) =>
                  String(isScalar(item.key) ? item.key.value : item.key)),
              }
            }
            return { path, present: true, kind: 'scalar' as const }
          }))
        },
        mintHookId: () => {
          throw new Error('config.project.scaffold must not mint a hook id')
        },
        setField: () => {
          throw new Error('config.project.scaffold must not edit a document it is creating')
        },
      },
      configValidate: {
        validate: () => Promise.resolve(options.validation ?? { ok: true }),
      },
      configWrite: {
        applyFields: () => {
          throw new Error('config.project.scaffold publishes whole files, never field changes')
        },
        publishFiles: ({ files }) => {
          published.push({
            files: files.map((file) => ({
              path: file.path,
              ...(file.baseDigest === undefined ? {} : { baseDigest: file.baseDigest }),
              text: utf8Decode(file.bytes),
            })),
          })
          return Promise.resolve({ kind: 'published' as const, written: files.map((file) => file.path) })
        },
      },
      scaffoldContent: {
        render: (input) => {
          rendered.push({
            targetName: input.targetName,
            baseUrl: input.baseUrl,
            ...(input.existingGitignore === undefined
              ? {}
              : { existingGitignore: utf8Decode(input.existingGitignore) }),
            ...(input.existingConfig === undefined
              ? {}
              : {
                existingConfig: {
                  path: input.existingConfig.path,
                  text: utf8Decode(input.existingConfig.bytes),
                  hooksPath: input.existingConfig.hooksPath,
                  hooksPresent: input.existingConfig.hooksPresent,
                },
              }),
          })
          return Promise.resolve(
            (options.content ?? defaultContent)(input),
          )
        },
      },
    },
  }
}

async function scaffold(test: Harness, domain: string): Promise<ConfigChangeOutput> {
  return await scaffoldConfigProject({ action: ACTION, domain }, test.deps)
}

describe('the hostname gate is the never-guess boundary, as a parse', () => {
  it('(G1) derives the same rule for every domain — one producer, five different answers', () => {
    // PRODUCED, NOT LITERAL: each row's expectation is a derivation of its OWN token, and no two
    // rows share one. A gate returning a constant fails four; a gate keyed on `booking.com` fails
    // three. This is what makes the rule "deterministic code derives the target" rather than "the
    // suite knows about booking.com".
    for (const row of DERIVATIONS) {
      const verdict = parseHostnameToken(row.token)
      expect(verdict, `token ${row.token}`).toEqual({
        kind: 'hostname',
        domain: row.domain,
        baseUrl: row.baseUrl,
        targetName: row.targetName,
      })
    }
    // And the answers really are different from each other, so a producer that collapsed them all
    // onto one value could not pass by accident.
    expect(new Set(DERIVATIONS.map((row) => parseHostnameToken(row.token))
      .map((verdict) => verdict.kind === 'hostname' ? verdict.targetName : '')).size)
      .toBe(4)
  })

  it('(G2) refuses every near miss — the corpus the rule\'s own precondition rejects', () => {
    for (const token of REJECTED) {
      expect(parseHostnameToken(token), `token ${JSON.stringify(token)}`)
        .toEqual({ kind: 'not-a-hostname' })
    }
  })

  it('(G3) reads a URL\'s host through the parser, so userinfo cannot pose as the site', () => {
    // The one case where "everything between // and the first /" and "the authority's host" are
    // different strings. A regex extraction answers `example.com`; the site is `evil.example`.
    expect(parseHostnameToken('https://example.com@evil.example/rooms')).toEqual({
      kind: 'hostname',
      domain: 'evil.example',
      baseUrl: 'https://evil.example',
      targetName: 'evil-example',
    })
    // A port is authority, not host, and an explicit port stays on the base URL.
    expect(parseHostnameToken('https://booking.com:8443/')).toMatchObject({
      domain: 'booking.com',
      baseUrl: 'https://booking.com:8443',
    })
  })
})

describe('config.project.scaffold refuses rather than guessing', () => {
  it('(S1) answers a typed refusal naming both continuations, and echoes no origin', async () => {
    const test = harness({ readThrows: true })
    const answer = await scaffold(test, 'checkout flow')

    expect(answer).toEqual({
      outcome: 'refused',
      reason: 'not-a-hostname',
      detail: HOSTNAME_GATE_REFUSAL_DETAIL,
    })
    // BOTH continuations are named — a refusal that said only "that is not a URL" would leave a
    // person with a configured target list they were never told about.
    expect(answer.outcome === 'refused' && answer.detail).toContain('https://example.com')
    expect(answer.outcome === 'refused' && answer.detail).toContain('agent-qa.config.yaml')
    // No guess: the token does not come back as a candidate origin.
    expect(answer.outcome === 'refused' && answer.detail).not.toContain('checkout')
    expect(test.published).toHaveLength(0)
  })

  it('(S2) refuses ABOVE the re-read — a guess costs the filesystem nothing', async () => {
    // The double throws on `read`, so a gate placed after the re-read fails by name.
    const test = harness({ readThrows: true })
    await expect(scaffold(test, 'not_a_domain.x')).resolves.toMatchObject({
      reason: 'not-a-hostname',
    })
    expect(test.rendered).toHaveLength(0)
  })

  it('(S3) refuses a project that DECLARES targets, and writes nothing', async () => {
    // A config file with a target registry the scaffold would replace.
    const test = harness({
      configBytes:
        'workspace:\n  hooksFile: hooks.yaml\n'
        + 'registry:\n  targets:\n    shop:\n      platform: web\n      url: https://shop.test\n',
    })
    const answer = await scaffold(test, 'booking.com')

    expect(answer).toMatchObject({ outcome: 'refused', reason: 'already-configured' })
    // It names WHAT it will not replace — the declared targets, not merely the file — and the op
    // that does what the caller probably wanted.
    expect(answer.outcome === 'refused' && answer.detail).toContain('shop')
    expect(answer.outcome === 'refused' && answer.detail).toContain(CONFIG_FILE)
    expect(answer.outcome === 'refused' && answer.detail).toContain('config.target.create')
    expect(answer.outcome === 'refused' && answer.candidates).toEqual(['shop'])
    // NOTHING WAS RENDERED AND NOTHING WAS WRITTEN. The refusal is above the content port, so a
    // project with a target registry cannot have a replacement one built for it at all.
    expect(test.rendered).toHaveLength(0)
    expect(test.published).toHaveLength(0)
  })

  it('(S3b) MERGES a config file that declares no targets, carrying the person\'s own bytes',
    async () => {
      // A config file with no targets exists, and the scaffold merges into it instead of refusing.
      const configBytes = '# mine\nworkspace:\n  hooksFile: hooks.yaml\nregistry:\n  llms: []\n'
      const test = harness({ configBytes })
      const answer = await scaffold(test, 'booking.com')

      expect(answer.outcome).toBe('applied')
      // The content port was reached in MERGE mode, holding the committed bytes UNCHANGED and the
      // pinned set's own path vocabulary. A producer handed a path it re-derived could name a file
      // outside the set; a producer handed no bytes could only render a whole replacement.
      expect(test.rendered).toHaveLength(1)
      expect(test.rendered[0]?.existingConfig).toEqual({
        path: CONFIG_FILE,
        text: configBytes,
        hooksPath: 'hooks.yaml',
        // This fixture's hooks member has no bytes, so the scaffold still adds one.
        hooksPresent: false,
      })
      expect(test.published).toHaveLength(1)
      // The person's config is published over the digest of the bytes the call read.
      const config = test.published[0]?.files.find((file) => file.path === CONFIG_FILE)
      expect(config?.baseDigest).toMatch(/^[0-9a-f]{64}$/)
    })

  it('(S9) answers UNRENDERABLE as data rather than letting it escape as a fault', async () => {
    // `0x80` and `0xFF` both decode to U+FFFD, so their diff renders as zero hunks.
    const test = harness({
      gitignoreBytes: Uint8Array.from([0x80]),
      content: () => [{ path: '.gitignore', bytes: Uint8Array.from([0xff]) }],
    })
    const answer = await scaffold(test, 'booking.com')

    expect(answer).toMatchObject({ outcome: 'refused', reason: 'unrenderable-diff' })
    expect(test.published).toHaveLength(0)
  })
})

describe('the scaffold is one diff, published whole, over the whole set', () => {
  it('(S4) hands the content port the GATE\'S derivation and nothing else', async () => {
    const test = harness()
    await scaffold(test, 'HTTPS://Booking.com/rooms')

    // The port gets exactly what `parseHostnameToken` produced, so no second derivation exists.
    expect(test.rendered).toEqual([{ targetName: 'booking-com', baseUrl: 'https://booking.com' }])
  })

  it('(S4b) hands over the project\'s EXISTING gitignore bytes so the block is an upsert', async () => {
    const test = harness({ gitignoreBytes: utf8Encode('dist/\n') })
    await scaffold(test, 'booking.com')

    expect(test.rendered[0]?.existingGitignore).toBe('dist/\n')
  })

  it('(S5/S6) publishes ONE change, applied, cross-boundary with computed reasons', async () => {
    const test = harness()
    const answer = await scaffold(test, 'booking.com')

    expect(answer.outcome).toBe('applied')
    // One diff, three files, one publication.
    expect(test.published).toHaveLength(1)
    expect(test.published[0]?.files.map((file) => file.path))
      .toEqual(['.gitignore', CONFIG_FILE, 'hooks.yaml'])
    expect(answer.outcome === 'applied' && [...answer.files].sort())
      .toEqual(['.gitignore', CONFIG_FILE, 'hooks.yaml'])

    // THE FLAG IS READ OFF THE CLASSIFIER, not set by this op. `new-origin` because the scaffold
    // writes a base URL where the committed configuration had none, and `hook-added` because the
    // scaffolded hooks file declares a hook this project would then run. Asserted by MEMBERSHIP so
    // a classifier that started flagging everything for one reason still fails the pair.
    expect(answer.outcome === 'applied' && answer.crossBoundary).toBe(true)
    const reasons = answer.outcome === 'applied' ? answer.crossBoundaryReasons : []
    expect(reasons).toContain('new-origin')
    expect(reasons).toContain('hook-added')
  })
})
