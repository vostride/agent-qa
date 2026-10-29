// JSON escaping hides raw secrets from a document masker, so values are masked before serializing.

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

/** Registered by nobody: the hostile control's value. */
const UNREGISTERED_PLANT = 'fjm2q8w5e1r7t3y9u4i6o0'

const ESCAPE_PLANTS: readonly (readonly [string, string])[] = [
  ['a double quote', QUOTE_PLANT],
  ['a backslash', BACKSLASH_PLANT],
  ['a control character', CONTROL_PLANT],
  ['a JSON-blob credential', BLOB_PLANT],
]

// Windowed, so a mask that discloses any eight-character run is still a leak.
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
      // A credential spelled as a number cannot be masked in place, so the module refuses.
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
