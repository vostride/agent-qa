// Whatever a leftover ledger holds, a direct change commits as with no file and leaves it as is.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Anchor, ScopeKey } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { publishBundle } from '../../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import * as knowledgeLocal from '../../index.js'
import { applyExplicitReview } from '../../review/apply-review.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }
const SCOPE: ScopeKey = { tier: 'product', key: 'grant-reader-retired' }

/** What a merge leaves behind when two branches both appended: a marker fused onto a real line. */
const CONFLICT_MARKER = '<<<<<<< HEAD'

const GRANT_LINE =
  '{"schemaVersion":1,"kind":"grant","at":"2026-08-08T10:00:00.000Z","grantId":"grant_apply_damage_case","actionClass":"fn:knowledge.forget","scope":{"project":"local-workspace"}}'
const REVOKE_LINE =
  '{"schemaVersion":1,"kind":"revoke","at":"2026-08-08T11:00:00.000Z","grantId":"grant_apply_damage_case"}'

/** The three ledger states the deleted reader distinguished, as the bytes earlier builds left. */
const LEDGER_STATES = {
  'CASE 1 — intact ledger, active grant': `${GRANT_LINE}\n`,
  'CASE 2 — intact ledger, the revoke folded': `${GRANT_LINE}\n${REVOKE_LINE}\n`,
  'CASE 3 — the revoke line damaged in place': `${GRANT_LINE}\n${CONFLICT_MARKER}${REVOKE_LINE}\n`,
} as const

describe('a legacy grant ledger authorizes nothing, in any state, because nothing reads it', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grant-reader-retired-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    scaffoldKnowledgeRoot(knowledgeRoot)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function publish(summary: string): string {
    const outcome = publishBundle(
      { knowledgeRoot, productKey: 'Grant Reader Product' },
      {
        draft: makeBundleDraftFixture({ kind: 'fact', anchors: [ANCHOR], scope: SCOPE, summary }),
        discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'Button', name: summary } },
        originClass: 'agent-verified',
        createdAtOrdinal: 10,
        screenStates: [makeScreenStateFixture()],
        initialEvents: [],
        relations: [],
        provenance: { mode: 'run-linked', runId: `grant-reader-${summary}`, testId: 't', stepIndex: 0 },
        artifacts: [],
      },
    )
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  async function forget(recordId: string, operationId: string) {
    return await applyExplicitReview({
      agentQaRoot, knowledgeRoot, executionContext: 'local-headless', opId: 'knowledge.forget', operationId,
      request: { verb: 'forget', input: { target: { grain: 'record', recordId } } },
    })
  }

  it('the control: with no ledger file at all, the headless change commits', async () => {
    const recordId = publish('no-ledger')
    expect(await forget(recordId, 'grant-reader-none-1')).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
  })

  for (const [name, bytes] of Object.entries(LEDGER_STATES)) {
    it(`${name}: the headless change commits exactly as with no file, and the file is untouched`, async () => {
      const ledger = join(knowledgeRoot, 'grants.jsonl')
      writeFileSync(ledger, bytes, 'utf8')
      const recordId = publish(name.slice(0, 6).replace(/\W/g, ''))

      expect(await forget(recordId, `grant-reader-${name.slice(5, 6)}-1`))
        .toMatchObject({ outcome: 'applied', recordIds: [recordId] })
      expect(readFileSync(ledger, 'utf8')).toBe(bytes)
    }, 60_000)
  }

  it('no standing-approval reader is exported to consult it', () => {
    const exported = Object.keys(knowledgeLocal)
    expect(exported).not.toContain('createStandingApprovalReader')
    expect(exported.filter((name) => /approval|grant/i.test(name))).toEqual([])
  })
})
