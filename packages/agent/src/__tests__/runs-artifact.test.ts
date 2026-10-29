// Only this layer measures the refusals by name, the content sniff and the sha input contract.

import type { EvidenceBlobLookup, RunId } from '@vostride/agent-qa-schema'
import { RunsArtifactInputSchema } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  EvidenceBlobAbsentError,
  RUNS_ARTIFACT_FUNCTION_ID,
  runsArtifactSpec,
  sniffEvidenceContentType,
} from '../functions/ops/runs-artifact.js'
import type { FunctionDeps } from '../functions/spec.js'

const RUN_ID = 'run-alpha' as RunId
/** A 64-char LOWERCASE hex string — the only sha shape this contract admits. */
const SHA = 'a'.repeat(63) + '7'

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const ARBITRARY = new Uint8Array([0x01, 0x02, 0x03, 0x04])

/** The only dep this op reads. Everything else on `FunctionDeps` is unreachable from here. */
function depsWith(
  read: ((runId: RunId, sha: string) => Promise<EvidenceBlobLookup>) | undefined,
): FunctionDeps {
  return (read === undefined ? {} : { evidenceBlobs: { read } }) as unknown as FunctionDeps
}

function answering(lookup: EvidenceBlobLookup): FunctionDeps {
  return depsWith(() => Promise.resolve(lookup))
}

function bytesOf(base64: string): Uint8Array {
  // The DECODER is the test's, deliberately: the op encodes without `Buffer` (this package is
  // storageNeutral and hand-rolls its base64), so decoding here with the platform's own reader is
  // what makes the round trip a claim about the encoder rather than about a shared helper.
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

describe('the op refuses BY NAME rather than answering about bytes it cannot see', () => {
  it('throws FunctionNotBoundError when the composition binds no evidenceBlobs port', async () => {
    // Read STRUCTURALLY off `name`, exactly as the dashboard route classifies it — this package's
    // consumers may not import the error class, so the name IS the contract.
    await expect(runsArtifactSpec.invoke({ runId: RUN_ID, sha: SHA }, depsWith(undefined)))
      .rejects.toMatchObject({ name: 'FunctionNotBoundError' })
    // And it names the capability, so an operator learns WHICH op this host does not bind.
    await expect(runsArtifactSpec.invoke({ runId: RUN_ID, sha: SHA }, depsWith(undefined)))
      .rejects.toThrow(RUNS_ARTIFACT_FUNCTION_ID)
  })

  it('turns unknown_run into RunNotFoundError — reusing runs.get\'s word, not a second one', async () => {
    await expect(runsArtifactSpec.invoke({ runId: RUN_ID, sha: SHA }, answering({ status: 'unknown_run' })))
      .rejects.toMatchObject({ name: 'RunNotFoundError' })
  })

  it('turns blob_absent into EvidenceBlobAbsentError carrying the run and the sha', async () => {
    // Differs from `unknown_run`: a missing run and a run without the blob are different cases.
    const rejection = await runsArtifactSpec
      .invoke({ runId: RUN_ID, sha: SHA }, answering({ status: 'blob_absent' }))
      .then(() => undefined, (error: unknown) => error)
    expect(rejection).toBeInstanceOf(EvidenceBlobAbsentError)
    expect(rejection).toMatchObject({ name: 'EvidenceBlobAbsentError', runId: RUN_ID, sha: SHA })
  })

  it('reads the port with the run id and sha it was given, and nothing else', async () => {
    const seen: Array<readonly [RunId, string]> = []
    await runsArtifactSpec.invoke({ runId: RUN_ID, sha: SHA }, depsWith((runId, sha) => {
      seen.push([runId, sha])
      return Promise.resolve({ status: 'found', bytes: PNG_MAGIC })
    }))
    expect(seen).toEqual([[RUN_ID, SHA]])
  })
})

describe('found bytes travel whole, under a content type sniffed from their own head', () => {
  it('answers PNG magic as image/png with the bytes round-tripping through base64', async () => {
    const result = await runsArtifactSpec.invoke(
      { runId: RUN_ID, sha: SHA },
      answering({ status: 'found', bytes: PNG_MAGIC }),
    )
    expect(result.runId).toBe(RUN_ID)
    expect(result.sha).toBe(SHA)
    expect(result.contentType).toBe('image/png')
    expect(result.byteLength).toBe(PNG_MAGIC.length)
    expect(bytesOf(result.bytesBase64)).toEqual(PNG_MAGIC)
  })

  it('answers JPEG magic as image/jpeg', async () => {
    const result = await runsArtifactSpec.invoke(
      { runId: RUN_ID, sha: SHA },
      answering({ status: 'found', bytes: JPEG_MAGIC }),
    )
    expect(result.contentType).toBe('image/jpeg')
    expect(bytesOf(result.bytesBase64)).toEqual(JPEG_MAGIC)
  })

  it('answers anything else as application/octet-stream — never a type a browser executes', async () => {
    const result = await runsArtifactSpec.invoke(
      { runId: RUN_ID, sha: SHA },
      answering({ status: 'found', bytes: ARBITRARY }),
    )
    expect(result.contentType).toBe('application/octet-stream')
    expect(bytesOf(result.bytesBase64)).toEqual(ARBITRARY)
  })

  it('round-trips every byte value, at every padding remainder (the encoder has no host helper)', async () => {
    const all = new Uint8Array(256)
    for (let i = 0; i < 256; i += 1) all[i] = i
    for (const length of [0, 1, 2, 3, 4, 5, 255, 256]) {
      const slice = all.slice(0, length)
      const result = await runsArtifactSpec.invoke(
        { runId: RUN_ID, sha: SHA },
        answering({ status: 'found', bytes: slice }),
      )
      expect(result.byteLength, `length ${String(length)}`).toBe(length)
      expect(bytesOf(result.bytesBase64), `length ${String(length)}`).toEqual(slice)
    }
  })
})

describe('sniffEvidenceContentType — a total function of the first bytes', () => {
  it('never answers a type a browser will execute, whatever the bytes say they are', () => {
    // The XSS leg stated as a table: an SVG document and an HTML document both sniff to the
    // opaque default, because a served blob that a browser renders as markup is a script the
    // uploader wrote. There is no arm of this function that can answer `image/svg+xml`.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
    const html = new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>')
    expect(sniffEvidenceContentType(svg)).toBe('application/octet-stream')
    expect(sniffEvidenceContentType(html)).toBe('application/octet-stream')
  })

  it('answers the opaque default for bytes too short to carry either magic', () => {
    expect(sniffEvidenceContentType(new Uint8Array([]))).toBe('application/octet-stream')
    expect(sniffEvidenceContentType(new Uint8Array([0x89, 0x50]))).toBe('application/octet-stream')
    expect(sniffEvidenceContentType(new Uint8Array([0xff, 0xd8]))).toBe('application/octet-stream')
  })

  it('requires the WHOLE PNG signature, not a prefix of it', () => {
    expect(sniffEvidenceContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x00]))).toBe('application/octet-stream')
    expect(sniffEvidenceContentType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
  })
})

