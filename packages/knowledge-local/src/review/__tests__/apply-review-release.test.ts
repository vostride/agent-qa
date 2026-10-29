// 2026-10-03 (quick 261003-lgd, Phase 432 review WR-11): a change that landed is reported as
// landed, whatever the release after it meets.
//
// `applyExplicitReview` gives a lease it acquired back in a `finally`. A release that throws there
// (the lease guard stayed busy for its whole wait, or the guard's directory chain was refused)
// used to replace the applied result with that throw, so the caller saw a failure for a change
// that had been committed. The release failure is now a named warning, and the lease lapses by
// its heartbeat TTL. The throw is injected at the module boundary because a guard busy for its
// whole wait is a 12 s state that this cell does not need to rebuild (the lease cells drive it).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Anchor, ScopeKey } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const releaseControl = vi.hoisted(() => ({ throwOnRelease: false }))

vi.mock('../../lease/writer-lease.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lease/writer-lease.js')>()
  return {
    ...original,
    releaseLease: (...args: Parameters<typeof original.releaseLease>) => {
      if (releaseControl.throwOnRelease) {
        const busy = new Error('writer lease guard stayed held by pid 1 for 12000ms')
        busy.name = 'LeaseGuardBusyError'
        throw busy
      }
      return original.releaseLease(...args)
    },
  }
})

import { publishBundle, type BundleStoreConfig } from '../../bundle-publish.test-helper.js'
import { loadBundle } from '../../bundle-read.js'
import { enumerateBundleDirs } from '../../bundle-scan.js'
import { readWriterLease } from '../../lease/writer-lease.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import { applyExplicitReview } from '../apply-review.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }
const SCOPE: ScopeKey = { tier: 'product', key: 'release-storefront' }

describe('an applied explicit change survives a release that throws', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string
  let warnings: Array<{ code: string | undefined; message: string }>
  const onWarning = (warning: Error & { code?: string }): void => {
    warnings.push({ code: warning.code, message: warning.message })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-apply-release-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    scaffoldKnowledgeRoot(knowledgeRoot)
    warnings = []
    process.on('warning', onWarning)
  })

  afterEach(() => {
    releaseControl.throwOnRelease = false
    process.off('warning', onWarning)
    rmSync(root, { recursive: true, force: true })
  })

  function publish(summary: string): string {
    const config: BundleStoreConfig = {
      knowledgeRoot,
      productKey: 'Release Product',
    }
    const outcome = publishBundle(config, {
      draft: makeBundleDraftFixture({ kind: 'fact', anchors: [ANCHOR], scope: SCOPE, summary }),
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'Button', name: summary } },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: `release-${summary}`, testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  it('answers applied, names the deferred release in a warning, and leaves the change landed', async () => {
    const recordId = publish('accept me')
    releaseControl.throwOnRelease = true

    const result = await applyExplicitReview({
      agentQaRoot,
      knowledgeRoot,
      executionContext: 'local-interactive',
      operationId: '1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8',
      opId: 'knowledge.accept',
      request: { verb: 'accept', input: { target: { grain: 'record', recordId } } },
    }).catch((error: unknown) => ({ outcome: 'threw', name: (error as Error).name }))
    await new Promise((resolve) => setImmediate(resolve))

    expect(result).toMatchObject({ outcome: 'applied', verb: 'accept', recordIds: [recordId] })
    const landed = enumerateBundleDirs(knowledgeRoot)
      .map((entry) => loadBundle(entry.dir))
      .find((loaded) => loaded.kind === 'loaded' && loaded.bundle.manifest.id === recordId)
    expect(landed?.kind === 'loaded' ? landed.bundle.events : []).toContainEqual(
      expect.objectContaining({ type: 'confirmed', origin: 'user' }),
    )
    expect(warnings).toEqual([expect.objectContaining({ code: 'AGENT_QA_LEASE_RELEASE_DEFERRED' })])
    expect(warnings[0]!.message).toContain('LeaseGuardBusyError')
    // The lease was not given back, so it is still on disk and lapses by its TTL.
    expect(readWriterLease(knowledgeRoot).kind).toBe('parsed')
  })
})
