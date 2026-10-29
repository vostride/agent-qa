import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { generateRunId } from '@vostride/agent-qa-ids'
import { FsEvidenceArtifactStore, slugBranch } from '@vostride/agent-qa-runner-local'
import { asRunId, asRecordId, type CompletedRunHandoff } from '@vostride/agent-qa-schema'

const { makeLocalV2Handoff, LOCAL_FIXTURE_BLOB_BYTES } = await import(new URL('../../../../eval-local/src/__tests__/fixtures/local-handoff-fixture.js', import.meta.url).href)
const { createPromotionFloorFixture } = await import(new URL('../../../../knowledge-local/src/curator/__tests__/fixtures/promotion-floor-fixture.js', import.meta.url).href)
export const { loadBundle } = await import(new URL('../../../../knowledge-local/src/bundle-read.js', import.meta.url).href)
const { enumerateBundleDirs } = await import(new URL('../../../../knowledge-local/src/bundle-scan.js', import.meta.url).href)

export function markFixture() {
  const root = mkdtempSync(join(tmpdir(), '419-mark-host-'))
  const agentQaRoot = join(root, '.agent-qa')
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(configPath, 'workspace:\n  testMatch: [tests/**/*.yaml]\n  suiteMatch: [suites/**/*.suite.yaml]\n  hooksFile: hooks.yaml\n  envFile: .env\n  secretsFile: .env.secrets.local\nuse:\n  mobile:\n    appState: preserve\n')
  // A mark's fix wording masks with the declared secrets, so the workspace needs the file a run needs.
  writeFileSync(join(root, '.env.secrets.local'), '')
  const fixture = createPromotionFloorFixture({ knowledgeRoot })
  const { published } = fixture.publishHeldCandidate('marked')
  const handoff: CompletedRunHandoff = makeLocalV2Handoff({ runId: asRunId(generateRunId()) })
  const member = handoff.tests[0]!
  member.steps = [member.steps[0]!]
  member.outcome = 'failed'
  member.steps[0]!.verifierVerdict.pass = false
  member.steps[0]!.servedBrief.channel3 = [{ id: asRecordId(published.id), anchors: [], summary: 'Served checkout evidence' }]
  for (const sub of member.steps[0]!.subActions) sub.stateBefore = { ...sub.stateBefore, timestamp: 1_725_000_000 }
  const runDir = join(agentQaRoot, 'runs', slugBranch(handoff.runId))
  mkdirSync(runDir, { recursive: true })
  const save = () => writeFileSync(join(runDir, 'handoff.json'), JSON.stringify(handoff))
  save()
  new FsEvidenceArtifactStore({ root: agentQaRoot, runId: handoff.runId }).persistDecisionScreenshot(LOCAL_FIXTURE_BLOB_BYTES)
  const deps = { configPath, agentQaRoot, randomUuid: randomUUID }
  return { root, knowledgeRoot, configPath, agentQaRoot, runDir, handoff, published, save, deps }
}

export function files(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]).sort()
}

/** The project's file hashes outside `.agent-qa` and the knowledge root: what a mark leaves unchanged. */
export function projectOutsideStores(fixture: { root: string; agentQaRoot: string; knowledgeRoot: string }): string[][] {
  const within = (path: string, dir: string) => path.startsWith(`${dir}${sep}`)
  return files(fixture.root).filter(path => !within(path, fixture.agentQaRoot) && !within(path, fixture.knowledgeRoot))
    .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])
}


/** Every bundle in the store, loaded through the real guard. */
export function bundles(knowledgeRoot: string): { dir: string; id: string; bundle: any }[] {
  return (enumerateBundleDirs(knowledgeRoot) as { dir: string }[]).map(entry => {
    const loaded = loadBundle(entry.dir)
    if (loaded.kind !== 'loaded') throw new Error('bundle must load through the real guard')
    return { dir: entry.dir, id: loaded.bundle.manifest.id as string, bundle: loaded.bundle }
  })
}

// Committed knowledge bytes under `memory/`, without the re-projected index or lease bookkeeping.
export function canonicalKnowledge(knowledgeRoot: string): string[][] {
  const memory = join(knowledgeRoot, 'memory')
  return files(memory).filter(path => !path.startsWith(join(memory, 'index')))
    .map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])
}
