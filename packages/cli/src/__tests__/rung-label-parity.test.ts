// THE ELEVEN CAUSE LABELS, HELD EQUAL ACROSS TWO DOORS (Phase 407 plan 11 · TRST-01 / TRST-02,
// D-15 / D-18; widened by 423 D-22).
//
// WHY THIS CELL EXISTS AT ALL. The retrieval rung is printed by two surfaces that share no module:
// `agent-qa doctor`'s three retrieval rows (407-08, `cli/src/commands/doctor-knowledge-checks.ts`)
// and the run header's degradation banner (407-10, `dashboard-ui/src/lib/knowledge-view.ts`).
// `packages/cli` cannot import a React package's lib — dashboard-ui ships a built app bundle, not
// a library entry, and every package pins `rootDir` to its own `src` so a cross-package relative
// import is a `tsc --noEmit` error. So the eight labels are spelled TWICE by necessity, and the
// only thing that can stop them drifting is a cell that reads both and refuses to let them differ.
// One wording, two doors: a label edited on either side reds HERE, naming the reason it moved.
//
// HOW THE DASHBOARD'S TABLE IS REACHED, AND WHY IT IS TEXT. `@vostride/agent-qa-dashboard-ui`
// declares no `exports`/`main` — its `dist` is a Vite app, not an importable module — so there is
// no `import()` of a built lib entry to prefer over this. The table is therefore read as SOURCE
// TEXT and its eight `'{key}': '{label}'` pairs extracted, on `adjudications.test.ts`'s precedent
// for reading a sibling package's source from `REPO_ROOT`. That is stated rather than implied
// because a future reader should not have to re-derive why an import was not used.
//
// THE FOURTH CELL IS A PROPERTY, NOT AN EXAMPLE. It folds EVERY index face against EVERY embedder
// outcome against both shipped profiles, drives the real `createKnowledgeChecks` with injected
// read-only probes, and requires every retrieval `warn` a degraded host produces to be spelled out of the
// table. A cell that checked one host's row would pass while seven of the eight labels were
// unreachable prose.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_EMBEDDING_PROFILE,
  RETRIEVAL_RUNG_REASONS,
  STATIC_FLOOR_EMBEDDING_PROFILE,
  type EmbeddingProfile,
} from '@vostride/agent-qa-schema'
import {
  LOCAL_KNOWLEDGE_PROBES,
  type AcquireEmbedderOutcome,
  type IndexFace,
  type ReadEmbedderWorkerRegistrationOutcome,
  type ReadWriterLeaseOutcome,
} from '@vostride/agent-qa-agent-local'
import { createFunctionRegistry, type FunctionDeps } from '@vostride/agent-qa-agent'
import { afterAll, describe, expect, it } from 'vitest'

import { RUNG_CAUSE_LABELS, createKnowledgeChecks } from '../commands/doctor-knowledge-checks.js'