describe('RunsArtifactInputSchema — the sha shape is the contract, not a route regex', () => {
  it('accepts a 64-char lowercase hex sha', () => {
    expect(RunsArtifactInputSchema.safeParse({ runId: RUN_ID, sha: SHA }).success).toBe(true)
  })

  it('refuses a short sha, an uppercase one, and a non-hex one', () => {
    expect(RunsArtifactInputSchema.safeParse({ runId: RUN_ID, sha: 'ABC' }).success).toBe(false)
    expect(RunsArtifactInputSchema.safeParse({ runId: RUN_ID, sha: 'A'.repeat(64) }).success).toBe(false)
    expect(RunsArtifactInputSchema.safeParse({ runId: RUN_ID, sha: 'z'.repeat(64) }).success).toBe(false)
    expect(RunsArtifactInputSchema.safeParse({ runId: RUN_ID, sha: `${SHA}0` }).success).toBe(false)
  })

  it('refuses a traversal-shaped sha before any path could be assembled', () => {
    expect(RunsArtifactInputSchema.safeParse({ runId: RUN_ID, sha: '../../etc/passwd' }).success).toBe(false)
  })

  it('is STRICT — an extra key is a refusal, not a field the op quietly ignores', () => {
    expect(RunsArtifactInputSchema.safeParse({ runId: RUN_ID, sha: SHA, path: '/etc/passwd' }).success)
      .toBe(false)
  })
})

describe('the spec is a member of this catalogue in good standing', () => {
  it('carries an id in the pinned taxonomy and declares itself read-only', () => {
    expect(runsArtifactSpec.id).toBe(RUNS_ARTIFACT_FUNCTION_ID)
    expect(runsArtifactSpec.id).toMatch(/^[a-z]+(?:\.[a-z]+)+$/)
    expect(runsArtifactSpec.risk.readOnly).toBe(true)
    expect(runsArtifactSpec).not.toHaveProperty('requiredScopes')
    expect(runsArtifactSpec.resultKind).toBe('unary')
    expect(runsArtifactSpec.boundThrough).toBe('evidenceBlobs')
  })

  it('classifies a served blob by its type and size, never by its bytes', () => {
    const verdict = runsArtifactSpec.classify(
      { runId: RUN_ID, sha: SHA, contentType: 'image/png', byteLength: 3, bytesBase64: 'AAAA' },
    )
    expect(verdict.status).toBe('executed')
    expect(verdict.outcome).toContain('image/png')
    expect(verdict.outcome).toContain('3 bytes')
    expect(verdict.outcome).toContain(RUN_ID)
    // The receipt line never quotes the payload: a base64 body in an audit row would be the blob
    // written a second time, into the one record that is kept forever.
    expect(verdict.outcome).not.toContain('AAAA')
  })
})
