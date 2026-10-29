// The recorded modality reaches the boundary exactly, offline and with no device.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LeafReplayResult } from '@vostride/agent-qa-eval'
import { afterEach, describe, expect, it } from 'vitest'

import { runCassetteReplay } from '../replay-composition.js'
import {
  actionGenerateResult,
  capturingStub,
  extractStoreLoad,
  imagePartBytes,
  imageParts,
  makeReplayHandoff,
  memArtifacts,
  noneAuth,
  readBundleBlob,
  REPLAY_FIXTURE_BLOB_SHA,
  stubProfile,
} from './fixtures/replay-fixtures.js'

describe('runCassetteReplay across modalities, offline and on mobile', () => {
  const tempRoots: string[] = []

  async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix))
    tempRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reproduces a text-only cassette with ZERO image content parts at the boundary', async () => {
    const bundle = extractStoreLoad(
      makeReplayHandoff({ vision: false }),
      memArtifacts(),
      await tempRoot('replay-m-text-'),
    )
    const stub = capturingStub(() => actionGenerateResult('web'))

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect((outcome as LeafReplayResult).samples[0]!.outcome.kind).toBe('decision')

    // Over EVERY message's content parts, not just the pinned observation.
    expect(stub.captured).toHaveLength(1)
    expect(imageParts(stub.captured[0]!)).toHaveLength(0)
  })

  it('reproduces the vision leg byte-exactly: one image part whose bytes equal the bundle blob', async () => {
    const bundle = extractStoreLoad(
      makeReplayHandoff({ vision: true }),
      memArtifacts(),
      await tempRoot('replay-m-vision-'),
    )
    const stub = capturingStub(() => actionGenerateResult('web'))

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect((outcome as LeafReplayResult).samples[0]!.outcome.kind).toBe('decision')

    const parts = imageParts(stub.captured[0]!)
    expect(parts).toHaveLength(1)
    // Byte-exact reproduction from the on-disk blob leg (blobs/<sha>).
    const expected = readBundleBlob(bundle.dir, REPLAY_FIXTURE_BLOB_SHA)
    expect(imagePartBytes(parts[0]!)).toEqual(expected)
  })

  it('replays a mobile (android) cassette to a decision with the android tool slice and no device', async () => {
    const bundle = extractStoreLoad(
      makeReplayHandoff({ platform: 'android' }),
      memArtifacts(),
      await tempRoot('replay-m-android-'),
    )
    const stub = capturingStub(() => actionGenerateResult('android'))

    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    const sample = (outcome as LeafReplayResult).samples[0]!
    expect(sample.outcome.kind).toBe('decision')
    if (sample.outcome.kind !== 'decision') throw new Error('expected a decision sample')
    // The recorded tap grounds against the recorded element — replay never acts, no device built.
    expect(sample.outcome.identity.opClass).toBe('tap')
    expect(sample.outcome.identity.target?.nameNormalized).toBe('continue')

    // The android action-tool slice is present at the provider boundary.
    const serialized = JSON.stringify(stub.captured[0])
    expect(serialized).toContain('mobile_tap')
    expect(serialized).toContain('android_')
    expect(serialized).not.toContain('web_click')
  })

  it('runs fully offline: an unreachable baseURL, the stub serves every call, zero network I/O', async () => {
    const bundle = extractStoreLoad(
      makeReplayHandoff(),
      memArtifacts(),
      await tempRoot('replay-m-offline-'),
    )
    const stub = capturingStub(() => actionGenerateResult('web'))

    // An unreachable localhost:1 baseURL: if any call escaped the injected stub to a real transport,
    // it would ECONNREFUSED — the suite passing proves the harness has no network path besides the
    // injected model handle.
    const outcome = await runCassetteReplay({
      mask: (text: string) => text,
      cassette: bundle.cassette,
      artifacts: bundle.artifacts,
      profile: stubProfile('http://localhost:1/v1'),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
    })

    if (!('granularity' in outcome)) throw new Error('expected a replay result, got a refusal')
    expect((outcome as LeafReplayResult).samples[0]!.outcome.kind).toBe('decision')
    expect(stub.captured).toHaveLength(1)
  })
})