const { foldRetrievalRung } = LOCAL_KNOWLEDGE_PROBES

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/cli/src/__tests__` → the agent-qa root. */
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const KNOWLEDGE_VIEW_PATH = join(REPO_ROOT, 'packages/dashboard-ui/src/lib/knowledge-view.ts')

/**
 * The dashboard's copy of the table, extracted from the module that publishes it.
 *
 * A PARSE THAT REFUSES RATHER THAN RETURNING NOTHING. An empty map would make cells 2 and 3 pass
 * vacuously the day the table is renamed or restyled, which is precisely the drift this file is
 * here to catch — so a table that cannot be found, or that yields no members, throws with a
 * sentence naming what moved.
 */
function dashboardCauseLabels(): Record<string, string> {
  const source = readFileSync(KNOWLEDGE_VIEW_PATH, 'utf8')
  const block = /export const RUNG_CAUSE_LABELS[^=]*=\s*\{([\s\S]*?)\n\}/u.exec(source)
  if (block === null) {
    throw new Error(
      'RUNG_CAUSE_LABELS is no longer an exported object literal in '
      + 'packages/dashboard-ui/src/lib/knowledge-view.ts — the parity cell cannot read the '
      + 'dashboard half of the table.',
    )
  }
  const table: Record<string, string> = {}
  for (const line of (block[1] as string).split('\n')) {
    const entry = /^\s*'([^']+)':\s*'([^']*)',?\s*$/u.exec(line)
    if (entry !== null) table[entry[1] as string] = entry[2] as string
  }
  if (Object.keys(table).length === 0) {
    throw new Error(
      'RUNG_CAUSE_LABELS in packages/dashboard-ui/src/lib/knowledge-view.ts carries no '
      + "single-quoted '{key}': '{label}' members — the extraction has gone blind.",
    )
  }
  return table
}

const DASHBOARD_CAUSE_LABELS = dashboardCauseLabels()

/** Every reason the recorded enum admits, sorted — the ONE denominator both tables answer to. */
const RECORDED_REASONS = [...RETRIEVAL_RUNG_REASONS].sort()

// ── The property cell's host matrix ──────────────────────────────────────────────────────────────

/**
 * Every index face the classifier can answer with.
 *
 * Both `filePresent` arms are present because they are two different doctor rows: a file that is
 * absent is a `warn` naming the scanning cause, and a file that is present and will not open is
 * the errored subsystem D-19 reserves `fail` for.
 */
const FACES: readonly { readonly label: string; readonly face: IndexFace }[] = [
  { label: 'index', face: { source: 'index' } },
  {
    label: 'scan/absent',
    face: { source: 'scan', reason: 'absent', detail: 'no index file', filePresent: false },
  },
  {
    label: 'scan/corrupt',
    face: { source: 'scan', reason: 'corrupt', detail: 'header mismatch', filePresent: true },
  },
  {
    label: 'scan/locked',
    face: { source: 'scan', reason: 'locked', detail: 'database is locked', filePresent: true },
  },
  {
    label: 'scan/schema-version',
    face: {
      source: 'scan',
      reason: 'schema-version',
      detail: 'user_version 3',
      filePresent: true,
    },
  },
]

/** A stand-in port: the fold reads `kind` and `rung`, never the embedder itself. */
const INERT_EMBEDDER = {
  embedDocument: async () => new Float32Array(0),
  embedQuery: async () => new Float32Array(0),
}

/** Every embedder outcome the acquirer can answer with. */
const EMBEDDERS: readonly { readonly label: string; readonly outcome: AcquireEmbedderOutcome }[] = [
  {
    label: 'ready/native',
    outcome: {
      kind: 'ready',
      rung: 'native',
      profile: DEFAULT_EMBEDDING_PROFILE,
      embedder: INERT_EMBEDDER,
    },
  },
  {
    label: 'ready/floor',
    outcome: {
      kind: 'ready',
      rung: 'floor',
      profile: STATIC_FLOOR_EMBEDDING_PROFILE,
      embedder: INERT_EMBEDDER,
    },
  },
  { label: 'deferred/cold-artifact', outcome: { kind: 'deferred', reason: 'cold-artifact' } },
  { label: 'deferred/load-failure', outcome: { kind: 'deferred', reason: 'load-failure' } },
  { label: 'deferred/worker-unavailable', outcome: { kind: 'deferred', reason: 'worker-unavailable' } },
  { label: 'lexical-only', outcome: { kind: 'lexical-only' } },
]

/** Both shipped profiles, because the `static-floor` rung names a different cause under each. */
const PROFILES: readonly { readonly label: string; readonly profile: EmbeddingProfile }[] = [
  { label: 'node', profile: DEFAULT_EMBEDDING_PROFILE },
  { label: 'static', profile: STATIC_FLOOR_EMBEDDING_PROFILE },
]

/** No daemon holds authority on this host, so the `Embedder` row reads its own probe's answer. */
const NO_LEASE: ReadWriterLeaseOutcome = { kind: 'absent' }
const NO_REGISTRATION: ReadEmbedderWorkerRegistrationOutcome = { kind: 'absent' }

const roots: string[] = []

/** A project whose config names a knowledge dir that is really on disk. */
function probedProject(): { config: Record<string, unknown>; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-qa-407-11-rung-parity-'))
  roots.push(root)
  mkdirSync(join(root, 'agent-qa-knowledge'), { recursive: true })
  return {
    config: { knowledge: { dir: 'agent-qa-knowledge' } },
    configPath: join(root, 'agent-qa.config.yaml'),
  }
}

interface RowOutcome {
  readonly name: string
  readonly status: string
  readonly message: string
}

/** Run doctor's three knowledge rows against ONE synthetic host. */
async function doctorRows(
  face: IndexFace,
  embedder: AcquireEmbedderOutcome,
  preferredProfile: EmbeddingProfile,
): Promise<readonly RowOutcome[]> {
  const project = probedProject()
  const checks = createKnowledgeChecks({
    config: project.config,
    configPath: project.configPath,
    preferredProfile,
    probes: {
      classifyIndexFace: () => face,
      // `allowDownload: false` is the caller's own hard-coded posture; the probe just answers.
      resolveEmbedderCapability: async () => embedder,
      readWriterLease: () => NO_LEASE,
      readEmbedderWorkerRegistration: () => NO_REGISTRATION,
      readDaemonEventLedger: () => ({ events: [] }),
    },
  })
  const rows: RowOutcome[] = []
  for (const check of checks) {
    const result = await check.check()
    rows.push({ name: check.name, status: result.status, message: result.message ?? '' })
  }
  return rows
}

describe('the retrieval-rung cause labels are one wording on two doors', () => {
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('the CLI table names exactly the recorded reasons, none missing and none invented', () => {
    expect(
      Object.keys(RUNG_CAUSE_LABELS).sort(),
      'doctor\'s `RUNG_CAUSE_LABELS` no longer keys exactly `RETRIEVAL_RUNG_REASONS`. It is typed '
      + '`Record<RetrievalRungReason, string>` so a MISSING key is a compile error; an EXTRA key '
      + 'that is not a recorded reason is dead prose nothing can ever print.',
    ).toEqual(RECORDED_REASONS)
    expect(
      Object.values(RUNG_CAUSE_LABELS).filter((label) => label.trim() === ''),
      'a blank cause label prints an em dash with nothing after it, which is worse than a shorter '
      + 'sentence.',
    ).toEqual([])
  })

  it('the dashboard table names exactly the same recorded reasons', () => {
    expect(
      Object.keys(DASHBOARD_CAUSE_LABELS).sort(),
      'the dashboard\'s `RUNG_CAUSE_LABELS` no longer keys exactly `RETRIEVAL_RUNG_REASONS`, so '
      + 'the banner has a reason it cannot name — or names one the recorder cannot produce.',
    ).toEqual(RECORDED_REASONS)
    expect(
      Object.values(DASHBOARD_CAUSE_LABELS).filter((label) => label.trim() === ''),
      'a blank cause label in the banner renders `Retrieval degraded: X — . Run `agent-qa '
      + 'doctor`.`',
    ).toEqual([])
  })

  it('every reason reads the same words on both doors, byte for byte', () => {
    const drifted = RECORDED_REASONS
      .filter((reason) => RUNG_CAUSE_LABELS[reason] !== DASHBOARD_CAUSE_LABELS[reason])
      .map((reason) => `${reason}: cli=${JSON.stringify(RUNG_CAUSE_LABELS[reason])} `
        + `dashboard=${JSON.stringify(DASHBOARD_CAUSE_LABELS[reason])}`)
    expect(
      drifted,
      'the two doors print different words for the same recorded cause. The tables are spelled '
      + 'twice by necessity (no shared module crosses the boundary) and this cell is the only '
      + 'thing holding them together — edit BOTH, or neither.',
    ).toEqual([])
  })

  it('every degraded retrieval doctor row spells its cause out of the table, over the whole host matrix', async () => {
    const labels = new Set(Object.values(RUNG_CAUSE_LABELS))
    const unspelled: string[] = []
    const rungRowDrift: string[] = []

    for (const { label: faceLabel, face } of FACES) {
      for (const { label: embedderLabel, outcome } of EMBEDDERS) {
        for (const { label: profileLabel, profile } of PROFILES) {
          const where = `${faceLabel} × ${embedderLabel} × ${profileLabel}`
          const rows = await doctorRows(face, outcome, profile)
          expect(rows.map(row => row.name)).toEqual([
            'Knowledge store', 'Embedder', 'Retrieval rung',
          ])

          for (const row of rows) {
            if (row.status !== 'warn') continue
            if (![...labels].some((candidate) => row.message.includes(candidate))) {
              unspelled.push(`${where} → ${row.name}: ${JSON.stringify(row.message)}`)
            }
          }

          // THE STRONG CLAIM, on the one row whose whole subject is the rung. D-19 forbids it from
          // ever being a `fail`, so a degraded host's rung row is a `warn` reading exactly
          // `{rung} — {label}` — the same two words the banner puts in its own sentence.
          const fold = foldRetrievalRung(face, outcome, profile)
          const rungRow = rows.find((row) => row.name === 'Retrieval rung')
          const expected = fold.rung === 'memidex'
            ? 'memidex'
            : `${fold.rung} — ${RUNG_CAUSE_LABELS[fold.reason ?? 'index-unavailable']}`
          if (rungRow?.message !== expected) {
            rungRowDrift.push(
              `${where} → expected ${JSON.stringify(expected)}, got ${JSON.stringify(rungRow?.message ?? null)}`,
            )
          }
          if (fold.rung !== 'memidex' && rungRow?.status !== 'warn') {
            rungRowDrift.push(
              `${where} → a degraded rung must never be a \`${rungRow?.status ?? '(no row)'}\`; `
              + 'D-19 reserves `fail` for an ERRORED subsystem, and a rung reached by design would '
              + 'red the CI gate of every deliberately-degraded install.',
            )
          }
        }
      }
    }

    expect(
      unspelled,
      'a retrieval doctor `warn` printed a cause that is in neither table. Every degraded retrieval row names its '
      + 'cause out of `RUNG_CAUSE_LABELS`, so an operator reads one wording wherever they look.',
    ).toEqual([])
    expect(
      rungRowDrift,
      'the `Retrieval rung` row disagrees with the fold it is a view of.',
    ).toEqual([])
  }, 30_000)
})

