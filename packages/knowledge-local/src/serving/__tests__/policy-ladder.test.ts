import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readPolicyLadder } from '../policy-ladder.js'
import { materializePolicy } from '../../policy/materialize.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'

const INIT_GLOBAL_POLICY_SCAFFOLD = `<!--
agent-qa policies — global scope

Write one rule per line, in plain imperative English. Every active (non-comment)
line in this file becomes a QA rule the agent follows.

Example (inactive — it lives inside this comment):
Always dismiss the cookie banner before asserting page content

Scoping: this file is the global scope. Add sibling files named <product>.md
next to it for product-scoped rules.

Sovereignty: policies are human-asserted and win every conflict. Once policy
serving lands, every active line here is served to the agent verbatim on every
run — never summarized, never budgeted out — so keep rules few and deliberate.

HTML comments are stripped at serve time: a comment-only file like this one is
an empty policy. Add rules below this comment block to activate them.
-->
`

const ACTIVE_POLICY = `Never submit real payment or checkout forms on automationexercise.com.
Dismiss cookie or consent dialogs before interacting with page content.
`

describe('authored policy ladder', () => {
  let knowledgeRoot: string

  beforeEach(() => {
    knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-policy-ladder-'))
  })

  afterEach(() => {
    rmSync(knowledgeRoot, { recursive: true, force: true })
  })

  function writePolicy(relativePath: string, text: string): string {
    const file = join(knowledgeRoot, relativePath)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
    return file
  }

  it('materialized fenced policy round-trips through the actual ladder', () => {
    const writerAuthority = acquireWriterLease(knowledgeRoot)
    if (writerAuthority.kind !== 'acquired') throw new Error('lease unavailable')
    materializePolicy({ knowledgeRoot, recordId: 'policy-roundtrip', scope: 'Shop Product',
      title: 'Checkout safety', ruleText: 'Never submit real payment forms.', writerAuthority })
    const ladder = readPolicyLadder(knowledgeRoot, 'Shop Product')
    expect(ladder.text).toContain('Never submit real payment forms.')
    expect(ladder.text).toContain('Checkout safety')
    expect(ladder.text).not.toContain('<!--')
    expect(ladder.files).toHaveLength(1)
  })

  it('treats the exact init scaffold as an empty policy rung', () => {
    writePolicy('policies/global.md', INIT_GLOBAL_POLICY_SCAFFOLD)

    expect(readPolicyLadder(knowledgeRoot)).toEqual({
      text: '',
      files: [],
      oversized: [],
    })
  })

  it('preserves the two active authored policy lines byte-for-byte', () => {
    writePolicy(
      'policies/global.md',
      `${INIT_GLOBAL_POLICY_SCAFFOLD}${ACTIVE_POLICY}`,
    )

    const result = readPolicyLadder(knowledgeRoot)

    expect(result.text).toBe(`\n${ACTIVE_POLICY}`)
    expect(Buffer.from(result.text.slice(1))).toEqual(Buffer.from(ACTIVE_POLICY))
    expect(result.files).toEqual(['policies/global.md'])
  })

  it('preserves active bytes before, between, and after multiline comments', () => {
    const authored = [
      'before  \r\n',
      '<!-- first\r\nmultiline comment -->',
      '\r\nbetween\t',
      '<!-- second\ncomment -->',
      'after →\n',
    ].join('')
    const expected = 'before  \r\n\r\nbetween\tafter →\n'
    writePolicy('policies/global.md', authored)

    const result = readPolicyLadder(knowledgeRoot)

    expect(result.text).toBe(expected)
    expect(Buffer.from(result.text)).toEqual(Buffer.from(expected))
  })

  it('removes adjacent comments while retaining their non-comment separator', () => {
    writePolicy(
      'policies/global.md',
      'left<!-- first --><!-- second -->\r\nright',
    )

    expect(readPolicyLadder(knowledgeRoot).text).toBe('left\r\nright')
  })

  it.each([
    {
      name: 'a nested opener',
      text: 'safe\n<!-- outer\n<!-- secret-policy-body -->\n-->',
      reason: 'nested-opener',
      line: 3,
      column: 1,
    },
    {
      name: 'a closer without an opener',
      text: 'safe\n--> secret-policy-body',
      reason: 'stray-closer',
      line: 2,
      column: 1,
    },
    {
      name: 'an unclosed comment',
      text: 'safe\n<!-- secret-policy-body',
      reason: 'unclosed-comment',
      line: 2,
      column: 1,
    },
  ])('rejects $name without disclosing policy contents', ({
    text,
    reason,
    line,
    column,
  }) => {
    writePolicy('policies/global.md', text)

    let thrown: unknown
    try {
      readPolicyLadder(knowledgeRoot)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).toMatchObject({
      name: 'MalformedPolicyCommentError',
      sourceFile: 'policies/global.md',
      reason,
      line,
      column,
    })
    expect((thrown as Error).message).toBe(
      `Malformed HTML comment in policies/global.md at ${line}:${column} (${reason})`,
    )
    expect((thrown as Error).message).not.toContain('secret-policy-body')
  })

  it('serves comment-bearing global then product policy deterministically', () => {
    const globalText = 'Always preserve CRLF.\r\nKeep trailing spaces.  '
    const productText = 'Product rule → preserve UTF-8\nSecond rule'
    writePolicy(
      'policies/global.md',
      `${globalText}<!-- global reviewer note -->`,
    )
    writePolicy(
      'policies/acme.md',
      `<!-- product reviewer note -->${productText}`,
    )

    const first = readPolicyLadder(knowledgeRoot, 'acme')
    const second = readPolicyLadder(knowledgeRoot, 'acme')
    const expected = [
      globalText,
      '\n--- POLICY SOURCE: policies/acme.md ---\n',
      productText,
    ].join('')

    expect(Buffer.from(first.text)).toEqual(Buffer.from(expected))
    expect(Buffer.from(second.text)).toEqual(Buffer.from(first.text))
    expect(second).toEqual(first)
    expect(first.files).toEqual(['policies/global.md', 'policies/acme.md'])
  })

  it('silently omits missing policy rungs', () => {
    const globalText = 'Global rule only\n'
    writePolicy('policies/global.md', globalText)

    expect(readPolicyLadder(knowledgeRoot, 'missing')).toEqual({
      text: globalText,
      files: ['policies/global.md'],
      oversized: [],
    })

    rmSync(join(knowledgeRoot, 'policies', 'global.md'))
    expect(readPolicyLadder(knowledgeRoot, 'missing')).toEqual({
      text: '',
      files: [],
      oversized: [],
    })
  })

  it('returns an oversized policy whole and reports its approximate token count', () => {
    const oversizedText = `Never truncate this rule: ${'x'.repeat(100_000)}\n`
    writePolicy('policies/global.md', oversizedText)

    const result = readPolicyLadder(knowledgeRoot)

    expect(result.text).toBe(oversizedText)
    expect(result.text.length).toBe(oversizedText.length)
    expect(result.oversized).toEqual([
      {
        file: 'policies/global.md',
        approxTokens: Math.ceil(oversizedText.length / 4),
      },
    ])
  })

  it('returns byte-identical output for an unchanged ladder', () => {
    writePolicy('policies/global.md', 'Global\n')
    writePolicy('policies/acme.md', 'Acme\n')

    expect(readPolicyLadder(knowledgeRoot, 'acme')).toEqual(
      readPolicyLadder(knowledgeRoot, 'acme'),
    )
  })

  it('keeps product lookup within the policies directory', () => {
    writePolicy('outside.md', 'must not serve')

    expect(readPolicyLadder(knowledgeRoot, '../outside')).toEqual({
      text: '',
      files: [],
      oversized: [],
    })
  })
})
