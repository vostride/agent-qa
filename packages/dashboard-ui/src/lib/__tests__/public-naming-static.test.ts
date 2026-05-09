import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const demoConfig = readFileSync(
  new URL('../../../../../../demo-project/agent-qa.config.yaml', import.meta.url),
  'utf-8',
)
const sampleUploadFixture = readFileSync(
  new URL('../../../../../../demo-project/tests/fixtures/sample-upload.txt', import.meta.url),
  'utf-8',
)
const releaseUploadFixture = readFileSync(
  new URL('../../../../../../demo-project/release-action-pack/upload-fixture.txt', import.meta.url),
  'utf-8',
)
const releasePreflight = readFileSync(
  new URL('../../../../../../demo-project/scripts/release-action-preflight.mjs', import.meta.url),
  'utf-8',
)

describe('public naming static contract', () => {
  it('uses agent-qa in public demo fixture copy', () => {
    expect(demoConfig).toContain('# agent-qa Demo Project')
    expect(sampleUploadFixture.trim()).toBe('agent-qa file upload fixture')
    expect(releaseUploadFixture.trim()).toBe('agent-qa release file-upload fixture for Phase 213.')
    expect(releasePreflight).toContain('Run the agent-qa package build before release suite execution.')
  })
})