// ── 423 D-22 / D-23: distinct index causes, one historical word, and doctor as current health ──
// Plan 423-23 owns the mutation script; RUNG-LABEL-PARITY is its required named RED cell.

/** Hand-spelled, never derived from `RETRIEVAL_RUNG_REASONS`. */
const EXPECTED_REASONS = [
  'embedder-load-failed',
  'floor-disabled',
  'index-corrupt',
  'index-locked',
  'index-not-built',
  'index-unavailable',
  'model-not-downloaded',
  'native-runtime-unavailable',
  'profile-static-configured',
  'profile-unresolved',
]

/** The exact bytes both doors print for the four index words. */
const INDEX_LABELS = {
  'index-not-built': 'knowledge index not built yet, scanning bundles',
  'index-locked': 'knowledge index locked by another process, scanning bundles',
  'index-corrupt': 'knowledge index corrupt, rebuild requested, scanning bundles',
  'index-unavailable': 'knowledge index unavailable (cause not recorded), scanning bundles',
} as const

const LEGACY_LABEL = INDEX_LABELS['index-unavailable']

const CURRENT_INDEX_CAUSES = [
  { face: 'absent', reason: 'index-not-built' },
  { face: 'locked', reason: 'index-locked' },
  { face: 'corrupt', reason: 'index-corrupt' },
  { face: 'schema-version', reason: 'index-corrupt' },
] as const

