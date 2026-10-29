// THE ESCAPE CLASSES THE ONE-MASKED-SERIALIZATION FIX COULD NOT SEE.
//
// WHAT THIS FILE MEASURES, and why it did not exist before. `masked-result.ts` serialized the op
// output with `JSON.stringify` and then handed the SERIALIZED DOCUMENT to `maskText`. The declared
// mask (`SecretRedactor`) is a raw, exact replacement of each declared value with
// `[secret:<name>]`. `JSON.stringify` escapes `"` to
// `\"`, `\` to `\\`, and every C0 control character to `\n`/`\t`/`\uXXXX`. So for any registered
// credential containing one of those bytes, the raw value DOES NOT OCCUR in the document the
// masker scans, the masker matches nothing, and the credential reaches the caller verbatim.
//
// AND THE PHASE'S OWN FIX MADE IT WORSE, exactly as designed: because `structuredContent` is
// answered from the same masked bytes as `content`, an escape-blind miss leaks on BOTH channels
// rather than one. The module's stated property — "a value hidden from one cannot survive in the
// other" — held; what failed was that nothing was hidden from either.
//
// MEASURED TWICE BEFORE THIS FILE EXISTED. A code reviewer measured `raw value present in
// serialization? false` for `sk-live"abc\def`; the phase verifier then drove the real run
// masking-context masker (deleted 441-19) over six inputs and recorded four of five shapes leaking
// verbatim on both channels, including a `*_CREDENTIALS`-style JSON blob. This file is the
// standing corpus for that class.
//
// THE MASKER HERE IS A STAND-IN WITH THE SHIPPED REPLACEMENT. 2026-10-14: mcp
// depends on no package that exports `SecretRedactor`, which MCP receives injected, so
// `standInMask` replaces each declared plant raw and exactly, longest first, with
// `[secret:<name>]` — `SecretRedactor`'s replacement. The declaration arm end to end belongs to
// `packages/cli/src/__tests__/mcp-credential-surface.test.ts`.
//
// ASSERTED ON THE TWO WIRE FIELDS. `content[].text` and `structuredContent` are the fields the SDK
// puts on the transport; nothing here reads an internal object. Absence is WINDOWED at eight
// characters, the rule the credential-surface suite established: a cell that asks only whether the
// WHOLE value is present is satisfied by a partial mask, which is a disclosure budget nobody set.
//
// EVERY ABSENCE IS PAIRED WITH A CONTROL. (X0) proves the plants are declared and that a
// plain value IS masked, so a green absence cell is not a dead channel; (X8) drives an
// UNREGISTERED value down the same path and requires the helper to FIND it.

import type { CallToolResult } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'

