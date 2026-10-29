import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson } from '@vostride/agent-qa-schema'
import type { DistilledObservation } from '@vostride/agent-qa-schema'

import {
  publishBundle,
  type BundleStoreConfig,
  type PublishBundleInput,
  type PublishBundleOutcome,
} from '../../bundle-publish.test-helper.js'

export type PublishedObservationFixture = Extract<
  PublishBundleOutcome,
  { kind: 'published' }
>

export type ObservationFixtureLine = DistilledObservation | string

export function writeObservationLines(
  bundleDir: string,
  lines: readonly ObservationFixtureLine[],
): string {
  const observationPath = join(bundleDir, 'observations.jsonl')
  const text = lines
    .map((line) => typeof line === 'string' ? line : canonicalJson(line))
    .join('\n')
  writeFileSync(observationPath, text === '' ? '' : `${text}\n`, 'utf8')
  return observationPath
}

// Publishes through the real writer, then adds fixture-only evidence.
export function publishObservationFixture(
  config: BundleStoreConfig,
  input: PublishBundleInput,
  lines: readonly ObservationFixtureLine[],
): PublishedObservationFixture {
  const outcome = publishBundle(config, input)
  if (outcome.kind !== 'published') {
    throw new Error(`expected fixture publication, got ${outcome.kind}`)
  }
  writeObservationLines(outcome.dir, lines)
  return outcome
}