const NATIVE = EMBEDDERS[0]!.outcome

describe('RUNG-LABEL-PARITY', () => {
  it('both doors key exactly the eleven hand-spelled reasons', () => {
    expect(Object.keys(RUNG_CAUSE_LABELS).sort()).toEqual(EXPECTED_REASONS)
    expect(Object.keys(DASHBOARD_CAUSE_LABELS).sort()).toEqual(EXPECTED_REASONS)
    expect(RECORDED_REASONS).toEqual(EXPECTED_REASONS)
  })

  it('pins each index cause to the same exact bytes on both doors', () => {
    for (const [reason, label] of Object.entries(INDEX_LABELS)) {
      expect(RUNG_CAUSE_LABELS[reason as keyof typeof INDEX_LABELS], `cli ${reason}`).toBe(label)
      expect(DASHBOARD_CAUSE_LABELS[reason], `dashboard ${reason}`).toBe(label)
    }
  })

  it('never presents not-built as corrupt, and keeps every cause label distinct', () => {
    const label = (reason: string) => String((RUNG_CAUSE_LABELS as Record<string, string>)[reason])
    expect(label('index-not-built')).toMatch(/not built/u)
    expect(label('index-not-built')).not.toMatch(/corrupt|rebuild/u)
    expect(label('index-locked')).not.toMatch(/corrupt|rebuild/u)
    expect(label('index-corrupt')).toMatch(/rebuild requested/u)
    expect(new Set(Object.values(RUNG_CAUSE_LABELS)).size).toBe(EXPECTED_REASONS.length)
  })
})

