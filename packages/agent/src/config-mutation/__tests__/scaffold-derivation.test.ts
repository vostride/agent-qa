// The scaffold's derivation and its never-guess boundary.
//
// WHAT EACH CELL'S ACCEPTANCE BAR IS — the implementation it must RED on, never the suite it passes:
//
//   (G1) the derivation      — ANY implementation that is not the pinned rule, and the corpus is
//                              RANGED over five different domains through ONE producer so that a
//                              gate hard-coding `booking.com` fails four of them. A cell asserting
//                              one domain's answer passes under a constant function; this one
//                              cannot.
//   (G2) the rejection corpus— a gate that accepts anything with a dot in it. Every member is a
//                              NEAR MISS — a token that has a dot, or has legal labels, or is a
//                              parseable URL — so a rule that merely looks for a dot reds on nine
//                              of them. This is the corpus case the rule's own precondition
//                              rejects, which is what stops the positive cells from being drawn
//                              from inside the rule's assumption.
//   (G3) the URL arm         — a host extraction by regex. `https://example.com@evil.example/` is
//                              the case where "everything after // up to the first /" and "the
//                              authority's host" are different strings, and only one of them is
//                              the site.
//   (S1) the refusal         — a scaffold that guessed. It asserts the typed reason, that the
//                              detail names BOTH continuations, and — the half that matters — that
//                              the token itself is not echoed back as a candidate origin.
//   (S2) never reads         — a gate placed AFTER the re-read. The double throws if read, so a
//                              refusal that had already gone to the filesystem fails by name.
//   (S3) already-configured  — a scaffold that overwrote a DECLARED TARGET REGISTRY. Since 395-12
//                              the predicate is the registry rather than the file: the double
//                              answers a config that declares `shop` and the cell asserts NOTHING
//                              was written, and that the refusal names what it will not replace.
//  (S3b) the narrowing       — a predicate still keyed on the file EXISTING. The double answers a
//                              config file that declares NO targets, and the op must reach the
//                              content port in MERGE mode carrying the person's own bytes. Its
//                              two-sidedness is (S3) one cell up: same op, same fixture family,
//                              opposite verdict, and neither can be satisfied by a constant.
//   (S4) the port gets the   — an op that handed the raw token to the content port, or derived the
//        DERIVATION            target name a second time on the far side of the boundary. The
//                              double records what it was asked for.
//   (S5) crossBoundary       — a proposal that carried the flag as a constant. The value is read
//                              off `computeCrossBoundary`'s own output through the real pipeline,
//                              and the reasons are asserted by MEMBERSHIP so a classifier that
//                              started flagging everything for one reason still fails the pair.
//   (S6) one diff, three     — a scaffold that published file by file in separate calls. CFGM-05's
//        files                 sentence is ONE diff; since 432-11 it is one publication of all
//                              three files, and the cell counts the direct writer's calls.
//   (S7, S8) deleted 2026-10-14: their subject was the construction scan.
//   (S9) unrenderable        — 395-02's refusal escaping as a fault instead of being answered as
//                              data. The scaffold is the one op that folds bytes it did not author
//                              into a file it proposes, so it is the one that must answer it.
//
// THE CONTENT IS A DOUBLE HERE, AND THE REAL PRODUCER IS MEASURED IN `cli`. `packages/agent` may
// not import `packages/cli`, where D-04's one scaffold producer lives. So this file measures the
// PIPELINE — the gate, the refusals, the ordering, the classification, the single record — and
// `cli/src/composition/__tests__/config-scaffold.test.ts` byte-pins what the real producer emits,
// against committed goldens, for two different domains. Splitting them is the same call 395-04 and
// 395-07 recorded: a double that could answer the question under test would make the cell a
// statement about the double.

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
  // No dot at all — the case the phase's own utterance example produces.
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

/** What the content port was asked for — including 395-12's merge mode, when it is present. */
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
        // FAITHFUL SINCE 395-12, and it had to become so: the narrowed `already-configured`
        // predicate reads the DECLARED TARGET NAMES structurally, so a double that threw here
        // would be pinning the absence of the very read the fix is made of. It is the shipped
        // host's own `parseDocument` → `getIn` → `keys` answer — names, never values — spelled
        // over the same `yaml` API, which is a DEV dependency of this package: a test may parse
        // what this package's source may not.
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
    // A port is authority, not host — and since 432 D-20 (#134) an explicit port is kept on the
    // base URL rather than dropped, so the target addresses the origin that was typed.
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
    // AND NO GUESS. The token does not come back dressed as a candidate origin, which is the whole
    // of what D-15 forbids. The integrity half is above: the detail is asserted non-empty and to
    // carry two specific sentences, so this absence is not an absence over nothing.
    expect(answer.outcome === 'refused' && answer.detail).not.toContain('checkout')
    expect(test.published).toHaveLength(0)
  })

  it('(S2) refuses ABOVE the re-read — a guess costs the filesystem nothing', async () => {
    // The double throws on `read`. A gate placed after CFGM-04's re-read would surface that throw
    // instead of the typed refusal, so this cell is the ORDER stated as a measurement.
    const test = harness({ readThrows: true })
    await expect(scaffold(test, 'not_a_domain.x')).resolves.toMatchObject({
      reason: 'not-a-hostname',
    })
    expect(test.rendered).toHaveLength(0)
  })

  it('(S3) refuses a project that DECLARES targets, and writes nothing', async () => {
    // A DESIGNED FIXTURE BREAK. This fixture was `workspace:\n  hooksFile: …` — a config
    // file declaring no targets at all — so it measured "a config file exists". The predicate it
    // pins now is the narrowed one: a target registry this scaffold would replace.
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
      // THE OTHER SIDE OF (S3), and the cell that reds on the pre-395-12 predicate: a config FILE
      // exists, so the old rule refused — and refused precisely the class that can reach this op
      // through a chat turn, because a project's chat model lives in `registry.llms`, in this file.
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
    // 395-02's refusal, reached the only way this pipeline can reach it: bytes that differ and
    // decode identically. `0x80` and `0xFF` are both U+FFFD, so the diff of them renders as zero
    // hunks — a person would be shown a blank page. The scaffold is the op that folds a project's
    // OWN `.gitignore` into a file it proposes, which is why it is the one that must answer this.
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

    // The port is asked for exactly what `parseHostnameToken` produced. An op that handed over the
    // raw token — or that derived the name a second time on the far side — fails here, and the
    // failure is the one D-13 is about: two derivations that can disagree.
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
    // CFGM-05's sentence is ONE diff. Three files, one publication.
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
