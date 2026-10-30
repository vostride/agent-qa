import { describe, expect, expectTypeOf, it } from 'vitest'

import { VersionGuardError } from '../../versioning/create-version-guard'
import { BUNDLE_SCHEMA_VERSION } from '../bundle-files'
import {
  emitRecordMarkdown,
  parseRecordMarkdown,
  type RecordFrontmatter,
} from '../record-frontmatter'
import { renderEmbeddingInput, screenStateSnapshotRelPath } from '../embedding-input'

const frontmatter: RecordFrontmatter = {
  schemaVersion: BUNDLE_SCHEMA_VERSION,
  id: 'fact-el-cart-button-0123456789abcdef',
  kind: 'fact',
  subtype: 'selector',
  anchors: [
    {
      raw: { t: 'el', role: 'Button', name: 'Cart (7)', ordinal: 2 },
      normalized: { t: 'el', role: 'button', name: 'cart', ordinal: 2 },
    },
    {
      raw: { t: 'page', route: '/Checkout/#payment' },
      normalized: { t: 'page', route: '/checkout' },
    },
  ],
  scope: { tier: 'product', key: 'storefront' },
  createdAtOrdinal: 42,
  originClass: 'agent-verified',
  evidenceIncomplete: false,
}

const body = {
  summary: 'Cart button on checkout',
  body: 'Selecting the cart button opens the current order.',
}

function insertFrontmatterLine(markdown: string, line: string): string {
  return markdown.replace('\n---\n\n## Summary', `\n${line}\n---\n\n## Summary`)
}

describe('record.md deterministic frontmatter', () => {
  it('round-trips all immutable frontmatter fields and markdown body', () => {
    expect(parseRecordMarkdown(emitRecordMarkdown(frontmatter, body))).toEqual({
      frontmatter,
      ...body,
    })
  })

  it('emits byte-identically in the fixed planner-pinned key order', () => {
    const first = emitRecordMarkdown(frontmatter, body)
    const second = emitRecordMarkdown(frontmatter, body)

    expect(first).toBe(second)
    expect(first.split('\n').slice(1, 10).map((line) => line.slice(0, line.indexOf(': '))))
      .toEqual([
        'schemaVersion',
        'id',
        'kind',
        'subtype',
        'anchors',
        'scope',
        'createdAtOrdinal',
        'originClass',
        'evidenceIncomplete',
      ])
  })

  it('rejects unknown and missing frontmatter keys', () => {
    const emitted = emitRecordMarkdown(frontmatter, body)
    const missingId = emitted.replace(/^id: .*\n/m, '')

    expect(() => parseRecordMarkdown(insertFrontmatterLine(emitted, 'invented: true')))
      .toThrow('unknown frontmatter key "invented"')
    expect(() => parseRecordMarkdown(missingId)).toThrow('missing frontmatter key "id"')
  })

  it('rejects malformed JSON values with the offending key named', () => {
    const malformed = emitRecordMarkdown(frontmatter, body).replace(
      /^id: .*$/m,
      'id: {not-json}',
    )

    expect(() => parseRecordMarkdown(malformed)).toThrow('invalid JSON for frontmatter key "id"')
  })

  it.each(['trust', 'counters', 'status', 'validity'])(
    'rejects a derived %s key in frontmatter',
    (key) => {
      const smuggled = insertFrontmatterLine(
        emitRecordMarkdown(frontmatter, body),
        `${key}: {}`,
      )

      expect(() => parseRecordMarkdown(smuggled)).toThrow('may not carry the derived key')
      expect(() => parseRecordMarkdown(smuggled)).toThrow(key)
    },
  )

  it('rejects unsupported frontmatter schema versions through the shared guard', () => {
    const future = emitRecordMarkdown(frontmatter, body).replace(
      `schemaVersion: ${BUNDLE_SCHEMA_VERSION}`,
      `schemaVersion: ${BUNDLE_SCHEMA_VERSION + 1}`,
    )

    expect(() => parseRecordMarkdown(future)).toThrowError(VersionGuardError)
  })

  it('round-trips hostile newlines, colons, and unicode without adding frontmatter lines', () => {
    const hostileFrontmatter: RecordFrontmatter = {
      ...frontmatter,
      anchors: [{
        raw: { t: 'flow', name: 'Checkout:\n"日本語" 🛒' },
        normalized: { t: 'flow', name: 'checkout: "日本語" 🛒' },
      }],
      scope: { tier: 'suite', key: 'payments:\nprimary' },
    }
    const hostileBody = {
      summary: 'Summary:\n日本語 🛒',
      body: 'Detail: preserves\nmultiple lines and : separators.',
    }
    const emitted = emitRecordMarkdown(hostileFrontmatter, hostileBody)

    expect(parseRecordMarkdown(emitted)).toEqual({
      frontmatter: hostileFrontmatter,
      ...hostileBody,
    })
    expect(emitted.split('\n').filter((line) => line.startsWith('anchors: '))).toHaveLength(1)
  })

  it('keeps derived trust, counter, status, and validity fields outside the type', () => {
    expectTypeOf<RecordFrontmatter>().toMatchTypeOf<{
      schemaVersion: number
      id: string
      evidenceIncomplete: boolean
    }>()
  })
})

describe('embedding and snapshot renderings', () => {
  it('renders normalized anchors in input order with the provisional exact bytes', () => {
    expect(renderEmbeddingInput({
      summary: 'Sign in',
      body: 'Submits credentials.',
      anchors: [
        { t: 'el', role: ' Button ', name: ' Cart (7) ' },
        { t: 'page', route: '/Checkout/#payment' },
      ],
    })).toBe([
      'Sign in',
      '',
      'Submits credentials.',
      '',
      'anchor: el:button:cart',
      'anchor: page:/checkout',
    ].join('\n'))
  })

  it('places each pre-action screen state in its dedicated evidence document', () => {
    expect(screenStateSnapshotRelPath(3)).toBe('evidence/screenstates/step-3.json')
  })
})