describe('LEGACY-LABEL', () => {
  it('reads the historical word as cause not recorded on both doors', () => {
    expect(RUNG_CAUSE_LABELS['index-unavailable']).toBe(LEGACY_LABEL)
    expect(DASHBOARD_CAUSE_LABELS['index-unavailable']).toBe(LEGACY_LABEL)
    expect(LEGACY_LABEL).toContain('cause not recorded')
  })

  it('never lends a current cause its wording', () => {
    for (const { reason } of CURRENT_INDEX_CAUSES) {
      const label = String((RUNG_CAUSE_LABELS as Record<string, string>)[reason])
      expect(label).toBe(INDEX_LABELS[reason])
      expect(label).not.toContain('cause not recorded')
    }
  })
})

describe('DOCTOR-CURRENT-SEPARATE', () => {
  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it.each(CURRENT_INDEX_CAUSES)('doctor names the live $face face as $reason, never the historical word', async ({ face, reason }) => {
    const indexFace = FACES.find((entry) => entry.label === `scan/${face}`)!.face
    const rows = await doctorRows(indexFace, NATIVE, DEFAULT_EMBEDDING_PROFILE)
    const store = rows.find((row) => row.name === 'Knowledge store')!
    const rung = rows.find((row) => row.name === 'Retrieval rung')!

    expect(rung).toEqual({
      name: 'Retrieval rung',
      status: 'warn',
      message: `bundle-scan — ${INDEX_LABELS[reason]}`,
    })
    for (const row of rows) expect(row.message).not.toContain(LEGACY_LABEL)
    if (face === 'absent') {
      expect(store.status).toBe('warn')
      expect(store.message).toContain(INDEX_LABELS['index-not-built'])
      expect(store.message).not.toMatch(/corrupt|could not be opened/u)
    } else {
      expect(store.status).toBe('fail')
      expect(store.message).toContain(`could not be opened: ${face}`)
    }
  })

  it('adds no current-health read op; current health stays on agent-qa doctor', () => {
    const registry = createFunctionRegistry({
      deps: {} as unknown as FunctionDeps,
      // no `resolveExecutionContext` registry option, and the listing
      // caller carries no `grantedScopes`/`safeMode`; the registry reads neither.
    })
    const ids = registry.list({
      surface: 'test',
      origin: 'human',
    }).map((entry) => entry.id)
    expect(ids.length).toBeGreaterThan(30)
    expect(ids).toContain('runs.knowledge')
    expect(ids.filter((id) => /health|doctor|rung/u.test(id))).toEqual([])
  })
})