import { maskedToolResult } from '../masked-result.js'
import { createEntityResourceReadHandler } from '../resources.js'
import { RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

/** Plain, alphanumeric — the shape every pre-existing credential plant in this repository has. */
const CLEAN_PLANT = 'qeb4t7zmv1x8s3d0g5j2n9'

/** Contains a DOUBLE QUOTE. `JSON.stringify` writes it `\"`, which the literal masker never sees. */
const QUOTE_PLANT = 'sk-live"hzp5r8u2i7o4a9'

/** Contains a BACKSLASH. Serialized as `\\`. */
const BACKSLASH_PLANT = 'sk-live\\wnk9j2p6r4y7c1'

/** Contains a CONTROL CHARACTER (newline + tab). Serialized as `\n` / `\t`. */
const CONTROL_PLANT = 'sk-live\ntealwood7412\tdelta'

/** A `*_CREDENTIALS`-shaped JSON blob — an entirely ordinary environment value. */
const BLOB_PLANT = '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----vqx3"}'

/** Registered by nobody. The hostile control's value (X8). */
const UNREGISTERED_PLANT = 'fjm2q8w5e1r7t3y9u4i6o0'

const ESCAPE_PLANTS: readonly (readonly [string, string])[] = [
  ['a double quote', QUOTE_PLANT],
  ['a backslash', BACKSLASH_PLANT],
  ['a control character', CONTROL_PLANT],
  ['a JSON-blob credential', BLOB_PLANT],
]

/**
 * The first eight-character window of `plant` that occurs in `haystack`, or `undefined`.
 *
 * WINDOWED, not whole-string, for the reason the credential-surface suite states: a mask that
 * disclosed a prefix, a suffix, or any run of eight characters would satisfy a whole-string check
 * and would still be a disclosure. (X8) requires this helper to find something, which is what
 * proves the cells that require `undefined` are capable of failing.
 */
function leakedWindow(haystack: string, plant: string, size = 8): string | undefined {
  for (let at = 0; at + size <= plant.length; at += 1) {
    const window = plant.slice(at, at + size)
    if (haystack.includes(window)) return window
  }
  return undefined
}

function standInMask(declared: readonly (readonly [string, string])[]): (text: string) => string {
  const longestFirst = [...declared].sort(([, a], [, b]) => b.length - a.length)
  return (text) => longestFirst.reduce(
    (out, [name, value]) => out.split(value).join(`[secret:${name}]`),
    text,
  )
}

/** The declared mask over every plant this file cares about except the control. */
function seededMasker(): { mask: (text: string) => string; dispose: () => void } {
  const mask = standInMask([
    ['CLEAN_441', CLEAN_PLANT],
    ['QUOTE_441', QUOTE_PLANT],
    ['BACKSLASH_441', BACKSLASH_PLANT],
    ['CONTROL_441', CONTROL_PLANT],
    ['BLOB_441', BLOB_PLANT],
  ])
  return { mask, dispose: () => undefined }
}

/**
 * The text a caller reads, read THROUGH the content union's discriminant rather than past it.
 *
 * A cast would erase the tag, so a result that answered an image where prose is expected would
 * compile and then fail with `undefined` in a diff naming the wrong thing.
 */
function renderedText(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** The op output shape a read tool answers with when it echoes something back to its caller. */
function receipt(value: string): unknown {
  return { kind: 'not-found', receipt: { echoed: value, note: 'nothing was found for it' } }
}

describe('X · the escape classes reach neither channel', () => {
  it('(X0) CONTROL: the masker holds every plant, and a plain value is masked on both channels',
    () => {
      const masker = seededMasker()
      try {
        // The seed half. Handed the RAW value, the masker recognises every plant — so a leak below
        // is the serialization's doing and not an undeclared value's.
        for (const [name, plant] of [['plain', CLEAN_PLANT] as const, ...ESCAPE_PLANTS]) {
          expect(masker.mask(plant), `the masker does not hold the ${name} plant`).not.toBe(plant)
        }

        const result = maskedToolResult(receipt(CLEAN_PLANT), masker.mask)

        // The integrity half: this really is the echoing success arm, not a withheld result.
        expect(result.isError ?? false, renderedText(result)).toBe(false)
        expect(leakedWindow(renderedText(result), CLEAN_PLANT)).toBeUndefined()
        expect(leakedWindow(JSON.stringify(result.structuredContent), CLEAN_PLANT)).toBeUndefined()
      } finally {
        masker.dispose()
      }
    })

  for (const [name, plant] of ESCAPE_PLANTS) {
    it(`(X1) a credential containing ${name} reaches NEITHER channel`, () => {
      const masker = seededMasker()
      try {
        const result = maskedToolResult(receipt(plant), masker.mask)

        // The integrity half first: the echo really happened, so the absence assertions below are
        // over a live channel. A path that stopped echoing would satisfy them for free.
        expect(result.isError ?? false, renderedText(result)).toBe(false)
        expect(renderedText(result)).toContain('nothing was found for it')

        expect(leakedWindow(renderedText(result), plant), `the text channel carried ${name}`)
          .toBeUndefined()
        expect(
          leakedWindow(JSON.stringify(result.structuredContent), plant),
          `structuredContent carried ${name} — the machine channel a person never reads`,
        ).toBeUndefined()
      } finally {
        masker.dispose()
      }
    })
  }

  it('(X2) the two channels are the same data — the invariant this module exists for', () => {
    const masker = seededMasker()
    try {
      const result = maskedToolResult(receipt(QUOTE_PLANT), masker.mask)

      expect(JSON.parse(renderedText(result))).toEqual(result.structuredContent)
    } finally {
      masker.dispose()
    }
  })

  it('(X3) an escape-class credential in an object KEY reaches neither channel either', () => {
    const masker = seededMasker()
    try {
      const result = maskedToolResult({ headers: { [QUOTE_PLANT]: 'x-client-auth' } }, masker.mask)

      expect(leakedWindow(renderedText(result), QUOTE_PLANT), 'a key carried the plant')
        .toBeUndefined()
      expect(leakedWindow(JSON.stringify(result.structuredContent), QUOTE_PLANT)).toBeUndefined()
    } finally {
      masker.dispose()
    }
  })

  it('(X4) the RESOURCE channel — the same shape at `resources.ts` — carries no escape class '
    + 'either', async () => {
    const masker = seededMasker()
    try {
      const read = createEntityResourceReadHandler({
        invoke: () => Promise.resolve({ shortId: 'MEM-001', capturedValue: BACKSLASH_PLANT }),
        maskText: masker.mask,
      })

      const result = await read(new URL('agentqa://memory/MEM-001'))
      const content = result.contents[0]
      if (content === undefined || !('text' in content)) {
        throw new Error('the resource answered no text content')
      }

      expect(content.text).toContain('MEM-001')
      expect(leakedWindow(content.text, BACKSLASH_PLANT), 'the resource text carried the plant')
        .toBeUndefined()
    } finally {
      masker.dispose()
    }
  })

  it('(X5) FAIL-CLOSED: a value that cannot be masked in place is WITHHELD, not served', () => {
    const masker = seededMasker()
    try {
      // A registered credential whose JSON spelling is a NUMBER. Masking it would replace a number
      // with a placeholder string, which is a different value — so the module refuses to answer at
      // all rather than serving the digits. (Before this fix the same input produced a masked
      // document that was no longer valid JSON, and the module withheld for that reason; the
      // posture is preserved, its cause is now named.)
      const pinMask = standInMask([['PIN_441', '867530912345']])
      const result = maskedToolResult({ pin: 867_530_912_345 }, pinMask)

      expect(result.isError).toBe(true)
      expect(renderedText(result)).toContain('withheld')
      expect(leakedWindow(renderedText(result), '867530912345')).toBeUndefined()
    } finally {
      masker.dispose()
    }
  })

  it('(X9) an own `__proto__` variable in a masked evidence document survives as a key, masked', () => {
    const masker = seededMasker()
    try {
      const records = JSON.parse(
        `{"__proto__":{"value":${JSON.stringify(`token=${QUOTE_PLANT}`)},"source":"capture"}}`,
      ) as Record<string, unknown>
      const output = {
        address: { runId: 'r_x9', testIndex: 0, stepIndex: 0, kind: 'variables' },
        outcome: 'ready',
        document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records },
      }
      const result = maskedToolResult(output, masker.mask)

      expect(result.isError ?? false, renderedText(result)).toBe(false)
      const masked = (result.structuredContent as { document: { records: Record<string, unknown> } })
        .document.records
      expect(Object.hasOwn(masked, '__proto__')).toBe(true)
      expect(Object.getPrototypeOf(masked)).toBe(Object.prototype)
      expect(Object.keys(JSON.parse(renderedText(result)).document.records)).toEqual(['__proto__'])
      expect(leakedWindow(renderedText(result), QUOTE_PLANT)).toBeUndefined()
      expect(renderedText(result)).toContain('token=')
    } finally {
      masker.dispose()
    }
  })

  it('(X8) HOSTILE CONTROL: an UNREGISTERED value travels the same path verbatim, and the helper '
    + 'finds it', () => {
    const masker = seededMasker()
    try {
      const result = maskedToolResult(receipt(UNREGISTERED_PLANT), masker.mask)

      // The whole point. If this cell did not find the value, every `toBeUndefined()` above would
      // be an assertion over a dead channel.
      expect(leakedWindow(renderedText(result), UNREGISTERED_PLANT), 'the channel is DEAD')
        .toBeDefined()
      expect(leakedWindow(JSON.stringify(result.structuredContent), UNREGISTERED_PLANT))
        .toBeDefined()
    } finally {
      masker.dispose()
    }
  })
})
